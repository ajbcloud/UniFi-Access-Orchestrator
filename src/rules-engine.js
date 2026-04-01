/**
 * Rules Engine
 * 
 * Processes incoming events and triggers door unlocks based on configured rules.
 * 
 * Two main flows:
 * 
 * 1. NFC/PIN/Face Tap (access.door.unlock):
 *    - User authenticates at Main Entrance
 *    - Look up user's group from actor.id
 *    - Unlock additional doors per unlock_rules.group_actions
 *    - Example: Royal Palm employee taps -> unlock Elevator
 *      (they already have Tenant Space via their 1st Floor Access policy)
 * 
 * 2. Doorbell Answer (access.doorbell.completed, reason_code 107):
 *    - Visitor presses doorbell, staff member answers and grants access
 *    - Identify WHO answered using two strategies:
 *      a) Actor-based: if the event includes actor data, look up the
 *         answering admin's group. This works when staff answers from
 *         the mobile app or web portal.
 *      b) Device-based fallback: if actor is null (common in doorbell
 *         events per API reference), check which device was involved
 *         and map it to a group via doorbell_rules.viewer_to_group.
 *         e.g. "Royal Palm Concierge Viewer" -> royal_palm group
 *    - Unlock doors based on the answering staff's group, so visitors
 *      follow the same access path as the company they're visiting.
 * 
 * Self-trigger prevention:
 *    Every PUT /doors/:id/unlock call includes { extra: { source: "middleware" } }.
 *    If an incoming event contains this marker, skip it.
 */

const logger = require('./logger');

class RulesEngine {
  constructor(config, unifiClient, resolver) {
    this.config = config;
    this.unifiClient = unifiClient;
    this.resolver = resolver;

    // NFC/tap rules - normalize to array format
    this.unlockRules = config.unlock_rules || {};
    this.defaultAction = this.unlockRules.default_action || {};
    this.accessRules = this._normalizeRules(this.unlockRules);

    // Doorbell rules - normalize to array format
    this.doorbellRules = config.doorbell_rules || {};
    this.doorbellDefault = this.doorbellRules.default_action || {};
    // Build case-insensitive viewer_to_group lookup
    const rawViewerMap = this.doorbellRules.viewer_to_group || {};
    this.viewerToGroup = {};
    this._viewerToGroupCI = {};
    for (const [key, val] of Object.entries(rawViewerMap)) {
      this.viewerToGroup[key] = val;
      this._viewerToGroupCI[key.trim().toLowerCase()] = val;
    }
    this.visitorRules = this._normalizeRules(this.doorbellRules);

    // Self-trigger prevention
    this.selfTrigger = config.self_trigger_prevention || {};

    // Stats
    this.stats = {
      events_received: 0,
      events_filtered: 0,
      events_processed: 0,
      events_skipped_self: 0,
      events_skipped_location: 0,
      events_skipped_no_action: 0,
      unlocks_triggered: 0,
      unlocks_failed: 0,
      doorbell_events: 0,
      last_event: null,
      last_unlock: null,
      last_processing: null,
      started_at: new Date().toISOString()
    };
  }

  // ---------------------------------------------------------------------------
  // Main event handler
  // ---------------------------------------------------------------------------

  async handleEvent(rawPayload) {
    this.stats.events_received++;

    const event = this.normalizeEvent(rawPayload);
    if (!event) {
      this.stats.events_filtered++;
      logger.debug('Ignoring unrecognized event payload');
      return false;
    }

    this.stats.last_event = {
      type: event.type,
      location: event.locationName,
      actor: this.normalizeSentinel(event.actorName) || this.normalizeSentinel(event.actorId) || 'unknown',
      device: event.deviceName,
      time: new Date().toISOString()
    };

    logger.info(`Event: type=${event.type}, location="${event.locationName}", actor="${event.actorName || event.actorId || 'none'}", device="${event.deviceName || 'none'}"`);

    switch (event.type) {
      case 'access.door.unlock':
        await this.handleDoorUnlock(event);
        break;

      case 'access.doorbell.completed':
        await this.handleDoorbellCompleted(event);
        break;

      case 'access.doorbell.incoming':
        logger.info(`Doorbell ring at "${event.locationName}" (logged, no action)`);
        this.stats.doorbell_events++;
        break;

      // WebSocket wraps door unlocks in access.logs.add
      case 'access.logs.add':
        await this.handleWebSocketLog(event);
        break;

      default:
        logger.debug(`Unhandled event type: ${event.type}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Normalize events from different sources
  // ---------------------------------------------------------------------------

  normalizeSentinel(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed === '' || trimmed.toUpperCase() === 'N/A' || trimmed.toUpperCase() === 'NA' || trimmed === '-') {
        return null;
      }
      return trimmed;
    }
    return value;
  }

  normalizeEvent(raw) {
    const rawType = raw.event || raw.type || raw.event_type || '';
    if (rawType.startsWith('data.') || rawType.startsWith('data.v2.')) {
      logger.debug(`Ignoring device telemetry event: ${rawType}`);
      return null;
    }

    // API webhook / direct format (section 11.7)
    if (raw.event && raw.data) {
      return {
        type: raw.event,
        eventObjectId: raw.event_object_id,
        locationId: raw.data.location?.id,
        locationName: raw.data.location?.name,
        locationType: raw.data.location?.location_type,
        deviceName: raw.data.device?.name || raw.data.device?.alias,
        deviceType: raw.data.device?.device_type,
        deviceId: raw.data.device?.id,
        actorId: this.normalizeSentinel(raw.data.actor?.id) || null,
        actorName: this.normalizeSentinel(raw.data.actor?.name) || null,
        actorType: this.normalizeSentinel(raw.data.actor?.type) || null,
        authType: raw.data.object?.authentication_type,
        policyId: raw.data.object?.policy_id,
        policyName: raw.data.object?.policy_name,
        result: raw.data.object?.result,
        readerId: raw.data.object?.reader_id,
        reasonCode: raw.data.object?.reason_code,
        requestId: raw.data.object?.request_id,
        hostDeviceMac: raw.data.object?.host_device_mac,
        extra: raw.data.object?.extra || raw.data.extra || null,
        // Keep the nested _source for WebSocket access.logs.add events
        _source: raw.data._source || null,
        raw
      };
    }

    // Alarm Manager format (wraps in { alarm: ... } envelope)
    if (raw.alarm) {
      let alarmActorId = null;
      let alarmActorName = null;
      const triggers = raw.alarm.triggers || [];
      for (const trigger of triggers) {
        if (!alarmActorId) alarmActorId = this.normalizeSentinel(trigger.actor?.id || trigger.user_id || trigger.actor_id);
        if (!alarmActorName) alarmActorName = this.normalizeSentinel(trigger.actor?.name || trigger.actor?.display_name || trigger.user_name || trigger.actor_name);
        if (alarmActorId && alarmActorName) break;
      }
      if (!alarmActorId) alarmActorId = this.normalizeSentinel(raw.alarm.actor?.id || raw.alarm.user_id);
      if (!alarmActorName) alarmActorName = this.normalizeSentinel(raw.alarm.actor?.name || raw.alarm.actor?.display_name || raw.alarm.user_name);

      return {
        type: this.inferAlarmType(raw),
        eventObjectId: null,
        locationName: raw.alarm.name || 'unknown',
        deviceName: null,
        deviceType: null,
        deviceId: raw.alarm.sources?.[0]?.device || null,
        actorId: alarmActorId || null,
        actorName: alarmActorName || null,
        authType: null,
        reasonCode: null,
        extra: null,
        triggers,
        raw
      };
    }

    // Fallback: try to extract what we can
    if (raw.type || raw.event_type) {
      return {
        type: raw.type || raw.event_type,
        eventObjectId: raw.event_object_id || raw.id,
        locationId: raw.location?.id || raw.door_id,
        locationName: raw.location?.name || raw.door_name || raw.location_name,
        deviceName: raw.device?.name || raw.device_name,
        deviceType: raw.device?.device_type || raw.device_type,
        deviceId: raw.device?.id,
        actorId: this.normalizeSentinel(raw.actor?.id || raw.user_id) || null,
        actorName: this.normalizeSentinel(raw.actor?.name || raw.user_name || raw.actor_name) || null,
        authType: raw.authentication_type || raw.auth_type,
        reasonCode: raw.reason_code,
        extra: raw.extra,
        raw
      };
    }

    return null;
  }

  // Infer event type from Alarm Manager trigger keys
  inferAlarmType(raw) {
    const triggers = raw.alarm?.triggers || [];
    for (const t of triggers) {
      const key = (t.key || '').toLowerCase();
      if (key.includes('unlock') || key.includes('door')) return 'access.door.unlock';
      if (key.includes('doorbell') || key.includes('ring')) return 'access.doorbell.incoming';
    }
    return 'alarm_manager.unknown';
  }

  // ---------------------------------------------------------------------------
  // WebSocket access.logs.add handler
  // WebSocket wraps door unlock events inside access.logs.add with nested
  // _source containing the actual event data.
  // ---------------------------------------------------------------------------

  async handleWebSocketLog(event) {
    const source = event._source;
    if (!source) {
      logger.debug('WebSocket access.logs.add event has no _source, skipping');
      return;
    }

    const innerType = source.event?.type;
    if (!innerType) {
      logger.debug('WebSocket _source has no event.type, skipping');
      return;
    }

    // Re-normalize the inner event into our standard format
    const normalized = {
      type: innerType,
      locationName: null,
      deviceName: null,
      deviceId: null,
      actorId: this.normalizeSentinel(source.actor?.id || source.actor?.user_id || source.user_id) || null,
      actorName: this.normalizeSentinel(source.actor?.display_name || source.actor?.name || source.actor?.full_name || source.user_name) || null,
      actorType: this.normalizeSentinel(source.actor?.type) || null,
      authType: source.event?.authentication_type || source.authentication_type || null,
      result: source.event?.result,
      reasonCode: source.event?.reason_code,
      extra: source.extra || null,
      raw: event.raw
    };

    // Extract door name and device info from target array
    if (source.target && Array.isArray(source.target)) {
      const doorTarget = source.target.find(t => t.type === 'door');
      if (doorTarget) {
        normalized.locationName = doorTarget.display_name || doorTarget.name;
        normalized.locationId = doorTarget.id;
      }
      const deviceTarget = source.target.find(t => t.type === 'device');
      if (deviceTarget) {
        normalized.deviceName = deviceTarget.display_name || deviceTarget.name;
        normalized.deviceId = deviceTarget.id;
      }
      // Check for actor-type targets (viewer devices sometimes appear here)
      if (!normalized.actorName) {
        const userTarget = source.target.find(t => t.type === 'viewer' || t.type === 'user' || t.type === 'admin');
        if (userTarget) {
          normalized.actorName = this.normalizeSentinel(userTarget.display_name || userTarget.name) || null;
          if (!normalized.actorId) normalized.actorId = userTarget.id || null;
        }
      }
    }

    logger.info(`WebSocket log unwrapped: ${innerType} at "${normalized.locationName}", actor="${normalized.actorName || normalized.actorId || 'none'}" (actorId=${normalized.actorId || 'null'}, device="${normalized.deviceName || 'none'}")`);

    if (!normalized.actorId && !normalized.actorName) {
      const sourceKeys = Object.keys(source);
      const actorSnippet = JSON.stringify(source.actor || null).substring(0, 200);
      const targetSnippet = source.target ? JSON.stringify(source.target).substring(0, 300) : 'null';
      logger.debug(`WebSocket event missing actor data. source keys: [${sourceKeys.join(',')}], actor: ${actorSnippet}, target: ${targetSnippet}`);
    }

    // Update last_event so SSE broadcast picks up correct info
    this.stats.last_event = {
      type: innerType,
      location: normalized.locationName,
      actor: this.normalizeSentinel(normalized.actorName) || this.normalizeSentinel(normalized.actorId) || 'unknown',
      device: normalized.deviceName,
      time: new Date().toISOString()
    };

    // Route the unwrapped event
    switch (innerType) {
      case 'access.door.unlock':
        await this.handleDoorUnlock(normalized);
        break;
      case 'access.doorbell.completed':
        await this.handleDoorbellCompleted(normalized);
        break;
      default:
        logger.debug(`WebSocket unwrapped unhandled type: ${innerType}`);
    }
  }

  // ---------------------------------------------------------------------------
  // NFC/PIN/Face tap handler (access.door.unlock)
  // ---------------------------------------------------------------------------

  async handleDoorUnlock(event) {
    // Self-trigger check
    if (this.isSelfTriggered(event)) {
      logger.debug(`Skipping self-triggered unlock at "${event.locationName}"`);
      this.stats.events_skipped_self++;
      this.stats.last_processing = { action: 'skipped_self', actorName: event.actorName, location: event.locationName };
      return;
    }

    // Resolve user group
    let { group, strategy, userName } = this.resolver.resolve(
      event.actorId,
      { policy_id: event.policyId, policy_name: event.policyName }
    );

    let displayName = this.normalizeSentinel(userName) || this.normalizeSentinel(event.actorName) || this.normalizeSentinel(event.actorId) || 'unknown';

    if (displayName === 'unknown') {
      const rawSnippet = event.raw ? JSON.stringify({
        actor: event.raw.data?.actor || event.raw.actor || undefined,
        device: event.raw.data?.device || event.raw.device || undefined,
        user_id: event.raw.user_id || event.raw.data?.user_id || undefined,
        user_name: event.raw.user_name || event.raw.data?.user_name || undefined,
        _source_actor: event.raw.data?._source?.actor || undefined,
        _source_keys: event.raw.data?._source ? Object.keys(event.raw.data._source) : undefined,
        _keys: Object.keys(event.raw)
      }).substring(0, 500) : 'null';
      logger.debug(`Actor resolved to unknown. Raw payload snippet: ${rawSnippet}`);
    }

    // Fallback: check if actor or device is a mapped viewer (doorbell/intercom flow)
    if (!group && Object.keys(this._viewerToGroupCI).length > 0) {
      const actorNorm = this.normalizeSentinel(event.actorName);
      const deviceNorm = this.normalizeSentinel(event.deviceName);
      const viewerGroup = (typeof actorNorm === 'string' && this._viewerToGroupCI[actorNorm.toLowerCase()])
        || (typeof deviceNorm === 'string' && this._viewerToGroupCI[deviceNorm.toLowerCase()])
        || null;
      if (viewerGroup) {
        group = viewerGroup;
        strategy = 'viewer_to_group';
        displayName = actorNorm || deviceNorm;
        logger.info(`Viewer fallback: "${displayName}" mapped to group "${group}" via viewer_to_group`);
      }
    }

    if (!group) {
      logger.info(`User "${displayName}" (actorId: ${event.actorId || 'null'}) at "${event.locationName}": no group resolved`);
      this.stats.events_skipped_no_action++;
      this.stats.last_processing = {
        action: 'no_group',
        actorId: event.actorId,
        actorName: displayName,
        location: event.locationName,
        detail: `No group resolved for ${displayName}` + (event.actorId ? '' : ' (no actor ID in event)')
      };
      return;
    }

    // Find matching rules: match group AND trigger location
    const matchingRules = this.accessRules.filter(rule =>
      rule.group === group && this.locationMatches(event.locationName, rule.trigger)
    );

    // Collect all doors to unlock from matching rules
    let doorsToUnlock = [];
    let ruleWithDelay = null;
    
    if (matchingRules.length > 0) {
      for (const rule of matchingRules) {
        doorsToUnlock.push(...(rule.unlock || []));
        if (rule.delay > 0) ruleWithDelay = rule;
      }
      doorsToUnlock = [...new Set(doorsToUnlock)];
    } else if (this.defaultAction.unlock?.length > 0) {
      doorsToUnlock = this.defaultAction.unlock;
    }

    if (doorsToUnlock.length === 0) {
      logger.info(`User "${displayName}" (group: ${group}) at "${event.locationName}". No matching rules.`);
      this.stats.events_skipped_no_action++;
      this.stats.last_processing = {
        action: 'no_rules',
        actorName: displayName,
        resolvedGroup: group,
        resolveStrategy: strategy,
        location: event.locationName,
        detail: `No rules for group "${group}" at "${event.locationName}"`
      };
      return;
    }

    logger.info(`User "${displayName}" -> group "${group}" (via ${strategy}) at "${event.locationName}" -> unlocking: ${doorsToUnlock.join(', ')}`);

    const reason = `NFC/tap: ${displayName} (${group || 'default'}) at ${event.locationName}`;
    
    // Apply delay if specified in any matching rule
    const delay = ruleWithDelay ? ruleWithDelay.delay : 0;
    if (delay > 0) {
      logger.info(`Delaying unlock by ${delay}s for "${displayName}"`);
      this.stats.last_processing = {
        action: 'delayed',
        actorName: displayName,
        resolvedGroup: group,
        resolveStrategy: strategy,
        location: event.locationName,
        doorsAttempted: doorsToUnlock,
        delay,
        detail: `Unlocking in ${delay}s: ${doorsToUnlock.join(', ')}`
      };
      setTimeout(async () => {
        const unlocked = await this.executeUnlocks(doorsToUnlock, reason);
        if (this.broadcaster) {
          this.broadcaster({
            type: event.type,
            actor: displayName,
            location: event.locationName,
            action: unlocked.length > 0 ? `Unlocked: ${unlocked.join(', ')}` : `Unlock failed: ${doorsToUnlock.join(', ')}`,
            success: unlocked.length > 0
          });
        }
      }, delay * 1000);
    } else {
      const unlocked = await this.executeUnlocks(doorsToUnlock, reason);
      this.stats.last_processing = {
        action: unlocked.length > 0 ? 'unlocked' : 'unlock_failed',
        actorName: displayName,
        resolvedGroup: group,
        resolveStrategy: strategy,
        location: event.locationName,
        doorsAttempted: doorsToUnlock,
        doorsUnlocked: unlocked,
        detail: unlocked.length > 0 ? `Unlocked: ${unlocked.join(', ')}` : `Unlock failed for: ${doorsToUnlock.join(', ')}`
      };
    }
    this.stats.events_processed++;
  }

  // ---------------------------------------------------------------------------
  // Doorbell completed handler
  //
  // Dual resolution strategy:
  //   1. Actor-based: if actor.id is present, look up the answering
  //      admin's group. Works for mobile app / web portal answers.
  //   2. Device-based fallback: if actor is null, check the device name
  //      against viewer_to_group mapping. Works for viewer answers.
  // ---------------------------------------------------------------------------

  async handleDoorbellCompleted(event) {
    this.stats.doorbell_events++;

    // Only act on reason_code 107 (admin unlocked the door)
    const triggerCode = this.doorbellRules.trigger_reason_code || 107;
    if (event.reasonCode !== triggerCode) {
      const desc = this.describeReasonCode(event.reasonCode);
      logger.info(`Doorbell completed at "${event.locationName}": reason_code=${event.reasonCode} (expected ${triggerCode}), ${desc} — skipping`);
      logger.debug(`Doorbell event details: actor="${event.actorName || 'null'}", actorId=${event.actorId || 'null'}, device="${event.deviceName || 'null'}"`);
      this.stats.last_processing = {
        action: 'doorbell_wrong_reason',
        location: event.locationName,
        detail: `Doorbell: reason_code=${event.reasonCode} (expected ${triggerCode}), ${desc}`
      };
      return;
    }

    // Strategy 1: Resolve from actor (the admin who answered)
    let group = null;
    let resolveMethod = null;

    if (event.actorId) {
      const resolved = this.resolver.resolve(event.actorId);
      if (resolved.group) {
        group = resolved.group;
        resolveMethod = `actor: ${resolved.userName || event.actorName || event.actorId} (${resolved.strategy})`;
      }
    }

    // Strategy 2: Fallback to device name (viewer that answered) — case-insensitive
    if (!group && typeof event.deviceName === 'string' && event.deviceName) {
      group = this._viewerToGroupCI[event.deviceName.trim().toLowerCase()] || null;
      if (group) {
        resolveMethod = `device: ${event.deviceName}`;
      }
    }

    // Strategy 3: Check host_device_mac or other device identifiers
    if (!group && event.hostDeviceMac) {
      logger.debug(`Doorbell answered by device MAC ${event.hostDeviceMac} but no mapping found`);
    }

    if (!group) {
      logger.info(`Doorbell answered at "${event.locationName}" but no group resolved (actorId=${event.actorId || 'null'}, device=${event.deviceName || 'null'})`);
      this.stats.events_skipped_no_action++;
      this.stats.last_processing = {
        action: 'no_group',
        actorId: event.actorId,
        actorName: event.actorName,
        deviceName: event.deviceName,
        location: event.locationName,
        detail: `Doorbell: no group resolved` + (event.actorId ? '' : ' (no actor ID)') + (event.deviceName ? `, device "${event.deviceName}" not mapped` : '')
      };
      return;
    }

    // Find matching rules: match group AND trigger location
    const matchingRules = this.visitorRules.filter(rule =>
      rule.group === group && this.locationMatches(event.locationName, rule.trigger)
    );

    let doorsToUnlock = [];
    let ruleWithDelay = null;

    if (matchingRules.length > 0) {
      for (const rule of matchingRules) {
        doorsToUnlock.push(...(rule.unlock || []));
        if (rule.delay > 0) ruleWithDelay = rule;
      }
      doorsToUnlock = [...new Set(doorsToUnlock)];
      logger.info(`Doorbell answered -> group "${group}" (via ${resolveMethod}) at "${event.locationName}" -> unlocking: ${doorsToUnlock.join(', ')}`);
    } else if (this.doorbellDefault.unlock?.length > 0) {
      doorsToUnlock = this.doorbellDefault.unlock;
      logger.info(`Doorbell answered -> could not determine matching rule -> default -> unlocking: ${doorsToUnlock.join(', ')}`);
    } else {
      logger.warn('Doorbell answered but no matching rule and no default action configured');
    }

    if (doorsToUnlock.length === 0) {
      this.stats.events_skipped_no_action++;
      this.stats.last_processing = {
        action: 'no_rules',
        actorName: resolveMethod,
        resolvedGroup: group,
        location: event.locationName,
        detail: `Doorbell: no rules for group "${group}" at "${event.locationName}"`
      };
      return;
    }

    const reason = `Doorbell: answered by ${resolveMethod || 'unknown'} at ${event.locationName}`;
    
    // Apply delay if specified in the rule
    const delay = ruleWithDelay ? ruleWithDelay.delay : 0;
    if (delay > 0) {
      logger.info(`Delaying doorbell unlock by ${delay}s`);
      this.stats.last_processing = {
        action: 'delayed',
        actorName: resolveMethod,
        resolvedGroup: group,
        location: event.locationName,
        doorsAttempted: doorsToUnlock,
        delay,
        detail: `Doorbell: unlocking in ${delay}s: ${doorsToUnlock.join(', ')}`
      };
      setTimeout(async () => {
        const unlocked = await this.executeUnlocks(doorsToUnlock, reason);
        if (this.broadcaster) {
          this.broadcaster({
            type: event.type,
            actor: resolveMethod || 'unknown',
            location: event.locationName,
            action: unlocked.length > 0 ? `Unlocked: ${unlocked.join(', ')}` : `Unlock failed: ${doorsToUnlock.join(', ')}`,
            success: unlocked.length > 0
          });
        }
      }, delay * 1000);
    } else {
      const unlocked = await this.executeUnlocks(doorsToUnlock, reason);
      this.stats.last_processing = {
        action: unlocked.length > 0 ? 'unlocked' : 'unlock_failed',
        actorName: resolveMethod,
        resolvedGroup: group,
        location: event.locationName,
        doorsAttempted: doorsToUnlock,
        doorsUnlocked: unlocked,
        detail: unlocked.length > 0 ? `Unlocked: ${unlocked.join(', ')}` : `Unlock failed for: ${doorsToUnlock.join(', ')}`
      };
    }
    this.stats.events_processed++;
  }

  // ---------------------------------------------------------------------------
  // Execute unlock commands
  // ---------------------------------------------------------------------------

  async executeUnlocks(doorNames, reason) {
    const successfulDoors = [];
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 2000;

    for (const name of doorNames) {
      let success = false;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const result = await this.unifiClient.unlockDoorByName(name, reason);
          if (result.success) {
            this.stats.unlocks_triggered++;
            successfulDoors.push(result.door);
            this.stats.last_unlock = {
              door: result.door,
              doors: [...successfulDoors],
              reason,
              time: new Date().toISOString()
            };
            success = true;
            break;
          }
          const errCode = result.statusCode || 0;
          if (errCode === 401 || errCode === 403) {
            logger.error(`Unlock "${name}" failed: auth error (${errCode}), skipping retries`);
            break;
          }
          logger.warn(`Unlock "${name}" attempt ${attempt}/${MAX_RETRIES} failed: ${result.error}`);
        } catch (err) {
          logger.warn(`Unlock "${name}" attempt ${attempt}/${MAX_RETRIES} error: ${err.message}`);
        }

        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
      }

      if (!success) {
        this.stats.unlocks_failed++;
        logger.error(`Unlock "${name}" failed after ${MAX_RETRIES} attempts`);
      }
    }

    if (successfulDoors.length > 1 && this.stats.last_unlock) {
      this.stats.last_unlock.door = successfulDoors.join(', ');
    }

    return successfulDoors;
  }

  setBroadcaster(fn) {
    this.broadcaster = fn;
  }

  // ---------------------------------------------------------------------------
  // Self-trigger prevention
  // ---------------------------------------------------------------------------

  isSelfTriggered(event) {
    if (!this.selfTrigger.marker_key || !this.selfTrigger.marker_value) return false;
    const key = this.selfTrigger.marker_key;
    const val = this.selfTrigger.marker_value;
    const extra = event.extra;
    if (extra && typeof extra === 'object' && extra[key] === val) return true;
    // Check alternate paths for WebSocket-unwrapped events
    const rawExtra = event.raw?.data?.object?.extra || event.raw?.data?.extra;
    if (rawExtra && typeof rawExtra === 'object' && rawExtra[key] === val) return true;
    const sourceExtra = event.raw?.data?._source?.extra;
    if (sourceExtra && typeof sourceExtra === 'object' && sourceExtra[key] === val) return true;
    return false;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _normalizeRules(rulesConfig) {
    if (Array.isArray(rulesConfig.rules)) {
      return rulesConfig.rules;
    }
    const rules = [];
    const trigger = rulesConfig.trigger_location || '';
    const groupActions = rulesConfig.group_actions || {};
    for (const [group, action] of Object.entries(groupActions)) {
      const doors = action?.unlock || [];
      if (doors.length > 0) {
        rules.push({ group, trigger, unlock: doors });
      }
    }
    return rules;
  }

  locationMatches(eventLocation, configLocation) {
    if (!eventLocation || !configLocation) return false;
    return eventLocation.trim().toLowerCase() === configLocation.trim().toLowerCase();
  }

  describeReasonCode(code) {
    const codes = {
      105: 'Doorbell timed out',
      106: 'Admin declined unlock',
      107: 'Admin unlocked door',
      108: 'Visitor canceled',
      400: 'Answered by another admin'
    };
    return codes[code] || `reason_code=${code}`;
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = RulesEngine;
