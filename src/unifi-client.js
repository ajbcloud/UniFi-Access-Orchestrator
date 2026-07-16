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
 *   3.x  Assign PIN to User:       PUT  /users/:id/pin_codes (write-only; PINs are never readable)
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
const accessGating = require('./access-gating');

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

    // Access-policy caches (for keypad-PIN gating). Populated by
    // syncAccessPolicies() from GET /users?expand[]=access_policy. Until that
    // first succeeds, accessPolicyAvailable stays false and every gate fails
    // OPEN (no code is ever revoked on missing data).
    this.userDoorAccess = new Map();     // userId -> Set(doorId) allowed
    this.userAccessComplete = new Map(); // userId -> bool (false = fail open)
    this.accessPolicyAvailable = false;
    this.accessPolicySyncedAt = null;
    this.accessPolicyError = null;
    this._lastAccessSyncSummary = null;
    // Fired after each access-policy sync so the app can reconcile keypad codes
    // against a changed door-access model. The `changed` flag is content based
    // (see _accessPolicyHash) so a callback only signals a real access change,
    // not the 15-second config-sync tick that also refreshes this cache.
    this.onAccessPoliciesChanged = null;
    this._lastAccessHash = null;
    // Distinct signal for a failed /door_groups read (vs a healthy sync). When
    // set and any user grants access through a group, those users cannot be
    // gated and fail open, so the UI surfaces it instead of a silent debug log.
    this.doorGroupsError = null;
    this.accessPolicyGroupsReferenced = false;

    // WebSocket
    this.ws = null;
    this.wsReconnectTimer = null;
    this.wsPingInterval = null;
    this.lastWsInboundAt = 0; // ms epoch of the last inbound ws frame

    // Connection state tracking
    this.connectionState = 'disconnected';
    this.healthMonitorInterval = null;
    this._shutdownRequested = false;
    this._initRetryActive = false; // true while initializeWithRetry is looping

    // Sync interval
    this.syncInterval = null;
    this.syncMinutes = config.unifi.user_sync_interval_minutes || 5;

    // Last steady-state sync outcomes. The periodic syncs used to write six
    // info lines per cycle (every 15s with auto-sync on), drowning real
    // events; an unchanged outcome now logs at debug and only a CHANGE (or
    // the first run) is announced at info.
    this._lastDoorsSummary = null;
    this._lastGroupSyncSummary = null;

    // Config references
    this.groupNameMap = config.resolver?.unifi_group_to_group || {};
    this.selfTrigger = config.self_trigger_prevention || {};

    // HTTP agent for connection reuse
    this.agent = new https.Agent({
      rejectUnauthorized: this.verifySsl,
      keepAlive: true,
      keepAliveMsecs: 10000,
      maxSockets: 10,
      timeout: 15000
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
              const err = new Error(`API error: ${parsed.code} - ${parsed.msg}`);
              err.statusCode = res.statusCode;
              reject(err);
            }
          } catch (e) {
            const err = new Error(`Failed to parse response from ${method} ${path}: ${data.substring(0, 200)}`);
            err.statusCode = res.statusCode;
            reject(err);
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
      await this.syncAccessPolicies();
      this.startPeriodicSync();
      this.connectionState = 'connected';
      logger.info('UniFi Access client initialized successfully');
      return true;
    } catch (err) {
      logger.error(`Initialization failed: ${err.message}`);
      return false;
    }
  }

  async initializeWithRetry() {
    this._shutdownRequested = false;
    this._initRetryActive = true;
    this.connectionState = 'connecting';
    let attempt = 0;
    const backoffs = [5, 10, 20, 40, 60];

    try {
      while (!this._shutdownRequested) {
        const success = await this.initialize();
        if (success) {
          this.connectionState = 'connected';
          logger.info('UniFi client connected and ready');
          return true;
        }

        if (this._shutdownRequested) break;

        attempt++;
        const delaySec = backoffs[Math.min(attempt - 1, backoffs.length - 1)];
        this.connectionState = 'reconnecting';
        logger.warn(`Initialization attempt ${attempt} failed. Retrying in ${delaySec}s...`);
        await new Promise(r => setTimeout(r, delaySec * 1000));
      }

      logger.info('Retry loop cancelled (shutdown requested)');
      return false;
    } finally {
      this._initRetryActive = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Door discovery (Section 7.8: GET /doors)
  // ---------------------------------------------------------------------------

  async discoverDoors() {
    logger.debug('Discovering doors...');
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

    const summary = `Discovered ${this.doors.size} doors: ${[...this.doors.keys()].join(', ')}`;
    const changed = summary !== this._lastDoorsSummary;
    this._lastDoorsSummary = summary;
    logger[changed ? 'info' : 'debug'](summary);
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
      return { success: false, door: doorName, doorId, error: err.message, statusCode: err.statusCode || err.status || 0 };
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
  // Assign a keypad PIN to a UniFi Access user (PUT /users/:id/pin_codes).
  // Used by the deadbolt PIN manager when the operator chooses to overwrite
  // the user's UniFi PIN so the deadbolt keypad and UniFi readers match.
  // The API can only WRITE PINs; it never returns existing ones in plaintext
  // (GET exposes just a hash token), so there is no read counterpart.
  // Requires the API token to carry user-credential edit scope; a token
  // provisioned door/webhook-only (this app's documented minimum) gets a 403,
  // which is flagged as permission_denied so the UI can explain the fix.
  // The PIN itself is never logged.
  // ---------------------------------------------------------------------------
  async assignUserPin(userId, pin) {
    const name = this.userNames.get(userId) || userId;
    logger.info(`Setting UniFi PIN for user "${name}"`);
    try {
      await this.request('PUT', `/users/${userId}/pin_codes`, { pin_code: String(pin) });
      logger.info(`UniFi PIN updated for "${name}"`);
      return { success: true, userId };
    } catch (err) {
      const statusCode = err.statusCode || err.status || 0;
      const permissionDenied = statusCode === 403
        || /forbidden|permission|unauthorized/i.test(err.message || '');
      logger.error(`Failed to set UniFi PIN for "${name}": ${err.message}${statusCode ? ` (HTTP ${statusCode})` : ''}`);
      return { success: false, userId, error: err.message, statusCode, permission_denied: permissionDenied };
    }
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
    logger.debug('Syncing user groups...');

    try {
      // Step 1: Fetch all user groups
      const groupsResult = await this.request('GET', '/user_groups');
      const groups = Array.isArray(groupsResult.data) ? groupsResult.data : [];
      logger.debug(`Found ${groups.length} user groups`);

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

      // One line at info per CHANGE in outcome (membership, group list, or
      // unmapped set); the every-15s steady state stays at debug.
      const summary = `User group sync complete: ${this.userGroupMap.size} users mapped across ${groups.length} groups`
        + (unmappedGroups.length ? ` (unmapped: ${unmappedGroups.join(', ')})` : '');
      const changed = summary !== this._lastGroupSyncSummary;
      this._lastGroupSyncSummary = summary;
      if (unmappedGroups.length > 0) {
        logger[changed ? 'info' : 'debug'](`Unmapped groups (add to resolver.unifi_group_to_group in config): ${unmappedGroups.join(', ')}`);
      }
      logger[changed ? 'info' : 'debug'](summary);
    } catch (err) {
      logger.error(`User group sync failed: ${err.message}`);
      // Keep existing cache on failure
    }
  }

  // ---------------------------------------------------------------------------
  // Access policies (for keypad-PIN gating): which doors each user may open.
  //   GET /users?expand[]=access_policy  -> user.access_policies[].resources[]
  //     resource = { type: 'door' | 'door_group', id }
  //   GET /door_groups                   -> expand door_group resources
  //
  // Builds userDoorAccess (userId -> Set(doorId)) and userAccessComplete
  // (userId -> bool). A user is marked INCOMPLETE when a policy references a
  // resource we cannot resolve to concrete door ids (an unknown door group or
  // an unrecognized resource type); the gate treats incomplete users as
  // 'unknown' and never revokes their codes. On any failure the previous
  // cache is kept and accessPolicyAvailable is left as-is (false until the
  // first success), so a transient error never flips a user to "denied".
  // ---------------------------------------------------------------------------

  // Best-effort door-group -> door-id membership. UniFi exposes door groups at
  // GET /door_groups; the member door ids live under a `resources`/`doors`
  // array depending on controller version, so we read whichever is present.
  // Returns Map(groupId -> Set(doorId)); empty on any failure (callers then
  // treat door_group resources as unexpandable => users fail open).
  async fetchDoorGroups() {
    const map = new Map();
    try {
      const result = await this.request('GET', '/door_groups');
      const groups = Array.isArray(result.data) ? result.data : [];
      for (const g of groups) {
        if (!g || !g.id) continue;
        const doors = new Set();
        const members = Array.isArray(g.resources) ? g.resources
          : Array.isArray(g.doors) ? g.doors : [];
        for (const m of members) {
          const id = (m && (m.id || m.door_id)) || (typeof m === 'string' ? m : null);
          if (id) doors.add(String(id));
        }
        map.set(String(g.id), doors);
      }
      this.doorGroupsError = null; // a successful read (even zero groups) clears the flag
    } catch (err) {
      this.doorGroupsError = err.message;
      logger.debug(`Door-group fetch failed (${err.message}); door_group access resources will be treated as unexpandable`);
    }
    return map;
  }

  async syncAccessPolicies() {
    logger.debug('Syncing access policies...');
    try {
      const doorGroups = await this.fetchDoorGroups();
      const users = await this.requestAllPages('/users?expand[]=access_policy');
      const { allowedDoorsByUser, completeByUser, groupsReferenced } = accessGating.parseAccessPolicies(users, doorGroups);
      this.accessPolicyGroupsReferenced = !!groupsReferenced;

      // Atomic swap on success.
      this.userDoorAccess = allowedDoorsByUser;
      this.userAccessComplete = completeByUser;
      this.accessPolicyAvailable = true;
      this.accessPolicySyncedAt = new Date().toISOString();
      this.accessPolicyError = null;

      let incomplete = 0;
      for (const complete of completeByUser.values()) if (!complete) incomplete++;
      const summary = `Access policy sync complete: ${allowedDoorsByUser.size} users`
        + (incomplete ? `, ${incomplete} with unresolved resources (those users are not gated)` : '');
      const changed = summary !== this._lastAccessSyncSummary;
      this._lastAccessSyncSummary = summary;
      logger[changed ? 'info' : 'debug'](summary);

      // Signal a reconcile only when a user's allowed-door set or completeness
      // actually shifted, so the frequent config-sync refresh does not schedule
      // a reconcile on every tick.
      const hash = this._accessPolicyHash();
      const contentChanged = hash !== this._lastAccessHash;
      this._lastAccessHash = hash;
      if (typeof this.onAccessPoliciesChanged === 'function') {
        try {
          this.onAccessPoliciesChanged({ reason: 'access_policies_synced', changed: contentChanged });
        } catch (e) {
          logger.debug(`onAccessPoliciesChanged handler failed: ${e.message}`);
        }
      }
    } catch (err) {
      // Keep the prior cache; never flip anyone to denied on a transient error.
      this.accessPolicyError = err.message;
      logger.warn(`Access policy sync failed (${err.message}); keypad gating uses the last good data${this.accessPolicyAvailable ? '' : ' (none yet: gating is not enforced)'}`);
    }
  }

  // Content fingerprint of the access model: each user's sorted allowed-door
  // set plus completeness. Used to decide whether a sync actually changed
  // anything worth reconciling.
  _accessPolicyHash() {
    const parts = [];
    const entries = [...this.userDoorAccess.entries()]
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    for (const [uid, set] of entries) {
      const doors = [...set].sort().join(',');
      parts.push(`${uid}=${doors}:${this.userAccessComplete.get(uid) ? 1 : 0}`);
    }
    return parts.join('|');
  }

  // Status snapshot for diagnostics/health.
  accessPolicyStatus() {
    let incomplete = 0;
    for (const complete of this.userAccessComplete.values()) if (!complete) incomplete++;
    return {
      available: this.accessPolicyAvailable,
      synced_at: this.accessPolicySyncedAt,
      users: this.userDoorAccess.size,
      incomplete_users: incomplete,
      error: this.accessPolicyError,
      door_groups_error: this.doorGroupsError,
      groups_referenced: this.accessPolicyGroupsReferenced,
    };
  }

  startPeriodicSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }
    const ms = this.syncMinutes * 60 * 1000;
    this.syncInterval = setInterval(() => {
      this.syncUserGroups();
      this.syncAccessPolicies();
    }, ms);
    logger.info(`Periodic user group sync started: every ${this.syncMinutes} minutes`);
  }

  startHealthMonitor(onStateChange = null) {
    if (this.healthMonitorInterval) clearInterval(this.healthMonitorInterval);

    this.healthMonitorInterval = setInterval(async () => {
      // Skip only while the init retry loop is actively working the problem.
      // The old guard skipped whenever the STATE was reconnecting/connecting,
      // but the monitor itself is the only thing that restores 'connected'
      // after a transient blip, so one failed probe locked the state on
      // 'reconnecting' forever (banner stuck on Reconnecting while everything
      // actually worked).
      if (this._initRetryActive) return;

      try {
        await this.request('GET', '/doors?page_num=1&page_size=1');

        if (this.connectionState !== 'connected') {
          this.connectionState = 'connected';
          logger.info('Health monitor: connectivity restored');
          await this.discoverDoors();
          await this.syncUserGroups();
          await this.syncAccessPolicies();
          if (onStateChange) onStateChange('connected');
        }
      } catch (err) {
        if (this.connectionState === 'connected') {
          this.connectionState = 'reconnecting';
          logger.warn(`Health monitor: connectivity lost (${err.message})`);
          if (onStateChange) onStateChange('reconnecting');
        }
      }
    }, 30000);

    logger.info('Health monitor started (30s interval)');
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
    // No controller configured yet (fresh install waiting on the setup
    // wizard). new WebSocket('wss://:12445/...') throws synchronously, and on
    // startup that escaped as a fatal that killed the whole server. Skip
    // quietly; the connection is re-attempted after the config gets a host.
    if (!this.host || String(this.host).trim() === '') {
      logger.warn('WebSocket event source: no controller host configured yet; waiting for setup to complete');
      return;
    }
    const wsUrl = `wss://${this.host}:${this.port}/api/v1/developer/devices/notifications`;
    logger.info(`Connecting WebSocket: ${wsUrl}`);

    if (!this.wsStats) {
      this.wsStats = { passed: 0, filtered: 0, lastFilteredType: null };
    }

    const WS_EVENT_WHITELIST = new Set([
      'access.logs.add',
      'access.door.unlock',
      'access.doorbell.completed',
      'access.doorbell.incoming',
      'access.remote_view',
      'access.door.lock',
      'access.door.close',
      'access.notifications'
    ]);

    const wsOptions = {
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Upgrade': 'websocket',
        'Connection': 'Upgrade'
      },
      rejectUnauthorized: this.verifySsl
    };

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN ||
          this.ws.readyState === WebSocket.CONNECTING ||
          this.ws.readyState === WebSocket.CLOSING) {
        this.ws.terminate();
      }
    }

    try {
      this.ws = new WebSocket(wsUrl, wsOptions);
    } catch (err) {
      // A malformed host makes the constructor throw synchronously. Never let
      // that escape to the fatal handler; retry once the config is corrected.
      logger.error(`WebSocket connect failed (${err.message}); retrying in ${reconnectSeconds}s`);
      this.ws = null;
      setTimeout(() => this.connectWebSocket(onEvent, reconnectSeconds), reconnectSeconds * 1000).unref();
      return;
    }

    this.ws.on('open', () => {
      logger.info('WebSocket connected');
      if (this.wsPingInterval) clearInterval(this.wsPingInterval);
      // Liveness = ANY inbound frame (message, ping, or pong). The old check
      // required a pong reply to OUR ping within one 30s tick, but some
      // controllers never answer client pings while happily pinging us and
      // delivering events, so a healthy but quiet connection (zero doors) was
      // terminated every 60 seconds in an endless drop/reconnect loop.
      this.lastWsInboundAt = Date.now();
      this.wsPingInterval = setInterval(() => {
        const silentMs = Date.now() - this.lastWsInboundAt;
        if (silentMs > 90000) {
          logger.warn(`WebSocket heartbeat timeout — nothing received for ${Math.round(silentMs / 1000)}s; terminating stale connection`);
          this.ws.terminate();
          return;
        }
        try { this.ws.ping(); } catch (e) { /* socket mid-close */ }
      }, 30000);
    });

    this.ws.on('pong', () => { this.lastWsInboundAt = Date.now(); });
    // The controller pings us; ws answers with a pong automatically, and the
    // ping itself is proof of a live peer.
    this.ws.on('ping', () => { this.lastWsInboundAt = Date.now(); });

    this.ws.on('message', (data) => {
      this.lastWsInboundAt = Date.now();
      try {
        const event = JSON.parse(data.toString());
        const eventType = event.event || event.type || '';

        // Raw tap: sees EVERY parsed event before the whitelist, so observers
        // (event capture, and the deadbolt controller's lock-on-secured signal
        // that rides access.data.v2.location.update) get full-fidelity data
        // without widening the engine's whitelist. Null by default; never throws.
        if (this._rawTap) {
          try { this._rawTap(event); } catch (e) { /* observer must not break ingestion */ }
        }

        if (WS_EVENT_WHITELIST.has(eventType)) {
          this.wsStats.passed++;
          onEvent(event);
        } else {
          this.wsStats.filtered++;
          this.wsStats.lastFilteredType = eventType || 'unknown';
          logger.debug(`WebSocket filtered: ${eventType || 'unknown'}`);
        }
      } catch (err) {
        logger.warn(`Failed to parse WebSocket message: ${err.message}`);
      }
    });

    this.ws.on('close', (code, reason) => {
      if (this.wsPingInterval) { clearInterval(this.wsPingInterval); this.wsPingInterval = null; }
      logger.warn(`WebSocket closed: code=${code} reason=${reason}`);
      this.scheduleReconnect(onEvent, reconnectSeconds);
    });

    this.ws.on('error', (err) => {
      if (this.wsPingInterval) { clearInterval(this.wsPingInterval); this.wsPingInterval = null; }
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

  // Register a passive observer that receives every parsed WebSocket event
  // before whitelisting. Used by event capture and the deadbolt controller.
  setRawTap(fn) {
    this._rawTap = typeof fn === 'function' ? fn : null;
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
      websocket_connected: this.ws?.readyState === WebSocket.OPEN,
      connection_state: this.connectionState,
      ws_events_passed: this.wsStats?.passed || 0,
      ws_events_filtered: this.wsStats?.filtered || 0,
      ws_last_filtered_type: this.wsStats?.lastFilteredType || null
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
    this._shutdownRequested = true;
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    if (this.healthMonitorInterval) {
      clearInterval(this.healthMonitorInterval);
      this.healthMonitorInterval = null;
    }
    if (this.wsPingInterval) {
      clearInterval(this.wsPingInterval);
      this.wsPingInterval = null;
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
    this.connectionState = 'disconnected';
    logger.info('UniFi client shut down');
  }
}

module.exports = UniFiClient;
