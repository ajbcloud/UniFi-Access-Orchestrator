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
    this.viewerToGroup = this.doorbellRules.viewer_to_group || {};
    this.doorbellDefault = this.doorbellRules.default_action || {};
    this.visitorRules = this._normalizeRules(this.doorbellRules);

    // Self-trigger prevention
    this.selfTrigger = config.self_trigger_prevention || {};

    // Stats
    this.stats = {
      events_received: 0,
      events_processed: 0,
      events_skipped_self: 0,
      events_skipped_location: 0,
      events_skipped_no_action: 0,
      unlocks_triggered: 0,
      unlocks_failed: 0,
      doorbell_events: 0,
      last_event: null,
      last_unlock: null,
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
      logger.debug('Ignoring unrecognized event payload');
      return;
    }

    this.stats.last_event = {
      type: event.type,
      location: event.locationName,
      actor: event.actorName || event.actorId || 'unknown',
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

  normalizeEvent(raw) {
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
        actorId: raw.data.actor?.id || null,
        actorName: raw.data.actor?.name || null,
        actorType: raw.data.actor?.type || null,
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
      return {
        type: this.inferAlarmType(raw),
        eventObjectId: null,
        locationName: raw.alarm.name || 'unknown',
        deviceName: null,
        deviceType: null,
        deviceId: raw.alarm.sources?.[0]?.device || null,
        actorId: null,
        actorName: null,
        authType: null,
        reasonCode: null,
        extra: null,
        triggers: raw.alarm.triggers || [],
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
        actorId: raw.actor?.id || raw.user_id,
        actorName: raw.actor?.name || raw.user_name || raw.actor_name,
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
    if (!source) return;

    const innerType = source.event?.type;
    if (!innerType) return;

    // Re-normalize the inner event into our standard format
    const normalized = {
      type: innerType,
      locationName: null,
      deviceName: null,
      actorId: null,
      actorName: source.actor?.display_name || null,
      result: source.event?.result,
      extra: null,
      raw: event.raw
    };

    // Extract door name from target array
    if (source.target && Array.isArray(source.target)) {
      const doorTarget = source.target.find(t => t.type === 'door');
      if (doorTarget) {
        normalized.locationName = doorTarget.display_name;
      }
    }

    logger.debug(`WebSocket log unwrapped: ${innerType} at "${normalized.locationName}"`);

    // Route the unwrapped event
    switch (innerType) {
      case 'access.door.unlock':
        await this.handleDoorUnlock(normalized);
        break;
      case 'access.doorbell.completed':
        await this.handleDoorbellCompleted(normalized);
        break;
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
      return;
    }

    // Resolve user group
    const { group, strategy, userName } = this.resolver.resolve(
      event.actorId,
      { policy_id: event.policyId, policy_name: event.policyName }
    );

    const displayName = userName || event.actorName || event.actorId || 'unknown';

    // Find matching rules: match group AND trigger location
    const matchingRules = this.accessRules.filter(rule =>
      rule.group === group && this.locationMatches(event.locationName, rule.trigger)
    );

    // Collect all doors to unlock from matching rules
    let doorsToUnlock = [];
    if (matchingRules.length > 0) {
      for (const rule of matchingRules) {
        doorsToUnlock.push(...(rule.unlock || []));
      }
      doorsToUnlock = [...new Set(doorsToUnlock)];
    } else if (this.defaultAction.unlock?.length > 0) {
      doorsToUnlock = this.defaultAction.unlock;
    }

    if (doorsToUnlock.length === 0) {
      logger.info(`User "${displayName}" (group: ${group || 'unknown'}) at "${event.locationName}". No matching rules.`);
      this.stats.events_skipped_no_action++;
      return;
    }

    logger.info(`User "${displayName}" -> group "${group}" (via ${strategy}) at "${event.locationName}" -> unlocking: ${doorsToUnlock.join(', ')}`);

    const reason = `NFC/tap: ${displayName} (${group || 'default'}) at ${event.locationName}`;
    
    // Apply delay if specified in the rule
    const delay = matchingRules[0]?.delay || 0;
    if (delay > 0) {
      logger.info(`Delaying unlock by ${delay}s for "${displayName}"`);
      setTimeout(async () => {
        await this.executeUnlocks(doorsToUnlock, reason);
      }, delay * 1000);
    } else {
      await this.executeUnlocks(doorsToUnlock, reason);
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
      logger.info(`Doorbell completed at "${event.locationName}": ${desc} (no action)`);
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

    // Strategy 2: Fallback to device name (viewer that answered)
    if (!group && event.deviceName) {
      group = this.viewerToGroup[event.deviceName] || null;
      if (group) {
        resolveMethod = `device: ${event.deviceName}`;
      }
    }

    // Strategy 3: Check host_device_mac or other device identifiers
    if (!group && event.hostDeviceMac) {
      logger.debug(`Doorbell answered by device MAC ${event.hostDeviceMac} but no mapping found`);
    }

    // Find matching rules: match group AND trigger location
    const matchingRules = this.visitorRules.filter(rule =>
      rule.group === group && this.locationMatches(event.locationName, rule.trigger)
    );

    let doorsToUnlock = [];
    if (matchingRules.length > 0) {
      for (const rule of matchingRules) {
        doorsToUnlock.push(...(rule.unlock || []));
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
      return;
    }

    const reason = `Doorbell: answered by ${resolveMethod || 'unknown'} at ${event.locationName}`;
    
    // Apply delay if specified in the rule
    const delay = matchingRules[0]?.delay || 0;
    if (delay > 0) {
      logger.info(`Delaying doorbell unlock by ${delay}s`);
      setTimeout(async () => {
        await this.executeUnlocks(doorsToUnlock, reason);
      }, delay * 1000);
    } else {
      await this.executeUnlocks(doorsToUnlock, reason);
    }
    this.stats.events_processed++;
  }

  // ---------------------------------------------------------------------------
  // Execute unlock commands
  // ---------------------------------------------------------------------------

  async executeUnlocks(doorNames, reason) {
    const results = await Promise.allSettled(
      doorNames.map(name => this.unifiClient.unlockDoorByName(name, reason))
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.success) {
        this.stats.unlocks_triggered++;
        this.stats.last_unlock = {
          door: result.value.door,
          reason,
          time: new Date().toISOString()
        };
      } else {
        this.stats.unlocks_failed++;
        const err = result.status === 'rejected' ? result.reason?.message : result.value?.error;
        logger.error(`Unlock failed: ${err}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Self-trigger prevention
  // ---------------------------------------------------------------------------

  isSelfTriggered(event) {
    if (!this.selfTrigger.marker_key || !this.selfTrigger.marker_value) return false;
    const extra = event.extra;
    if (!extra || typeof extra !== 'object') return false;
    return extra[this.selfTrigger.marker_key] === this.selfTrigger.marker_value;
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
