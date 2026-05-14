/**
 * UniFi Access Orchestrator
 * 
 * Express server with admin GUI dashboard.
 * 
 * API Endpoints:
 *   POST /webhook              - Receives events (Alarm Manager or API webhook)
 *   GET  /health               - Service health + stats
 *   POST /test/unlock/:door    - Manual test unlock
 *   POST /test/event           - Simulate an event through the rules engine
 *   POST /reload               - Reload config without restart
 *   GET  /api/config           - Current running config (sanitized)
 *   PUT  /api/config           - Save config changes
 *   GET  /api/doors            - Discovered doors
 *   GET  /api/users            - Cached user-to-group map
 *   POST /api/sync             - Force user group re-sync
 *   GET  /api/events/stream    - SSE stream for live event feed
 *   GET  /api/events/history   - Recent event history (in-memory)
 * 
 * GUI:
 *   GET  /                     - Admin dashboard (served from /public)
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const UniFiClient = require('./unifi-client');
const Resolver = require('./resolver');
const RulesEngine = require('./rules-engine');
const { createBackup, listBackups, restoreBackup, pruneBackups } = require('./backup');
const ConfigSync = require('./config-sync');
const APP_VERSION = require('../package.json').version;

// ---------------------------------------------------------------------------
// Load config
// ---------------------------------------------------------------------------

const CONFIG_PATH = process.env.MIDDLEWARE_CONFIG_PATH || process.env.CONFIG_PATH || path.resolve(__dirname, '../config/config.json');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(CONFIG_PATH), 'backups');

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw);
}

let config = loadConfig();

// ---------------------------------------------------------------------------
// Initialize components
// ---------------------------------------------------------------------------

let unifiClient = new UniFiClient(config);
let resolver = new Resolver(config, unifiClient);
let rulesEngine = new RulesEngine(config, unifiClient, resolver);
let configSync = null;  // initialized in start() once Express + UniFi client are up

// ---------------------------------------------------------------------------
// Event history + SSE clients
// ---------------------------------------------------------------------------

const EVENT_HISTORY_MAX = 200;
const eventHistory = [];
const sseClients = new Set();

function broadcastEvent(eventData) {
  const entry = {
    id: Date.now(),
    timestamp: new Date().toISOString(),
    ...eventData
  };
  eventHistory.unshift(entry);
  if (eventHistory.length > EVENT_HISTORY_MAX) {
    eventHistory.length = EVENT_HISTORY_MAX;
  }
  for (const client of sseClients) {
    client.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
}

// Raw payload ring buffer for debugging
const RAW_PAYLOAD_MAX = 30;
const rawPayloads = [];

function storeRawPayload(source, payload) {
  rawPayloads.unshift({
    source,
    timestamp: new Date().toISOString(),
    payload: typeof payload === 'object' ? JSON.parse(JSON.stringify(payload)) : payload
  });
  if (rawPayloads.length > RAW_PAYLOAD_MAX) rawPayloads.length = RAW_PAYLOAD_MAX;
}

function buildBroadcastAction(beforeStats, afterStats) {
  const proc = afterStats.last_processing;
  let action;
  let success = true;

  if (proc) {
    switch (proc.action) {
      case 'unlocked':
        action = `Unlocked: ${proc.doorsUnlocked?.join(', ') || afterStats.last_unlock?.door || 'unknown'}`;
        break;
      case 'unlock_failed':
        action = `Unlock failed: ${proc.doorsAttempted?.join(', ') || 'unknown'}`;
        success = false;
        break;
      case 'delayed':
        action = proc.detail || `Unlocking in ${proc.delay}s...`;
        break;
      case 'no_group':
        action = proc.detail || `No group resolved for ${proc.actorName || 'unknown'}`;
        break;
      case 'no_rules':
        action = proc.detail || `No rules matched`;
        break;
      case 'skipped_self':
        action = 'Skipped (self-triggered)';
        break;
      case 'doorbell_wrong_reason':
        action = proc.detail || 'Doorbell: not an admin unlock';
        break;
      default:
        action = proc.detail || 'Processed';
    }
  } else {
    action = afterStats.unlocks_triggered > beforeStats.unlocks_triggered
      ? `Unlocked: ${afterStats.last_unlock?.door || 'unknown'}`
      : afterStats.events_skipped_self > beforeStats.events_skipped_self
        ? 'Skipped (self-triggered)'
        : afterStats.events_skipped_no_action > beforeStats.events_skipped_no_action
          ? 'No action needed'
          : 'Processed';
    success = afterStats.unlocks_failed <= beforeStats.unlocks_failed;
  }

  return {
    type: afterStats.last_event?.type || 'unknown',
    actor: afterStats.last_event?.actor || 'unknown',
    location: afterStats.last_event?.location || 'unknown',
    device: afterStats.last_event?.device || null,
    action,
    success,
    unlock_door: afterStats.last_unlock?.door || null,
    unlock_reason: afterStats.last_unlock?.reason || null,
    processing: proc || null
  };
}

function patchEngineForBroadcast(engine) {
  if (engine._broadcastPatched) {
    engine.setBroadcaster(broadcastEvent);
    return;
  }
  const origHandler = engine.handleEvent.bind(engine);
  engine.handleEvent = async function(rawPayload) {
    const before = { ...this.getStats() };
    const result = await origHandler(rawPayload);
    if (result === false) {
      return;
    }
    const after = this.getStats();
    broadcastEvent(buildBroadcastAction(before, after));
  };
  engine._broadcastPatched = true;
  engine.setBroadcaster(broadcastEvent);
}

// Patch the rules engine to broadcast events to the GUI
patchEngineForBroadcast(rulesEngine);

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

function timingSafeCompare(a, b) {
  const aBuf = Buffer.from(a || '', 'utf8');
  const bBuf = Buffer.from(b || '', 'utf8');

  if (aBuf.length !== bBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuf, bBuf);
}

function requireAdminApiKey(req, res, next) {
  const expectedApiKey = config.server?.admin_api_key;
  if (!expectedApiKey) {
    return next();
  }

  const providedApiKey = req.get('x-api-key');
  if (!timingSafeCompare(providedApiKey, expectedApiKey)) {
    logger.warn(`Blocked unauthorized request: ${req.method} ${req.path}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

// Serve static GUI files
app.use(express.static(path.resolve(__dirname, '../public')));

// Request logging (skip health checks and static files)
app.use((req, res, next) => {
  if (req.path !== '/health' && !req.path.startsWith('/css') && !req.path.startsWith('/js') && req.path !== '/favicon.ico') {
    logger.debug(`${req.method} ${req.path}`);
  }
  next();
});

app.use('/api', requireAdminApiKey);
app.use('/reload', requireAdminApiKey);
app.use('/test', requireAdminApiKey);

// ---------------------------------------------------------------------------
// POST /webhook
// ---------------------------------------------------------------------------

app.post('/webhook', async (req, res) => {
  const webhookSecret = config.event_source?.api_webhook?.secret;
  if (webhookSecret) {
    const signatureHeader = req.get('x-orchestrator-signature') || '';
    const expectedSignature = `sha256=${crypto.createHmac('sha256', webhookSecret).update(req.rawBody || '').digest('hex')}`;
    if (!timingSafeCompare(signatureHeader, expectedSignature)) {
      logger.warn('Rejected webhook with invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    logger.warn('Webhook received empty or invalid payload');
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const eventType = payload.event || payload.type || payload.event_type || 'unknown';
  logger.info(`Webhook received: ${eventType}`);
  logger.debug(`Webhook payload: ${JSON.stringify(payload).substring(0, 500)}`);
  lastEventTime = Date.now();
  storeRawPayload('webhook', payload);

  try {
    await rulesEngine.handleEvent(payload);
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    logger.error(`Error processing webhook: ${err.message}`);
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({
    status: 'running',
    version: APP_VERSION,
    uptime_seconds: Math.floor(process.uptime()),
    event_source: config.event_source?.mode || 'alarm_manager',
    unifi: unifiClient.getStatus(),
    engine: rulesEngine.getStats(),
    auto_sync: configSync ? configSync.getState() : { enabled: false, interval_seconds: 0, last_run_at: null, last_change_detected_at: null, last_error: null },
    memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 10) / 10
  });
});

// ---------------------------------------------------------------------------
// GET /api/debug/payloads - Raw event payload viewer
// ---------------------------------------------------------------------------

app.get('/api/debug/payloads', (req, res) => {
  res.json({ payloads: rawPayloads, count: rawPayloads.length });
});

// ---------------------------------------------------------------------------
// GET /api/events/stream - SSE for live events
// ---------------------------------------------------------------------------

app.get('/api/events/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ---------------------------------------------------------------------------
// GET /api/events/history - Recent events
// ---------------------------------------------------------------------------

app.get('/api/events/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, EVENT_HISTORY_MAX);
  res.json(eventHistory.slice(0, limit));
});

// ---------------------------------------------------------------------------
// POST /test/unlock/:door
// ---------------------------------------------------------------------------

app.post('/test/unlock/:door', async (req, res) => {
  const doorName = decodeURIComponent(req.params.door);
  logger.info(`Manual test unlock requested: "${doorName}"`);
  const result = await unifiClient.unlockDoorByName(doorName, 'manual test (GUI)');

  broadcastEvent({
    type: 'test.unlock',
    actor: 'GUI Admin',
    location: doorName,
    action: result.success ? `Unlocked: ${doorName}` : `Failed: ${result.error}`,
    success: result.success,
    unlock_door: doorName
  });

  res.json(result);
});

// ---------------------------------------------------------------------------
// POST /test/event
// ---------------------------------------------------------------------------

app.post('/test/event', async (req, res) => {
  const { user_id, user_name, location, event_type, reason_code, device_name } = req.body;
  if (!location) {
    return res.status(400).json({ error: 'location is required' });
  }

  const synthetic = {
    event: event_type || 'access.door.unlock',
    event_object_id: `test-${Date.now()}`,
    data: {
      location: { id: `test-loc-${Date.now()}`, location_type: 'door', name: location },
      device: { name: device_name || 'Test Device', device_type: 'TEST' },
      actor: user_id ? { id: user_id, name: user_name || 'Test User', type: 'user' } : null,
      object: {
        authentication_type: event_type === 'access.doorbell.completed' ? 'CALL' : 'NFC',
        policy_id: '', policy_name: '', result: 'Access Granted',
        reason_code: reason_code !== undefined ? parseInt(reason_code) : undefined
      }
    }
  };

  logger.info(`Simulating event: type=${synthetic.event} at "${location}"`);

  try {
    await rulesEngine.handleEvent(synthetic);
    res.json({ status: 'ok', simulated_event: synthetic.event });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Simulation helpers — build envelope-accurate payloads matching what the
// configured event source would actually deliver, so the simulator exercises
// the same normalization/filter/resolver paths as a real badge tap.
// ---------------------------------------------------------------------------

function buildSimulationPayload(opts) {
  const {
    envelopeMode, eventType,
    userId, userName,
    doorName, doorId,
    deviceName, deviceId,
    reasonCode, authType,
    dryRun
  } = opts;

  const ts = Date.now();
  const inferredAuth = authType || (eventType === 'access.doorbell.completed' ? 'CALL' : 'NFC');
  const extra = { simulated: true, ...(dryRun ? { simulated_dry_run: true } : {}) };

  if (envelopeMode === 'websocket') {
    const target = [];
    if (doorId || doorName) {
      target.push({ type: 'door', id: doorId || `sim-door-${ts}`, display_name: doorName, name: doorName });
    }
    if (deviceName || deviceId) {
      target.push({ type: 'device', id: deviceId || `sim-dev-${ts}`, display_name: deviceName || 'Simulated Reader', name: deviceName || 'Simulated Reader' });
    }
    return {
      event: 'access.logs.add',
      event_object_id: `sim-${ts}`,
      data: {
        _source: {
          event: {
            type: eventType,
            authentication_type: inferredAuth,
            result: 'ACCESS',
            ...(reasonCode !== undefined ? { reason_code: Number(reasonCode) } : {})
          },
          actor: userId
            ? { id: userId, display_name: userName || 'Simulated User', name: userName || 'Simulated User', type: 'user' }
            : null,
          target,
          extra
        }
      }
    };
  }

  if (envelopeMode === 'alarm_manager') {
    return {
      alarm: {
        name: doorName,
        triggers: [{
          key: eventType === 'access.doorbell.completed' ? 'doorbell.completed' : 'door.unlock',
          actor: userId ? { id: userId, name: userName || 'Simulated User', display_name: userName || 'Simulated User' } : null
        }],
        sources: [{ device: deviceId || `sim-dev-${ts}` }],
        extra
      }
    };
  }

  // webhook (default)
  return {
    event: eventType,
    event_object_id: `sim-${ts}`,
    data: {
      location: { id: doorId || `sim-loc-${ts}`, location_type: 'door', name: doorName },
      device: { name: deviceName || 'Simulated Reader', device_type: 'TEST', id: deviceId || `sim-dev-${ts}` },
      actor: userId ? { id: userId, name: userName || 'Simulated User', type: 'user' } : null,
      object: {
        authentication_type: inferredAuth,
        policy_id: '', policy_name: '', result: 'Access Granted',
        ...(reasonCode !== undefined ? { reason_code: Number(reasonCode) } : {})
      },
      extra
    }
  };
}

function findRealEventForComparison({ userId, doorName }) {
  for (const entry of rawPayloads) {
    if (typeof entry.source === 'string' && entry.source.startsWith('simulator')) continue;
    const json = JSON.stringify(entry.payload || '');
    const userMatch = userId && json.includes(userId);
    const doorMatch = doorName && json.includes(doorName);
    if (userMatch || doorMatch) {
      return { ...entry, matched_on: userMatch ? 'user_id' : 'door_name' };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// POST /test/preflight
// Runs a sequence of pass/fail checks for a (user, door, rule type) tuple
// before any simulation runs — surfaces the real-world failure modes the
// dashboard's "simulate" button used to mask.
// ---------------------------------------------------------------------------

app.post('/test/preflight', async (req, res) => {
  const { user_id, door_name, rule_type, device_name } = req.body || {};
  const ruleType = rule_type === 'visitor' ? 'visitor' : 'access';
  const checks = [];

  // 1. Controller reachability
  const ctrlState = unifiClient.connectionState || 'unknown';
  checks.push({
    name: 'Controller reachable',
    pass: ctrlState === 'connected',
    detail: `Connection state: ${ctrlState}`
  });

  // 2. Event source live
  const mode = config.event_source?.mode || 'alarm_manager';
  if (mode === 'websocket') {
    const WebSocketLib = require('ws');
    const wsOpen = unifiClient.ws?.readyState === WebSocketLib.OPEN;
    checks.push({
      name: 'WebSocket connected',
      pass: wsOpen,
      detail: wsOpen
        ? 'Live (real taps would arrive here)'
        : 'Disconnected — real badge taps would not reach the orchestrator'
    });
  } else {
    checks.push({
      name: 'Event source',
      pass: true,
      detail: `Mode: ${mode} (no live socket required)`
    });
  }

  // 3. Door discovered + online
  const doorId = door_name ? unifiClient.doors.get(door_name) : null;
  if (!door_name) {
    checks.push({ name: 'Door discovered', pass: false, detail: 'No door selected' });
  } else if (!doorId) {
    const known = [...unifiClient.doors.keys()].join(', ') || 'none';
    checks.push({
      name: 'Door discovered',
      pass: false,
      detail: `"${door_name}" not in discovery cache. Known: ${known}`
    });
  } else {
    checks.push({
      name: 'Door discovered',
      pass: true,
      detail: `"${door_name}" → ${doorId.substring(0, 12)}…`
    });

    // Probe door online state — fail-closed on any probe error so connectivity,
    // auth, or permission failures surface here instead of being masked.
    let onlinePass = false;
    let probeDetail;
    try {
      const r = await unifiClient.request('GET', `/doors/${doorId}`);
      const d = r.data || {};
      if (d.is_bind_hub === false) {
        probeDetail = 'Controller reports door is NOT bound to a hub (offline)';
      } else {
        onlinePass = true;
        const lock = d.door_lock_relay_status ? `, lock=${d.door_lock_relay_status}` : '';
        probeDetail = `Controller reports door bound to hub${lock}`;
      }
    } catch (err) {
      const status = err.response?.status;
      const tag = status === 401 || status === 403
        ? 'auth/permission failure'
        : status
          ? `HTTP ${status}`
          : 'network/connectivity failure';
      probeDetail = `Online probe failed (${tag}): ${err.message}`;
    }
    checks.push({
      name: 'Door online',
      pass: onlinePass,
      detail: probeDetail
    });
  }

  // 4. Resolve to group — by user (access) or by viewer device (visitor fallback)
  let resolvedGroup = null;
  let resolveDetail = '';
  if (user_id) {
    const r = resolver.resolve(user_id);
    resolvedGroup = r.group;
    const displayName = r.userName || unifiClient.getUserName(user_id) || user_id;
    resolveDetail = resolvedGroup
      ? `${displayName} → "${resolvedGroup}" (via ${r.strategy})`
      : `${displayName} did not resolve to any group — check resolver.unifi_group_to_group mapping`;
    checks.push({ name: 'User resolves to group', pass: !!resolvedGroup, detail: resolveDetail });
  } else if (ruleType === 'visitor' && device_name) {
    const ci = rulesEngine._viewerToGroupCI || {};
    resolvedGroup = ci[String(device_name).trim().toLowerCase()] || null;
    resolveDetail = resolvedGroup
      ? `viewer device "${device_name}" → "${resolvedGroup}" (via viewer_to_group)`
      : `viewer device "${device_name}" not in doorbell_rules.viewer_to_group`;
    checks.push({ name: 'Viewer device resolves to group', pass: !!resolvedGroup, detail: resolveDetail });
  } else if (ruleType === 'visitor') {
    checks.push({ name: 'Resolve to group', pass: false, detail: 'Pick a user OR a viewer device' });
  } else {
    checks.push({ name: 'User resolves to group', pass: false, detail: 'No user selected' });
  }

  // 5. Matching rule exists
  const ruleSet = ruleType === 'visitor' ? rulesEngine.visitorRules : rulesEngine.accessRules;
  const matching = resolvedGroup && door_name
    ? ruleSet.filter(r => r.group === resolvedGroup && rulesEngine.locationMatches(door_name, r.trigger))
    : [];
  const allUnlocks = [...new Set(matching.flatMap(r => r.unlock || []))];
  checks.push({
    name: `Matching ${ruleType} rule`,
    pass: matching.length > 0,
    detail: matching.length > 0
      ? `${matching.length} rule(s) → unlock: ${allUnlocks.join(', ') || '(none)'}`
      : `No ${ruleType} rule for group "${resolvedGroup || 'unresolved'}" at trigger "${door_name || ''}"`
  });

  // 6. Self-trigger guard (synthetic payload never carries the marker)
  const stk = config.self_trigger_prevention?.marker_key;
  checks.push({
    name: 'Self-trigger guard',
    pass: true,
    detail: stk
      ? `Marker "${stk}" configured; simulator omits it so the event will not be filtered`
      : 'No self-trigger marker configured'
  });

  const failCount = checks.filter(c => !c.pass).length;
  res.json({
    checks,
    summary: {
      pass: failCount === 0,
      fail_count: failCount,
      envelope_mode: mode === 'api_webhook' ? 'webhook' : mode
    }
  });
});

// ---------------------------------------------------------------------------
// POST /test/simulate-rule
// Envelope-accurate end-to-end simulator. Builds a payload matching the
// configured event-source shape and feeds it through the same handleEvent
// path as a real event. By default the actual controller unlock call is
// stubbed (dry-run); execute_real_unlock=true performs the real PUT.
// ---------------------------------------------------------------------------

app.post('/test/simulate-rule', async (req, res) => {
  const {
    user_id, user_name,
    door_name, rule_type,
    device_name,
    execute_real_unlock
  } = req.body || {};

  if (!door_name) {
    return res.status(400).json({ error: 'door_name is required' });
  }

  const ruleType = rule_type === 'visitor' ? 'visitor' : 'access';
  const eventType = ruleType === 'visitor' ? 'access.doorbell.completed' : 'access.door.unlock';
  const mode = config.event_source?.mode || 'alarm_manager';
  const envelopeMode = mode === 'api_webhook' ? 'webhook' : (mode === 'websocket' ? 'websocket' : 'alarm_manager');

  const doorId = unifiClient.doors.get(door_name) || null;
  const resolvedUserName = user_name
    || (user_id ? unifiClient.getUserName(user_id) : null)
    || (user_id ? 'Simulated User' : null);

  const dryRun = !execute_real_unlock;
  const payload = buildSimulationPayload({
    envelopeMode,
    eventType,
    userId: user_id || null,
    userName: resolvedUserName,
    doorName: door_name,
    doorId,
    deviceName: device_name || null,
    reasonCode: ruleType === 'visitor' ? 107 : undefined,
    dryRun
  });

  storeRawPayload(`simulator:${envelopeMode}${dryRun ? ':dry-run' : ':REAL'}`, payload);

  if (!dryRun) {
    logger.warn(`[SIMULATOR] execute_real_unlock=true — real PUT /doors/:id/unlock will be issued`);
  }

  let error = null;
  const beforeStats = { ...rulesEngine.getStats() };
  try {
    // The dry-run flag is embedded in payload.extra.simulated_dry_run and
    // propagates through normalizeEvent into event.extra, where executeUnlocks
    // (including any setTimeout-deferred delayed unlocks) checks it. This
    // guarantees no real PUT /doors/:id/unlock fires while dry-run is set,
    // even for delayed rules whose unlock callback runs after this handler
    // returns.
    await rulesEngine.handleEvent(payload);
  } catch (e) {
    error = e.message;
    logger.error(`Simulator error: ${e.message}`);
  }

  const afterStats = rulesEngine.getStats();
  const processing = afterStats.last_processing || null;

  const realEvent = findRealEventForComparison({ userId: user_id, doorName: door_name });

  res.json({
    status: error ? 'error' : 'ok',
    error,
    envelope_mode: envelopeMode,
    event_type: eventType,
    rule_type: ruleType,
    payload,
    executed_real_unlock: !!execute_real_unlock,
    dry_run: dryRun,
    processing,
    last_event: afterStats.last_event,
    stats_delta: {
      events_filtered: afterStats.events_filtered - beforeStats.events_filtered,
      events_processed: afterStats.events_processed - beforeStats.events_processed,
      events_skipped_self: afterStats.events_skipped_self - beforeStats.events_skipped_self,
      events_skipped_no_action: afterStats.events_skipped_no_action - beforeStats.events_skipped_no_action,
      unlocks_triggered: afterStats.unlocks_triggered - beforeStats.unlocks_triggered,
      unlocks_failed: afterStats.unlocks_failed - beforeStats.unlocks_failed
    },
    real_event_for_comparison: realEvent
  });
});

// ---------------------------------------------------------------------------
// POST /reload
// ---------------------------------------------------------------------------

app.post('/reload', async (req, res) => {
  logger.info('Config reload requested');
  try {
    const result = await reloadOrchestrator({
      reason: 'manual_reload',
      actor: 'GUI Admin',
      eventType: 'system.reload',
      actionPrefix: 'Config reloaded'
    });
    logger.info(`Config reloaded successfully (${result.mode})`);
    res.json({ status: 'reloaded', mode: result.mode });
  } catch (err) {
    logger.error(`Config reload failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/config
// ---------------------------------------------------------------------------

app.get('/api/config', (req, res) => {
  const sanitized = JSON.parse(JSON.stringify(config));
  if (sanitized.unifi?.token) sanitized.unifi.token = '***REDACTED***';
  if (sanitized.auto_lock?.shared_token) sanitized.auto_lock.shared_token = '***REDACTED***';
  res.json(sanitized);
});

// ---------------------------------------------------------------------------
// PUT /api/config - Save config changes
// ---------------------------------------------------------------------------

app.put('/api/config', async (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Invalid config data' });
  }

  try {
    // Read current config (with real token)
    const current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

    // Drop redacted secrets so the UI echoing placeholders doesn't overwrite real values.
    if (updates.unifi?.token === '***REDACTED***') delete updates.unifi.token;
    if (updates.auto_lock?.shared_token === '***REDACTED***') delete updates.auto_lock.shared_token;

    // Deep merge updates (only allow specific safe keys)
    const safeKeys = ['unlock_rules', 'doorbell_rules', 'event_source', 'logging', 'server', 'unifi', 'resolver', 'doors', 'backup', 'watchdog', 'auto_lock', 'auto_sync'];

    // recursive merge for plain objects: source values override primitives/arrays
    function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
    function deepMerge(target, source) {
      if (!isPlainObject(source)) return source;
      if (!isPlainObject(target)) target = {};
      for (const k of Object.keys(source)) {
        const sv = source[k];
        if (isPlainObject(sv)) {
          target[k] = deepMerge(target[k], sv);
        } else {
          target[k] = sv;
        }
      }
      return target;
    }

    for (const key of safeKeys) {
      if (updates[key] !== undefined) {
        if (isPlainObject(updates[key]) && isPlainObject(current[key])) {
          current[key] = deepMerge(current[key], updates[key]);
        } else {
          current[key] = updates[key];
        }
      }
    }

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2));
    logger.info('Config saved to disk');
    if (configSync) configSync.markConfigApplied();

    // Auto-reload the service to apply changes immediately
    let reloadMode = 'skipped';
    try {
      const result = await reloadOrchestrator({
        reason: 'config_saved',
        actor: 'API',
        eventType: 'system.config_reload',
        actionPrefix: 'Config reloaded'
      });
      reloadMode = result.mode;
      logger.info(`Config reloaded automatically (${result.mode})`);
    } catch (reloadErr) {
      logger.warn(`Auto-reload after config save failed: ${reloadErr.message}`);
    }

    res.json({ status: 'saved', note: 'Config applied automatically', reload_mode: reloadMode });
  } catch (err) {
    logger.error(`Config save failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Backup API endpoints
// ---------------------------------------------------------------------------

app.get('/api/backups', (req, res) => {
  try {
    const backups = listBackups(BACKUP_DIR);
    const intervalDays = config.backup?.interval_days || 30;
    const maxBackups = config.backup?.max_backups || 12;
    res.json({ backups, settings: { interval_days: intervalDays, max_backups: maxBackups }, backup_dir: BACKUP_DIR });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backups', (req, res) => {
  try {
    const result = createBackup(CONFIG_PATH, BACKUP_DIR);
    const maxBackups = config.backup?.max_backups || 12;
    pruneBackups(BACKUP_DIR, maxBackups);
    logger.info(`Manual backup created: ${result.filename}`);
    res.json({ status: 'ok', backup: result });
  } catch (err) {
    logger.error(`Manual backup failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backups/restore', async (req, res) => {
  const { filename } = req.body || {};
  if (!filename) {
    return res.status(400).json({ error: 'Missing filename' });
  }

  try {
    const result = restoreBackup(filename, BACKUP_DIR, CONFIG_PATH);
    logger.info(`Config restored from backup: ${filename}`);
    if (configSync) configSync.markConfigApplied();

    try {
      const reloadResult = await reloadOrchestrator({
        reason: 'backup_restore',
        actor: 'Admin',
        eventType: 'system.config_restore',
        actionPrefix: `Restored from ${filename}`
      });
      logger.info(`Config reloaded after restore (${reloadResult.mode})`);
    } catch (reloadErr) {
      logger.warn(`Auto-reload after restore failed: ${reloadErr.message}`);
    }

    res.json({ status: 'restored', ...result });
  } catch (err) {
    logger.error(`Restore failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/backups/:filename', (req, res) => {
  const { filename } = req.params;
  if (!/^config_\d{4}-\d{2}-\d{2}_\d{6}\.json$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Backup not found' });
  }

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.sendFile(filePath);
});

// ---------------------------------------------------------------------------
// GET /api/docs - Serve README content for in-app documentation
// ---------------------------------------------------------------------------

app.get('/api/docs', (req, res) => {
  const readmeCandidates = [
    path.resolve(__dirname, '../README.md'),
    path.resolve(process.resourcesPath || '', 'README.md')
  ];

  for (const candidate of readmeCandidates) {
    if (fs.existsSync(candidate)) {
      const content = fs.readFileSync(candidate, 'utf-8');
      return res.json({ content });
    }
  }

  res.json({ content: '# Documentation\n\nREADME file not found. Visit https://github.com/ajbcloud/UniFi-Access-Orchestrator for documentation.' });
});

// ---------------------------------------------------------------------------
// GET /api/test-connection - Test connectivity to Access Gateway
// ---------------------------------------------------------------------------

app.get('/api/test-connection', async (req, res) => {
  const net = require('net');
  const https = require('https');
  const results = {
    host: config.unifi?.host || '',
    port: config.unifi?.port || 12445,
    steps: []
  };

  if (!results.host) {
    results.steps.push({ name: 'Configuration', status: 'fail', detail: 'No Access Gateway IP configured. Go to File > Connection Settings.' });
    return res.json(results);
  }

  // Step 1: DNS / IP resolution
  results.steps.push({ name: 'IP Address', status: 'ok', detail: results.host });

  // Step 2: TCP connectivity to port
  const tcpResult = await new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(5000);
    socket.on('connect', () => { socket.destroy(); resolve({ status: 'ok', detail: `Port ${results.port} is reachable` }); });
    socket.on('timeout', () => { socket.destroy(); resolve({ status: 'fail', detail: `Connection timed out on port ${results.port}. The Access Gateway may be offline or on a different network.` }); });
    socket.on('error', (err) => { socket.destroy(); resolve({ status: 'fail', detail: `Cannot reach port ${results.port}: ${err.message}` }); });
    socket.connect(results.port, results.host);
  });
  results.steps.push({ name: 'Network Connectivity', ...tcpResult });

  if (tcpResult.status === 'fail') {
    return res.json(results);
  }

  // Step 3: HTTPS / API response
  const apiResult = await new Promise((resolve) => {
    const req = https.get(`https://${results.host}:${results.port}/api/v1/developer/doors`, {
      rejectUnauthorized: false,
      timeout: 10000,
      headers: config.unifi?.token ? { 'Authorization': `Bearer ${config.unifi.token}` } : {}
    }, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        if (apiRes.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            const doorCount = parsed.data?.length || 0;
            resolve({ status: 'ok', detail: `API responding. Found ${doorCount} door${doorCount !== 1 ? 's' : ''}.` });
          } catch {
            resolve({ status: 'ok', detail: 'API responding (could not parse door list).' });
          }
        } else if (apiRes.statusCode === 401 || apiRes.statusCode === 403) {
          resolve({ status: 'fail', detail: `API reachable but authentication failed (HTTP ${apiRes.statusCode}). Check your API token.` });
        } else {
          resolve({ status: 'warn', detail: `API returned HTTP ${apiRes.statusCode}. The Access application may not be running.` });
        }
      });
    });
    req.on('error', (err) => resolve({ status: 'fail', detail: `HTTPS request failed: ${err.message}` }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 'fail', detail: 'API request timed out after 10 seconds.' }); });
  });
  results.steps.push({ name: 'Access API', ...apiResult });

  // Step 4: User groups (if API is working)
  if (apiResult.status === 'ok') {
    const userResult = await new Promise((resolve) => {
      const req = https.get(`https://${results.host}:${results.port}/api/v1/developer/users`, {
        rejectUnauthorized: false,
        timeout: 10000,
        headers: { 'Authorization': `Bearer ${config.unifi.token}` }
      }, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
          if (apiRes.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              const userCount = parsed.data?.length || 0;
              resolve({ status: 'ok', detail: `Found ${userCount} user${userCount !== 1 ? 's' : ''}.` });
            } catch {
              resolve({ status: 'ok', detail: 'Users endpoint responding.' });
            }
          } else {
            resolve({ status: 'warn', detail: `Users endpoint returned HTTP ${apiRes.statusCode}.` });
          }
        });
      });
      req.on('error', (err) => resolve({ status: 'warn', detail: `Users request failed: ${err.message}` }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 'warn', detail: 'Users request timed out.' }); });
    });
    results.steps.push({ name: 'User Groups', ...userResult });
  }

  res.json(results);
});

// ---------------------------------------------------------------------------
// GET /api/discover - Scan local network for UniFi controllers
// ---------------------------------------------------------------------------

app.get('/api/discover', async (req, res) => {
  const net = require('net');
  const os = require('os');
  const https = require('https');

  logger.info('Network discovery started');

  // Get all local network interfaces to determine subnets to scan
  const interfaces = os.networkInterfaces();
  const subnets = new Set();

  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        // Extract the /24 subnet base (e.g. 192.168.1.x -> 192.168.1)
        const parts = addr.address.split('.');
        subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
      }
    }
  }

  if (subnets.size === 0) {
    return res.json({ controllers: [], message: 'No network interfaces found' });
  }

  const port = 12445;
  const timeout = 1500; // ms per connection attempt
  const found = [];

  // Scan function: try to TCP connect to port 12445
  function probe(ip) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeout);

      socket.on('connect', () => {
        socket.destroy();
        resolve(ip);
      });

      socket.on('timeout', () => { socket.destroy(); resolve(null); });
      socket.on('error', () => { socket.destroy(); resolve(null); });

      socket.connect(port, ip);
    });
  }

  // For each subnet, scan common controller IPs first, then the rest
  // Priority IPs: .1, .2, .10, .20, .100, .200, .254 (common for gateways/controllers)
  // Then scan the rest in batches
  const priorityOctets = [1, 2, 10, 20, 50, 100, 150, 200, 210, 220, 250, 254];

  for (const subnet of subnets) {
    // Phase 1: Priority IPs (fast)
    const priorityIps = priorityOctets.map(o => `${subnet}.${o}`);
    const priorityResults = await Promise.all(priorityIps.map(probe));

    for (const ip of priorityResults) {
      if (ip) {
        // Try to get device info
        const info = await getControllerInfo(ip, port);
        found.push({ ip, port, ...info });
      }
    }

    // Phase 2: Scan remaining IPs in batches of 30
    const remaining = [];
    for (let i = 1; i <= 254; i++) {
      if (!priorityOctets.includes(i)) {
        remaining.push(`${subnet}.${i}`);
      }
    }

    for (let batch = 0; batch < remaining.length; batch += 30) {
      const chunk = remaining.slice(batch, batch + 30);
      const results = await Promise.all(chunk.map(probe));
      for (const ip of results) {
        if (ip) {
          const info = await getControllerInfo(ip, port);
          found.push({ ip, port, ...info });
        }
      }
    }
  }

  logger.info(`Discovery complete: found ${found.length} controller(s) on ${subnets.size} subnet(s)`);
  res.json({ controllers: found, subnets_scanned: [...subnets] });
});

// Try to identify a UniFi controller by hitting its API
function getControllerInfo(ip, port) {
  const https = require('https');
  return new Promise((resolve) => {
    const req = https.get(`https://${ip}:${port}/api/v1/developer/doors`, {
      rejectUnauthorized: false,
      timeout: 3000,
      headers: { 'Authorization': 'Bearer test' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Even with a bad token, if we get a JSON response it's a UniFi Access API
        const isAccess = res.statusCode === 401 || res.statusCode === 403 || 
                         (res.statusCode === 200 && data.includes('"code"'));
        resolve({
          confirmed: isAccess,
          status_code: res.statusCode,
          type: isAccess ? 'UniFi Access Controller' : 'Unknown service on port ' + port
        });
      });
    });
    req.on('error', () => resolve({ confirmed: false, type: 'Connection failed' }));
    req.on('timeout', () => { req.destroy(); resolve({ confirmed: false, type: 'Timeout' }); });
  });
}

// ---------------------------------------------------------------------------
// GET /api/doors
// ---------------------------------------------------------------------------

app.get('/api/doors', (req, res) => {
  res.json({
    discovered: Object.fromEntries(unifiClient.doors),
    configured: config.doors
  });
});

// ---------------------------------------------------------------------------
// GET /api/users
// ---------------------------------------------------------------------------

app.get('/api/users', (req, res) => {
  const users = [];
  for (const [userId, group] of unifiClient.userGroupMap) {
    users.push({ id: userId, name: unifiClient.getUserName(userId) || 'unknown', group });
  }
  res.json({ count: users.length, users });
});

// ---------------------------------------------------------------------------
// GET /api/groups/discovered
// ---------------------------------------------------------------------------

app.get('/api/groups/discovered', (req, res) => {
  const groups = unifiClient.getDiscoveredGroups();
  const users = unifiClient.getDiscoveredUsers();
  res.json({ groups, users });
});

// ---------------------------------------------------------------------------
// POST /api/sync
// ---------------------------------------------------------------------------

app.post('/api/sync', async (req, res) => {
  logger.info('Manual user group sync requested');
  await unifiClient.syncUserGroups();
  broadcastEvent({ type: 'system.sync', actor: 'GUI Admin', location: '-', action: `Synced ${unifiClient.userGroupMap.size} users`, success: true });
  res.json({ status: 'synced', users_mapped: unifiClient.userGroupMap.size });
});

// ---------------------------------------------------------------------------
// GET /auto-lock/:buttonId
//
// Unauthenticated GET endpoint for SIP phone DSS keys (e.g. Yealink), which
// can only send a bare GET with no headers. Each buttonId maps to a configured
// door + action. Optional shared_token is checked via ?token= query param.
//
// Do NOT log req.url or req.query.token — the token would leak into log files.
// If running behind a reverse proxy, set `app.set('trust proxy', ...)` so
// req.ip reports the real client IP instead of 127.0.0.1.
// ---------------------------------------------------------------------------

app.get('/auto-lock/:buttonId', async (req, res) => {
  const cfg = config.auto_lock || {};
  const button = (cfg.buttons || []).find(b => b.id === req.params.buttonId);
  const sourceIp = req.ip;

  if (!button) {
    logger.warn(`Auto-lock: unknown button "${req.params.buttonId}" from ${sourceIp}`);
    return res.status(404).json({ success: false, message: 'Unknown button' });
  }

  if (cfg.shared_token && !timingSafeCompare(req.query.token || '', cfg.shared_token)) {
    logger.warn(`Auto-lock: bad token for "${button.id}" from ${sourceIp}`);
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  if (!button.door_id) {
    logger.warn(`Auto-lock: button "${button.id}" has no door_id configured`);
    return res.status(400).json({ success: false, message: 'Button has no door configured' });
  }

  const doorName = unifiClient.doorsById.get(button.door_id) || button.door_id;
  let result;
  try {
    if (button.action === 'unlock') {
      result = await unifiClient.unlockDoor(button.door_id, `auto-lock "${button.id}" from ${sourceIp}`);
    } else {
      result = await unifiClient.setDoorLockRule(button.door_id, button.action);
    }
  } catch (err) {
    result = { success: false, error: err.message };
  }

  logger.info(`Auto-lock: button="${button.id}" door="${doorName}" action=${button.action} src=${sourceIp} ok=${result.success}`);
  broadcastEvent({
    type: 'auto_lock.button',
    actor: `Phone (${sourceIp})`,
    location: doorName,
    action: `${button.label || button.id}: ${button.action}`,
    success: !!result.success
  });

  res.json({
    success: !!result.success,
    message: result.success
      ? `${button.action} applied to ${doorName}`
      : (result.error || 'Failed')
  });
});

// ---------------------------------------------------------------------------
// Fallback: serve GUI for all non-API routes
// ---------------------------------------------------------------------------

app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../public/index.html'));
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

let lastEventTime = Date.now();
let watchdogInterval = null;
let watchdogRestartCallback = null;

function setWatchdogRestartCallback(fn) {
  watchdogRestartCallback = fn;
}

function startWatchdog() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }

  const timeoutMin = config.watchdog?.inactivity_timeout_minutes ?? 60;
  if (timeoutMin <= 0) {
    logger.info('Event activity watchdog disabled (timeout <= 0)');
    return;
  }

  const timeoutMs = timeoutMin * 60 * 1000;
  watchdogInterval = setInterval(() => {
    const silenceMs = Date.now() - lastEventTime;
    if (silenceMs >= timeoutMs) {
      logger.error(`Event activity watchdog: no events for ${Math.floor(silenceMs / 60000)} minutes. Triggering restart.`);
      unifiClient.shutdown();
      if (watchdogRestartCallback) {
        watchdogRestartCallback();
      } else {
        process.exit(1);
      }
    }
  }, 60000);

  logger.info(`Event activity watchdog started: ${timeoutMin} min inactivity threshold`);
}

// ---------------------------------------------------------------------------
// Event source startup + service reload helpers
//
// startEventSource() boots whichever event-ingestion mode is configured
// (alarm_manager / api_webhook / websocket) against the CURRENT unifiClient.
// It's used at startup AND whenever we rebuild the client after a config
// change — fixing the bug where saving config left the WebSocket dead.
//
// reloadServices(newConfig) decides whether the controller-side connection
// actually needs to be torn down. Pure rules-only changes (renaming a group
// mapping, editing unlock rules, etc.) keep the live WebSocket and just
// rebuild the resolver + rules engine in place. Only changes to controller
// host/token/port/SSL or event-source mode trigger a full client rebuild.
// ---------------------------------------------------------------------------

function startEventSource() {
  const mode = config.event_source?.mode || 'alarm_manager';
  if (mode === 'api_webhook') {
    const webhookConfig = config.event_source.api_webhook;
    if (webhookConfig) {
      unifiClient.registerWebhookEndpoint(webhookConfig)
        .then(result => {
          if (result.success) logger.info(`API webhook ${result.existing ? 'already registered' : 'registered successfully'}`);
          else logger.error(`API webhook registration failed: ${result.error}`);
        })
        .catch(err => logger.error(`API webhook registration error: ${err.message}`));
    }
  } else if (mode === 'websocket') {
    const reconnectSec = config.event_source.websocket?.reconnect_interval_seconds || 5;
    unifiClient.connectWebSocket((event) => {
      lastEventTime = Date.now();
      storeRawPayload('websocket', event);
      rulesEngine.handleEvent(event).catch(err => logger.error(`WebSocket event error: ${err.message}`));
    }, reconnectSec);
  }
}

function controllerOrSourceChanged(oldCfg, newCfg) {
  const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const fields = [
    'unifi.host',
    'unifi.port',
    'unifi.token',
    'unifi.verify_ssl',
    'unifi.user_sync_interval_minutes',
    'event_source.mode',
    'event_source.api_webhook.endpoint_url',
    'event_source.api_webhook.endpoint_name',
    'event_source.api_webhook.secret',
    'event_source.websocket.reconnect_interval_seconds'
  ];
  for (const f of fields) {
    if (JSON.stringify(get(oldCfg, f)) !== JSON.stringify(get(newCfg, f))) return true;
  }
  if (JSON.stringify(oldCfg.event_source?.api_webhook?.events) !== JSON.stringify(newCfg.event_source?.api_webhook?.events)) return true;
  return false;
}

function isEventSourceDegraded() {
  // For websocket mode, treat anything other than an OPEN socket as
  // degraded so /reload escalates to a hard reconnect even when no
  // controller settings actually changed.
  const mode = config.event_source?.mode || 'alarm_manager';
  if (mode !== 'websocket') return false;
  const WebSocket = require('ws');
  return !unifiClient?.ws || unifiClient.ws.readyState !== WebSocket.OPEN;
}

// Single shared reload entry point used by:
//   - Manual POST /reload
//   - PUT /api/config save (after writing to disk)
//   - POST /api/backups/restore
//   - Config Sync background job (when config.json changed on disk)
// Broadcasts a `system.auto_reload` SSE event so the dashboard can
// auto-refresh in place without a manual Refresh click.
async function reloadOrchestrator({
  reason,
  actor = 'auto-sync',
  eventType = 'system.auto_reload',
  actionPrefix = 'Auto-reloaded'
} = {}) {
  // Stop the background sync first so its tick can't race with the
  // unifiClient teardown/reinit inside reloadServices(). Re-applied in
  // finally so a failed reload still leaves the job running.
  if (configSync) configSync.stop();
  try {
    const newConfig = loadConfig();
    const result = await reloadServices(newConfig);
    const reasonSuffix = reason ? ` — reason: ${reason}` : '';
    broadcastEvent({
      type: eventType,
      actor,
      location: '-',
      action: `${actionPrefix} (${result.mode})${reasonSuffix}`,
      success: true,
      reason: reason || null
    });
    return result;
  } finally {
    applyAutoSyncFromConfig();
  }
}

async function reloadServices(newConfig) {
  const settingsChanged = controllerOrSourceChanged(config, newConfig);
  const degraded = isEventSourceDegraded();
  const fullReload = settingsChanged || degraded;

  if (degraded && !settingsChanged) {
    logger.info('Reload: event source is degraded — escalating to full reconnect');
  }

  if (fullReload) {
    logger.info('Reload: controller/event-source settings changed — rebuilding UniFi client');
    unifiClient.shutdown();
    unifiClient = new UniFiClient(newConfig);
    resolver = new Resolver(newConfig, unifiClient);
    rulesEngine = new RulesEngine(newConfig, unifiClient, resolver);
    patchEngineForBroadcast(rulesEngine);
    config = newConfig;

    const initOk = await unifiClient.initialize();
    if (initOk) {
      unifiClient.startHealthMonitor();
    } else {
      unifiClient.initializeWithRetry().then(() => unifiClient.startHealthMonitor());
    }
    startEventSource();
    startWatchdog();
    return { mode: 'full' };
  }

  logger.info('Reload: rules-only change — keeping live connection, rebuilding resolver + rules engine');

  // Propagate updated group-name mappings to the live UniFi client.
  // The client's userGroupMap is built from groupNameMap during
  // syncUserGroups(); without this push the resolver would still see the
  // previous logical labels until a full restart, which is exactly the
  // failure mode the cascade-unlock fix is meant to repair.
  const oldMap = config.resolver?.unifi_group_to_group || {};
  const newMap = newConfig.resolver?.unifi_group_to_group || {};
  const mappingChanged = JSON.stringify(oldMap) !== JSON.stringify(newMap);
  if (mappingChanged) {
    unifiClient.groupNameMap = newMap;
  }

  resolver = new Resolver(newConfig, unifiClient);
  rulesEngine = new RulesEngine(newConfig, unifiClient, resolver);
  patchEngineForBroadcast(rulesEngine);
  config = newConfig;
  startWatchdog();

  if (mappingChanged) {
    // Re-sync in the background so the mapping takes effect immediately
    // without blocking the API response. Errors are non-fatal — the next
    // periodic sync will pick it up.
    unifiClient.syncUserGroups()
      .then(() => logger.info('Resolver mapping change applied — user/group cache re-synced'))
      .catch(err => logger.warn(`Post-reload group resync failed: ${err.message}`));
  }

  return { mode: 'rules-only' };
}

async function start() {
  logger.info('=== UniFi Access Orchestrator Starting ===');
  logger.info(`Event source mode: ${config.event_source?.mode || 'alarm_manager'}`);

  const port = config.server?.port || 3000;
  const host = config.server?.host || '0.0.0.0';

  app.listen(port, host, () => {
    logger.info(`Server listening on ${host}:${port}`);
    logger.info(`Dashboard: http://${host}:${port}`);
    logger.info(`Webhook: http://${host}:${port}/webhook`);
    logger.info('=== Orchestrator Ready ===');
  });

  const initialized = await unifiClient.initialize();
  if (initialized) {
    unifiClient.startHealthMonitor();
  } else {
    logger.warn('Initial connection failed. Retrying in background...');
    unifiClient.initializeWithRetry().then(() => {
      unifiClient.startHealthMonitor();
    });
  }

  // Start periodic config backup — check daily, create if overdue
  const backupIntervalDays = config.backup?.interval_days || 30;
  const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // check once per day
  setInterval(() => {
    try {
      const existing = listBackups(BACKUP_DIR);
      const now = Date.now();
      const lastBackupTime = existing.length > 0 ? new Date(existing[0].timestamp).getTime() : 0;
      const daysSinceLast = (now - lastBackupTime) / (24 * 60 * 60 * 1000);

      if (daysSinceLast >= backupIntervalDays) {
        const result = createBackup(CONFIG_PATH, BACKUP_DIR);
        const maxBackups = config.backup?.max_backups || 12;
        pruneBackups(BACKUP_DIR, maxBackups);
        logger.info(`Scheduled backup created: ${result.filename} (${Math.floor(daysSinceLast)} days since last)`);
      }
    } catch (err) {
      logger.warn(`Scheduled backup check failed: ${err.message}`);
    }
  }, CHECK_INTERVAL_MS);
  logger.info(`Config backup schedule: every ${backupIntervalDays} days (checked daily)`);

  startEventSource();
  startWatchdog();

  // Start the periodic Config Sync job. Detects local config.json edits
  // and upstream UniFi controller drift (door/user/group changes) and
  // reloads in place. Read-only with respect to disk + controller.
  initConfigSync();
  applyAutoSyncFromConfig();
}

function initConfigSync() {
  if (configSync) return;
  configSync = new ConfigSync({
    configPath: CONFIG_PATH,
    getUnifiClient: () => unifiClient,
    onConfigFileChanged: async ({ reason }) => {
      try {
        await reloadOrchestrator({ reason });
      } catch (err) {
        logger.error(`Auto-reload (${reason}) failed: ${err.message}`);
      }
    },
    onControllerDoorsChanged: async ({ reason }) => {
      // discoverDoors() already updated the in-memory door registry on
      // the live client. Just notify the dashboard so it re-renders.
      broadcastEvent({
        type: 'system.auto_reload',
        actor: 'auto-sync',
        location: '-',
        action: `Doors changed on controller — refreshed registry`,
        success: true,
        reason
      });
    },
    onControllerUsersChanged: async ({ reason }) => {
      // syncUserGroups() already refreshed the resolver-backing cache.
      broadcastEvent({
        type: 'system.auto_reload',
        actor: 'auto-sync',
        location: '-',
        action: `Users/groups changed on controller — refreshed cache`,
        success: true,
        reason
      });
    }
  });
}

function applyAutoSyncFromConfig() {
  if (!configSync) return;
  const opts = config.auto_sync || {};
  configSync.start({
    enabled: opts.enabled !== false,
    intervalSeconds: opts.interval_seconds || 15
  });
}

// ---------------------------------------------------------------------------
// Export for Electron (require as module) or run standalone
// ---------------------------------------------------------------------------

module.exports = { start, app, setWatchdogRestartCallback };

// If run directly (node src/index.js), start immediately
// If required by Electron, it will call start() when ready
if (require.main === module) {
  process.on('SIGTERM', () => { logger.info('SIGTERM'); if (configSync) configSync.stop(); unifiClient.shutdown(); process.exit(0); });
  process.on('SIGINT', () => { logger.info('SIGINT'); if (configSync) configSync.stop(); unifiClient.shutdown(); process.exit(0); });
  process.on('uncaughtException', (err) => { logger.error(`Uncaught: ${err.message}\n${err.stack}`); });
  process.on('unhandledRejection', (reason) => { logger.error(`Unhandled rejection: ${reason}`); });

  start().catch(err => { logger.error(`Fatal: ${err.message}`); process.exit(1); });
}
