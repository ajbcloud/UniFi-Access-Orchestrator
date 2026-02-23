/**
 * UniFi Access API Client
 * 
 * Based on official UniFi Access API Reference PDF.
 * All endpoints use base URL: https://{host}:{port}/api/v1/developer/
 * Authentication: Bearer token in Authorization header.
 * 
 * Key API sections referenced:
 *   7.8  Fetch All Doors:          GET  /doors
 *   7.9  Remote Door Unlocking:    PUT  /doors/:id/unlock
 *   7.10 Temporary Door Lock Rule: PUT  /doors/:id/lock_rule (fw 1.24.6+)
 *   3.5  Fetch All Users:          GET  /users?expand[]=access_policy
 *   3.12 Fetch All User Groups:    GET  /user_groups
 *   3.18 Fetch Users in Group:     GET  /user_groups/:id/users
 *   3.19 Fetch All Users in Group: GET  /user_groups/:id/users/all
 *   11.3 Fetch Webhook Endpoints:  GET  /webhooks/endpoints
 *   11.4 Add Webhook Endpoints:    POST /webhooks/endpoints
 *   11.1 WebSocket Notifications:  WSS  /devices/notifications
 */

const https = require('https');
const WebSocket = require('ws');
const logger = require('./logger');

class UniFiClient {
  constructor(config) {
    this.host = config.unifi.host;
    this.port = config.unifi.port;
    this.token = config.unifi.token;
    this.verifySsl = config.unifi.verify_ssl;
    this.baseUrl = `https://${this.host}:${this.port}/api/v1/developer`;

    // Caches
    this.doors = new Map();          // doorName -> doorId
    this.doorsById = new Map();      // doorId -> doorName
    this.userGroupMap = new Map();   // userId -> groupName (logical)
    this.userNames = new Map();      // userId -> fullName
    this.discoveredGroups = [];      // UniFi group names found during sync
    this.userData = new Map();       // userId -> {name, unifiGroupName, logicalGroupName}

    // WebSocket
    this.ws = null;
    this.wsReconnectTimer = null;

    // Sync interval
    this.syncInterval = null;
    this.syncMinutes = config.unifi.user_sync_interval_minutes || 5;

    // Config references
    this.groupNameMap = config.resolver?.unifi_group_to_group || {};
    this.selfTrigger = config.self_trigger_prevention || {};

    // HTTP agent for connection reuse
    this.agent = new https.Agent({
      rejectUnauthorized: this.verifySsl,
      keepAlive: true
    });
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  async request(method, path, body = null) {
    const url = `${this.baseUrl}${path}`;
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      agent: this.agent
    };

    return new Promise((resolve, reject) => {
      const req = https.request(url, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.code === 'SUCCESS') {
              resolve(parsed);
            } else {
              reject(new Error(`API error: ${parsed.code} - ${parsed.msg}`));
            }
          } catch (e) {
            reject(new Error(`Failed to parse response from ${method} ${path}: ${data.substring(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy(new Error(`Request timeout: ${method} ${path}`));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  // Paginated GET helper. UniFi uses page_num + page_size.
  async requestAllPages(path, pageSize = 25) {
    const allItems = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const separator = path.includes('?') ? '&' : '?';
      const pagedPath = `${path}${separator}page_num=${page}&page_size=${pageSize}`;
      const result = await this.request('GET', pagedPath);

      const items = Array.isArray(result.data) ? result.data : [];
      allItems.push(...items);

      // If we got fewer than pageSize, we've reached the end
      hasMore = items.length >= pageSize;
      page++;

      // Safety: cap at 100 pages
      if (page > 100) {
        logger.warn(`Pagination safety cap reached on ${path}`);
        break;
      }
    }

    return allItems;
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  async initialize() {
    logger.info('Initializing UniFi Access client...');

    try {
      await this.discoverDoors();
      await this.syncUserGroups();
      this.startPeriodicSync();
      logger.info('UniFi Access client initialized successfully');
      return true;
    } catch (err) {
      logger.error(`Initialization failed: ${err.message}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Door discovery (Section 7.8: GET /doors)
  // ---------------------------------------------------------------------------

  async discoverDoors() {
    logger.info('Discovering doors...');
    const result = await this.request('GET', '/doors');
    const doors = Array.isArray(result.data) ? result.data : [];

    this.doors.clear();
    this.doorsById.clear();

    for (const door of doors) {
      // API returns: id, name, full_name, type, door_lock_relay_status,
      //              door_position_status, floor_id, is_bind_hub
      const name = door.name || door.full_name;
      const id = door.id;

      if (name && id) {
        this.doors.set(name, id);
        this.doorsById.set(id, name);
        logger.debug(`Door discovered: "${name}" -> ${id}`);
      }
    }

    logger.info(`Discovered ${this.doors.size} doors: ${[...this.doors.keys()].join(', ')}`);
    return this.doors;
  }

  // ---------------------------------------------------------------------------
  // Remote door unlock (Section 7.9: PUT /doors/:id/unlock)
  //
  // Supports optional body fields:
  //   actor_id   - Custom actor ID for system logs/webhooks
  //   actor_name - Custom actor name (required if actor_id provided, and vice versa)
  //   extra      - Passthrough object, echoed as-is in webhook notifications
  //
  // The extra field is key for self-trigger prevention: we include a marker
  // so the middleware can detect and skip its own unlock events.
  // ---------------------------------------------------------------------------

  async unlockDoor(doorId, reason = 'middleware') {
    const doorName = this.doorsById.get(doorId) || doorId;
    logger.info(`Unlocking door: "${doorName}" (${doorId}) - reason: ${reason}`);

    const body = {
      extra: {}
    };

    // Self-trigger prevention marker
    if (this.selfTrigger.marker_key && this.selfTrigger.marker_value) {
      body.extra[this.selfTrigger.marker_key] = this.selfTrigger.marker_value;
    }

    // Include middleware as actor so it shows in UniFi system logs
    body.actor_id = 'unifi-access-orchestrator';
    body.actor_name = 'Access Orchestrator';
    body.extra.reason = reason;
    body.extra.timestamp = new Date().toISOString();

    try {
      await this.request('PUT', `/doors/${doorId}/unlock`, body);
      logger.info(`Door unlocked successfully: "${doorName}"`);
      return { success: true, door: doorName, doorId };
    } catch (err) {
      logger.error(`Failed to unlock door "${doorName}": ${err.message}`);
      return { success: false, door: doorName, doorId, error: err.message };
    }
  }

  // Unlock by friendly name
  async unlockDoorByName(doorName, reason = 'middleware') {
    const doorId = this.doors.get(doorName);
    if (!doorId) {
      logger.error(`Door not found: "${doorName}". Known doors: ${[...this.doors.keys()].join(', ')}`);
      return { success: false, door: doorName, error: 'Door ID not found in config or discovery' };
    }
    return this.unlockDoor(doorId, reason);
  }

  // ---------------------------------------------------------------------------
  // Temporary door lock rule (Section 7.10: PUT /doors/:id/lock_rule)
  // Requires firmware 1.24.6+
  //
  // Types: keep_lock, keep_unlock, custom (with interval), reset,
  //        lock_early, lock_now
  //
  // Not used for normal unlock flow, but available for schedule overrides
  // or the GUI admin panel.
  // ---------------------------------------------------------------------------

  async setDoorLockRule(doorId, type, intervalMinutes = null) {
    const doorName = this.doorsById.get(doorId) || doorId;
    const body = { type };
    if (type === 'custom' && intervalMinutes) {
      body.interval = intervalMinutes;
    }

    logger.info(`Setting lock rule on "${doorName}": type=${type}${intervalMinutes ? `, interval=${intervalMinutes}min` : ''}`);

    try {
      await this.request('PUT', `/doors/${doorId}/lock_rule`, body);
      logger.info(`Lock rule set successfully on "${doorName}"`);
      return { success: true, door: doorName, type };
    } catch (err) {
      logger.error(`Failed to set lock rule on "${doorName}": ${err.message}`);
      return { success: false, door: doorName, error: err.message };
    }
  }

  // ---------------------------------------------------------------------------
  // User group sync
  //
  // Strategy: Fetch all user groups, then for each group fetch its members.
  // Build a reverse map: userId -> logical group name.
  //
  // API endpoints used:
  //   3.12 GET /user_groups           - list all groups (returns id, name)
  //   3.19 GET /user_groups/:id/users/all - all users in group including subgroups
  //
  // The user object does NOT contain a group_id field. Group membership is
  // only accessible through the user_groups endpoints.
  // ---------------------------------------------------------------------------

  async syncUserGroups() {
    logger.info('Syncing user groups...');

    try {
      // Step 1: Fetch all user groups
      const groupsResult = await this.request('GET', '/user_groups');
      const groups = Array.isArray(groupsResult.data) ? groupsResult.data : [];
      logger.info(`Found ${groups.length} user groups`);

      const newUserGroupMap = new Map();
      const newUserNames = new Map();
      const newUserData = new Map();
      const unmappedGroups = [];
      const discoveredGroups = [];

      // Step 2: For each group, fetch its members
      for (const group of groups) {
        const unifiGroupName = group.name || group.full_name;
        const logicalGroup = this.groupNameMap[unifiGroupName];

        discoveredGroups.push(unifiGroupName);

        if (!logicalGroup) {
          unmappedGroups.push(unifiGroupName);
        }

        // Use the logical group name if mapped, otherwise use the raw UniFi group name
        const groupLabel = logicalGroup || unifiGroupName;

        logger.debug(`Fetching members of "${unifiGroupName}" -> "${groupLabel}"${logicalGroup ? '' : ' (unmapped)'}`);

        try {
          // Use /users/all to include subgroup members
          const usersResult = await this.request('GET', `/user_groups/${group.id}/users/all`);
          const users = Array.isArray(usersResult.data) ? usersResult.data : [];

          for (const user of users) {
            if (user.status === 'ACTIVE' && user.id) {
              newUserGroupMap.set(user.id, groupLabel);
              const displayName = user.full_name || `${user.first_name || ''} ${user.last_name || ''}`.trim();
              if (displayName) {
                newUserNames.set(user.id, displayName);
              }
              // Store complete user info for config UI
              newUserData.set(user.id, {
                name: displayName || 'Unknown',
                unifiGroupName: unifiGroupName,
                logicalGroupName: groupLabel
              });
            }
          }

          logger.debug(`  "${unifiGroupName}": ${users.length} members`);
        } catch (err) {
          logger.warn(`Failed to fetch members of group "${unifiGroupName}": ${err.message}`);
        }
      }

      // Swap caches atomically
      this.userGroupMap = newUserGroupMap;
      this.userNames = newUserNames;
      this.userData = newUserData;
      this.discoveredGroups = discoveredGroups;

      if (unmappedGroups.length > 0) {
        logger.info(`Unmapped groups (add to resolver.unifi_group_to_group in config): ${unmappedGroups.join(', ')}`);
      }

      logger.info(`User group sync complete: ${this.userGroupMap.size} users mapped across ${groups.length} groups`);
    } catch (err) {
      logger.error(`User group sync failed: ${err.message}`);
      // Keep existing cache on failure
    }
  }

  startPeriodicSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }
    const ms = this.syncMinutes * 60 * 1000;
    this.syncInterval = setInterval(() => this.syncUserGroups(), ms);
    logger.info(`Periodic user group sync started: every ${this.syncMinutes} minutes`);
  }

  // ---------------------------------------------------------------------------
  // Group lookup
  // ---------------------------------------------------------------------------

  getGroupForUser(userId) {
    return this.userGroupMap.get(userId) || null;
  }

  getUserName(userId) {
    return this.userNames.get(userId) || null;
  }

  // ---------------------------------------------------------------------------
  // API webhook registration (Section 11.4: POST /webhooks/endpoints)
  // Requires firmware 2.2.10+
  //
  // Registers the middleware's endpoint URL with UniFi Access so it pushes
  // events directly, instead of relying on Alarm Manager.
  // ---------------------------------------------------------------------------

  async registerWebhookEndpoint(endpointConfig) {
    logger.info('Registering API webhook endpoint...');

    // Check for existing registration first
    try {
      const existing = await this.request('GET', '/webhooks/endpoints');
      const endpoints = Array.isArray(existing.data) ? existing.data : [];
      const ours = endpoints.find(ep => ep.name === endpointConfig.endpoint_name);

      if (ours) {
        logger.info(`Webhook endpoint already registered: ${ours.endpoint} (id: ${ours.id})`);
        return { success: true, id: ours.id, existing: true };
      }
    } catch (err) {
      logger.warn(`Could not check existing webhooks: ${err.message}`);
    }

    // Register new endpoint
    const body = {
      endpoint: endpointConfig.endpoint_url,
      name: endpointConfig.endpoint_name,
      events: endpointConfig.events
    };

    try {
      const result = await this.request('POST', '/webhooks/endpoints', body);
      logger.info(`Webhook endpoint registered: ${endpointConfig.endpoint_url}`);
      return { success: true, data: result.data, existing: false };
    } catch (err) {
      logger.error(`Webhook registration failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket connection (Section 11.1)
  // Connects to wss://host:port/api/v1/developer/devices/notifications
  // Receives all real-time events as JSON messages.
  // ---------------------------------------------------------------------------

  connectWebSocket(onEvent, reconnectSeconds = 5) {
    const wsUrl = `wss://${this.host}:${this.port}/api/v1/developer/devices/notifications`;
    logger.info(`Connecting WebSocket: ${wsUrl}`);

    const wsOptions = {
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Upgrade': 'websocket',
        'Connection': 'Upgrade'
      },
      rejectUnauthorized: this.verifySsl
    };

    this.ws = new WebSocket(wsUrl, wsOptions);

    this.ws.on('open', () => {
      logger.info('WebSocket connected');
    });

    this.ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        onEvent(event);
      } catch (err) {
        logger.warn(`Failed to parse WebSocket message: ${err.message}`);
      }
    });

    this.ws.on('close', (code, reason) => {
      logger.warn(`WebSocket closed: code=${code} reason=${reason}`);
      this.scheduleReconnect(onEvent, reconnectSeconds);
    });

    this.ws.on('error', (err) => {
      logger.error(`WebSocket error: ${err.message}`);
    });
  }

  scheduleReconnect(onEvent, seconds) {
    if (this.wsReconnectTimer) return;
    logger.info(`WebSocket reconnecting in ${seconds}s...`);
    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null;
      this.connectWebSocket(onEvent, seconds);
    }, seconds * 1000);
  }

  // ---------------------------------------------------------------------------
  // Health / diagnostics
  // ---------------------------------------------------------------------------

  getStatus() {
    return {
      host: this.host,
      port: this.port,
      doors_discovered: this.doors.size,
      doors: Object.fromEntries(this.doors),
      users_mapped: this.userGroupMap.size,
      websocket_connected: this.ws?.readyState === WebSocket.OPEN
    };
  }

  // Get all discovered group names (for config UI)
  getDiscoveredGroups() {
    return this.discoveredGroups;
  }

  // Get user list with both UniFi and logical group names (for config UI)
  getDiscoveredUsers() {
    const users = [];
    for (const [userId, userInfo] of this.userData) {
      users.push({
        id: userId,
        ...userInfo
      });
    }
    return users;
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  shutdown() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.agent) {
      this.agent.destroy();
    }
    logger.info('UniFi client shut down');
  }
}

module.exports = UniFiClient;
