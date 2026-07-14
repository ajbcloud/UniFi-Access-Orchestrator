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
const CaptureSession = require('./capture');
const Notifier = require('./notifier');
const DeadboltController = require('./deadbolt-controller');
const FakeLock = require('./drivers/fake-lock');
const { ZwaveLock } = require('./drivers/zwave-lock');
const { ZwaveManager } = require('./drivers/zwave-manager');
const { ZwavePairing } = require('./drivers/zwave-pairing');
const { loadSecurityKeys, ensureSecurityKeys } = require('./drivers/zwave-keys');
const { SustainedFlagMonitor } = require('./alert-monitors');
const {
  redactSecrets,
  stripRedactedPlaceholders,
  validateConfigUpdates,
  ReplayGuard,
} = require('./security');
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
// Smart-deadbolt add-on (Phase 2). Entirely inert unless deadbolt_rules or
// cascade_rules are configured, so existing deployments are unaffected.
// ---------------------------------------------------------------------------
const captureDir = process.env.CAPTURE_DIR || path.join(path.dirname(CONFIG_PATH), 'captures');
const capture = new CaptureSession({ dir: captureDir });
let notifier = new Notifier(config.alerts || {}, { logger });
let lockDriver = null;
let deadboltController = null;

// Shared Z-Wave plumbing: ONE driver session per serial port, borrowed by both
// the lock driver and the pairing flow so they never contend for the port.
// Live getters keep these valid across config reloads.
const zwaveManager = new ZwaveManager({
  logger,
  // Write the zwave-js debug log alongside the app log so a pairing failure
  // (for example "secure join timeout") can be diagnosed from the log folder.
  logDir: process.env.LOG_DIR || path.join(path.dirname(CONFIG_PATH), 'logs'),
  logLevel: (config.devices && config.devices.zwave && config.devices.zwave.log_level) || 'debug',
  loadKeys: () => {
    const k = loadSecurityKeys(config.devices && config.devices.zwave);
    return { classic: k.classic, longRange: k.longRange };
  },
});

// Self-healing, layer 1: when the manager auto-restarts the driver after a
// stick loss or driver crash, rebuild the lock driver against the fresh
// driver instance. Deferred while a pairing session is live (the session owns
// the controller) and retried by the init-retry loop below if it fails.
zwaveManager.on('driver-restarted', () => {
  if (zwavePairing.isActive()) {
    logger.info('Z-Wave: driver restarted during a pairing session; deadbolt rebuild deferred');
    return;
  }
  bringDeadboltOnline()
    .then(() => logger.info('Deadbolt: rebuilt after driver auto-restart'))
    .catch((e) => logger.warn(`Deadbolt: rebuild after driver restart failed: ${e.message}`));
});

const zwavePairing = new ZwavePairing({
  manager: zwaveManager,
  logger,
  getZwaveConfig: () => config.devices && config.devices.zwave,
  isLockBound: () => !!lockDriver && lockDriver instanceof ZwaveLock,
  // Generate any missing S2 keys and persist them BEFORE inclusion, so a
  // crash after pairing can never orphan the lock.
  ensureKeysPersisted: async () => {
    const { generated } = ensureSecurityKeys(config.devices && config.devices.zwave);
    if (!generated) return { generated: false };
    persistZwaveMutation((cfg) => {
      cfg.devices = cfg.devices || {};
      cfg.devices.zwave = cfg.devices.zwave || {};
      cfg.devices.zwave.security_keys = Object.assign({}, cfg.devices.zwave.security_keys, generated);
    });
    logger.info('Z-Wave: generated and stored new S2 security keys (kept in config; do not delete after pairing)');
    return { generated: true };
  },
  onIncludeDone: async ({ nodeId, securityClass }) => {
    persistZwaveMutation((cfg) => {
      cfg.devices = cfg.devices || {};
      const zw = cfg.devices.zwave = cfg.devices.zwave || {};
      zw.locks = zw.locks || {};
      const lockId = (cfg.deadbolt_rules && cfg.deadbolt_rules.lock_id)
        || Object.keys(zw.locks)[0] || 'front_deadbolt';
      zw.locks[lockId] = Object.assign(
        { verify_timeout_ms: 12000, verify_retries: 1, retry_backoff_ms: 1500, poll_minutes: 20, low_battery_pct: 25 },
        zw.locks[lockId],
        // security_class persists the class the join actually granted (S2
        // Access Control for the Schlage, S0 Legacy for the Yale) so the UI
        // can show it after restarts without a live node read.
        { node_id: nodeId, security_class: securityClass || null }
      );
      zw.enabled = true;
      // buildDeadbolt() activates on deadbolt_rules; seed the minimal block so
      // the freshly-paired lock is manageable (rules stay inert without a
      // trigger_door, which the operator configures separately).
      cfg.deadbolt_rules = Object.assign({ lock_id: lockId }, cfg.deadbolt_rules);
    });
    await bringDeadboltOnline();
    logger.info(`Z-Wave: lock paired as node ${nodeId} (${securityClass || 'class unknown'}) and brought online`);
  },
  onExcludeDone: async ({ nodeId }) => {
    const zw = config.devices && config.devices.zwave;
    const locks = (zw && zw.locks) || {};
    const lockId = Object.keys(locks).find((id) => locks[id] && locks[id].node_id === nodeId);
    if (!lockId) {
      logger.info(`Z-Wave: excluded node ${nodeId} (not the configured lock; nothing to clean up)`);
      return;
    }
    persistZwaveMutation((cfg) => {
      const zwc = cfg.devices && cfg.devices.zwave;
      if (zwc && zwc.locks && zwc.locks[lockId]) zwc.locks[lockId].node_id = 0;
    });
    await bringDeadboltOnline();
    logger.info(`Z-Wave: lock (node ${nodeId}) unpaired; deadbolt disabled until a lock is paired again`);
  },
});

// Sustained-outage alerting (delivery is still gated by alerts.enabled and the
// alerts.on allowlist inside the notifier). A brief blip never alerts: the
// condition must be continuously down for the grace period. Checks return
// null when not applicable (no lock paired / not in websocket mode), which
// resets the monitor silently. Started in start(); the timers are unref'd.
function monitorAlert(type, detail) {
  logger.warn(`ALERT ${type}: ${detail}`);
  notifier.notify({ type, detail });
  broadcastEvent({ type: `alert.${type}`, actor: 'Monitor', location: '-', action: detail, success: false });
}
const lockLinkMonitor = new SustainedFlagMonitor({
  name: 'deadbolt-link',
  logger,
  graceSeconds: (config.alerts && config.alerts.offline_grace_seconds) || 60,
  check: () => {
    if (!lockDriver || typeof lockDriver.snapshot !== 'function') return null;
    return !!lockDriver.snapshot().online;
  },
  onDown: (s) => monitorAlert('deadbolt_lock_offline', `deadbolt link down for ${s}s (stick unplugged, lock unreachable, or driver error)`),
  onUp: (s) => monitorAlert('deadbolt_lock_online', `deadbolt link restored after ${s}s offline`),
});
const controllerLinkMonitor = new SustainedFlagMonitor({
  name: 'controller-link',
  logger,
  graceSeconds: (config.alerts && config.alerts.offline_grace_seconds) || 60,
  check: () => {
    if ((config.event_source && config.event_source.mode) !== 'websocket') return null;
    if (!unifiClient || typeof unifiClient.getStatus !== 'function') return null;
    const st = unifiClient.getStatus();
    if (!st || st.websocket_connected === undefined) return null;
    return !!st.websocket_connected;
  },
  onDown: (s) => monitorAlert('controller_disconnected', `UniFi WebSocket down for ${s}s: no access events are arriving, so the deadbolt will not react to entries`),
  onUp: (s) => monitorAlert('controller_reconnected', `UniFi WebSocket restored after ${s}s down`),
});

function buildDeadbolt() {
  const dbCfg = config.deadbolt_rules;
  const cascCfg = config.cascade_rules;
  if (!dbCfg && !cascCfg) return; // add-on not configured
  const zw = config.devices && config.devices.zwave;
  if (dbCfg) {
    if (zw && zw.enabled) {
      const locks = zw.locks || {};
      const lockId = dbCfg.lock_id || Object.keys(locks)[0];
      const lockCfg = Object.assign(
        { serial_path: zw.serial_path, cache_dir: zw.cache_dir },
        locks[lockId] || {}
      );
      if (!lockCfg.node_id) {
        // Enabled but nothing paired yet: normal mid-setup state, not an
        // error. The dashboard's Pair flow fills in node_id and reactivates.
        lockDriver = null;
        logger.info('Deadbolt: Z-Wave is enabled but no lock is paired yet. Use Pair New Lock in the dashboard (Configuration tab).');
      } else {
        lockDriver = new ZwaveLock(lockCfg, { logger, manager: zwaveManager });
      }
    } else if ((zw && zw.dev_fake_lock) || process.env.NODE_ENV === 'development') {
      // Fake lock is OPT-IN only. It ALWAYS reports success and drives no
      // hardware, so it must never be substituted silently in production.
      lockDriver = new FakeLock({ initial: 'locked' });
      logger.warn('Deadbolt: using in-memory FakeLock (dev/dry-run). It ALWAYS reports success and drives no hardware. Never use in production.');
    } else {
      // Configured but no real transport: fail loud, do NOT fake success.
      lockDriver = null;
      logger.error('Deadbolt configured but devices.zwave.enabled is not true and dev_fake_lock is not set. Deadbolt LOCK/RETRACT are DISABLED (cascade still active). Set devices.zwave.enabled for hardware, or devices.zwave.dev_fake_lock for dev.');
      notifier.notify({ type: 'deadbolt_no_transport', detail: 'deadbolt configured but no lock transport enabled' });
    }
  }
  // Device-origin alerts (low battery, jam) flow from the lock driver itself,
  // independent of any command in flight. A fresh driver instance is built on
  // every rebuild, so this listener never stacks.
  if (lockDriver && typeof lockDriver.on === 'function') {
    lockDriver.on('alert', (a) => monitorAlert(a.type, a.detail || ''));
  }
  deadboltController = new DeadboltController(config, {
    lockDriver,
    getUnifiClient: () => unifiClient,
    broadcaster: broadcastEvent,
    logger,
    onAlert: (a) => { logger.warn(`ALERT ${a.type}: ${JSON.stringify(a)}`); notifier.notify(a); },
  });
  logger.info(`Deadbolt add-on active (lock driver: ${lockDriver ? lockDriver.constructor.name : 'none'}, cascade rules: ${deadboltController.cascadeRules.length})`);
}

// Rebuild and activate the deadbolt after pairing/unpairing WITHOUT an app
// restart. The old lock is shut down first (which unbinds its node listeners
// but leaves the SHARED driver running), then the controller is rebuilt from
// the just-persisted config and the event taps re-applied.
async function bringDeadboltOnline() {
  if (lockDriver) {
    try { await lockDriver.shutdown(); } catch (e) { logger.warn(`Deadbolt: old lock shutdown failed: ${e.message}`); }
    lockDriver = null;
  }
  deadboltController = null;
  buildDeadbolt();
  let initOk = !!lockDriver; // a FakeLock (or no driver configured) needs no init retry
  if (lockDriver) {
    try {
      await lockDriver.init();
      logger.info('Deadbolt lock driver initialized');
    } catch (err) {
      initOk = false;
      logger.error(`Deadbolt lock driver failed to initialize: ${err.message}`);
      notifier.notify({ type: 'deadbolt_no_transport', detail: `lock driver init failed after pairing: ${err.message}` });
      scheduleDeadboltInitRetry();
    }
  }
  applyEventTaps();
  return initOk;
}

// Self-healing, layer 1b: a failed lock-driver init (serial port not there
// yet after a power outage, stick enumerating late, port briefly busy) used
// to stay dead until an app restart. Retry on a capped backoff forever; a
// success or an explicit unpair ends the loop. Skips (and re-arms) while a
// pairing session owns the controller.
let _deadboltInitRetryTimer = null;
let _deadboltInitRetryAttempt = 0;
function scheduleDeadboltInitRetry() {
  if (_deadboltInitRetryTimer) return;
  const delay = Math.min(10000 * 2 ** _deadboltInitRetryAttempt, 300000);
  _deadboltInitRetryAttempt++;
  logger.warn(`Deadbolt: lock driver init retry ${_deadboltInitRetryAttempt} in ${Math.round(delay / 1000)}s`);
  _deadboltInitRetryTimer = setTimeout(async () => {
    _deadboltInitRetryTimer = null;
    const dbCfg = config.deadbolt_rules;
    const zw = config.devices && config.devices.zwave;
    if (!dbCfg || !zw || zw.enabled !== true) return; // no longer configured
    if (zwavePairing.isActive()) { scheduleDeadboltInitRetry(); return; }
    try {
      const ok = await bringDeadboltOnline();
      if (ok) {
        _deadboltInitRetryAttempt = 0;
        logger.info('Deadbolt: lock driver recovered by init retry');
      }
    } catch (e) {
      logger.warn(`Deadbolt: init retry failed: ${e.message}`);
      scheduleDeadboltInitRetry();
    }
  }, delay);
  if (typeof _deadboltInitRetryTimer.unref === 'function') _deadboltInitRetryTimer.unref();
}

// Route every raw UniFi event to the capture recorder and the deadbolt
// controller. Re-applied whenever the UniFi client is rebuilt (reload).
function applyEventTaps() {
  if (!unifiClient || typeof unifiClient.setRawTap !== 'function') return;
  // Inert by default: only install the tap when the add-on is active, so an
  // unconfigured deployment's event path is unchanged. Clear it otherwise.
  if (!deadboltController) {
    unifiClient.setRawTap(null);
    return;
  }
  unifiClient.setRawTap((e) => {
    capture.add(e);
    try { deadboltController.observe(e); } catch (err) { logger.warn(`deadbolt observe error: ${err.message}`); }
  });
}

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

// Security response headers on every route (static, API and SSE). The CSP still
// allows 'unsafe-inline' scripts/styles because the dashboard is a single-file
// SPA with inline handlers; tightening script-src to a nonce is future work that
// depends on refactoring those out. Even so, default-src/connect-src 'self'
// block loading or exfiltrating to any other origin, object-src 'none' and
// base-uri 'self' close common injection vectors, and frame-ancestors 'none'
// prevents clickjacking. No Access-Control-Allow-Origin is ever set, so the API
// stays same-origin only; combined with header-based auth this is CSRF-safe.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  next();
});

app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Rejects replayed signed webhooks (identical body within the window). Window
// is read once at boot; changing it needs a restart.
const webhookReplayGuard = new ReplayGuard({
  windowMs: (config.event_source?.api_webhook?.replay_window_seconds || 120) * 1000,
});

// Cooldown so the subnet scan (254 probes) cannot be hammered even by an
// authenticated admin holding the button.
let lastDiscoverAt = 0;
const DISCOVER_COOLDOWN_MS = 15000;

// Atomic, owner-only (0600) config write used everywhere the config is
// persisted, so secrets never land in a world-readable file. temp+rename means
// a crash mid-write cannot truncate the live config.
function writeConfigFile(obj) {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
}

// The ONLY persistence path the pairing flow uses. Applies the mutation to the
// on-disk config (read fresh so concurrent PUT edits are not clobbered), writes
// atomically at 0600, marks the change as self-applied so ConfigSync never
// fires a reload mid-pairing, and mirrors the mutation into the in-memory
// config so getters and /api/config agree immediately.
function persistZwaveMutation(mutator) {
  let diskConfig;
  try {
    diskConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    diskConfig = JSON.parse(JSON.stringify(config));
  }
  mutator(diskConfig);
  writeConfigFile(diskConfig);
  if (configSync && typeof configSync.markConfigApplied === 'function') configSync.markConfigApplied();
  mutator(config);
}

// True only when the request carries the configured admin key (header, or the
// query param used by header-less clients). Used to gate detail on /health.
function requestHasValidAdminKey(req) {
  const expected = config.server?.admin_api_key;
  if (!expected) return false;
  const provided = req.get('x-api-key') || req.query.key;
  return timingSafeCompare(provided, expected);
}

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

  // The SSE stream is consumed by EventSource, which cannot set request
  // headers, so the key is accepted as a query param for that route ONLY.
  // This middleware is mounted at '/api', so req.path here is '/events/stream'
  // (Express strips the mount prefix); reconstruct the full path with baseUrl
  // to match. req.path excludes the query string, so the request logger below
  // never records the key. All other routes require the x-api-key header.
  const fullPath = (req.baseUrl || '') + req.path;
  const providedApiKey = req.get('x-api-key')
    || (fullPath === '/api/events/stream' ? req.query.key : undefined);
  if (!timingSafeCompare(providedApiKey, expectedApiKey)) {
    logger.warn(`Blocked unauthorized request: ${req.method} ${req.path}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

// Ensure an admin API key exists. If none is configured, generate one, persist
// it (0600, atomic temp+rename), and log it loudly. This closes the shipped
// default where an empty key silently disabled auth on every admin/test/reload
// route, without locking out an existing keyless install: it keeps running and
// becomes protected, and the operator enters the logged key in the dashboard
// once (it prompts on 401). If the config cannot be written, degrade to an
// in-memory key for this run rather than crash.
function ensureAdminApiKey() {
  if (!config.server || typeof config.server !== 'object') config.server = {};
  const existing = config.server.admin_api_key;
  if (existing && String(existing).length > 0) return;

  const key = crypto.randomBytes(24).toString('hex');
  config.server.admin_api_key = key;
  try {
    writeConfigFile(config);
    if (configSync && typeof configSync.markConfigApplied === 'function') configSync.markConfigApplied();
    logger.warn('=================================================================');
    logger.warn('No server.admin_api_key was set, so admin/test/reload routes were');
    logger.warn('unauthenticated. A key has been generated and saved to config:');
    logger.warn(`    ${key}`);
    logger.warn('Enter it in the dashboard when prompted, and send it as the');
    logger.warn('x-api-key header on API calls.');
    logger.warn('=================================================================');
  } catch (err) {
    logger.error(`Could not persist a generated admin_api_key (${err.message}). Using an in-memory key for THIS run only (it changes on restart): ${key}`);
  }
}

// Ensure /auto-lock cannot be triggered anonymously. That endpoint physically
// drives doors and is NOT behind the admin-key middleware, so it must carry its
// own shared token. If phone buttons are configured but no token is set,
// generate and persist one (0600) and log it so the operator can add it to the
// phone shortcut, rather than leaving door control open to anyone on the LAN.
function ensureAutoLockToken() {
  const cfg = config.auto_lock;
  if (!cfg || !Array.isArray(cfg.buttons) || cfg.buttons.length === 0) return;
  if (cfg.shared_token && String(cfg.shared_token).length > 0) return;

  const token = crypto.randomBytes(24).toString('hex');
  cfg.shared_token = token;
  try {
    writeConfigFile(config);
    if (configSync && typeof configSync.markConfigApplied === 'function') configSync.markConfigApplied();
    logger.warn('=================================================================');
    logger.warn('auto_lock buttons are configured but no auto_lock.shared_token was');
    logger.warn('set, so /auto-lock could be triggered by anyone on the network. A');
    logger.warn('token has been generated and saved to config:');
    logger.warn(`    ${token}`);
    logger.warn('Add ?token=<that value> to your phone shortcut URLs.');
    logger.warn('=================================================================');
  } catch (err) {
    logger.error(`Could not persist a generated auto_lock.shared_token (${err.message}). Using an in-memory token for THIS run only: ${token}`);
  }
}

// Warn when /webhook has no shared secret, so unsigned events are accepted.
function warnOnWebhookExposure() {
  const secret = config.event_source?.api_webhook?.secret;
  const mode = config.event_source?.mode || 'alarm_manager';
  if (!secret) {
    logger.warn(`/webhook accepts UNSIGNED events (no event_source.api_webhook.secret set): anyone who can reach it can inject access events and trigger unlocks.${mode === 'api_webhook' ? ' A secret is strongly recommended for api_webhook mode.' : ''} Set a secret and restrict the port to the controller.`);
  }
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
    const rawBody = req.rawBody || '';
    const expectedSignature = `sha256=${crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex')}`;
    if (!timingSafeCompare(signatureHeader, expectedSignature)) {
      logger.warn('Rejected webhook with invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    // Replay protection only matters once the signature is trusted: an attacker
    // who captured one valid signed request could otherwise resend it. An
    // identical body within the window is a replay (real events carry unique
    // ids/timestamps). Ack with 200 so a legitimate retry does not loop.
    if (webhookReplayGuard.isReplay(rawBody)) {
      logger.warn('Ignored replayed webhook (duplicate signed body within window)');
      return res.status(200).json({ status: 'ignored', reason: 'duplicate' });
    }
  }

  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    logger.warn('Webhook received empty or invalid payload');
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const eventType = payload.event || payload.type || payload.event_type || 'unknown';
  logger.info(`Webhook received: ${eventType}`);
  logger.debug(`Webhook payload: ${JSON.stringify(redactSecrets(payload)).substring(0, 500)}`);
  lastEventTime = Date.now();
  storeRawPayload('webhook', payload);
  capture.add(payload);
  if (deadboltController) {
    try { deadboltController.observe(payload); } catch (err) { logger.warn(`deadbolt observe error: ${err.message}`); }
  }

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
  // Public callers (uptime monitors, unauthenticated probes) get a minimal
  // liveness payload only. The full status, which reveals the controller host,
  // door/user counts, versions and whether the deadbolt add-on exists, is
  // returned only to a caller carrying the admin key. The dashboard fetches
  // /health through its authenticated api() helper, so it still sees detail.
  if (!requestHasValidAdminKey(req)) {
    return res.json({
      status: 'running',
      uptime_seconds: Math.floor(process.uptime())
    });
  }

  res.json({
    status: 'running',
    version: APP_VERSION,
    uptime_seconds: Math.floor(process.uptime()),
    event_source: config.event_source?.mode || 'alarm_manager',
    unifi: unifiClient.getStatus(),
    engine: rulesEngine.getStats(),
    auto_sync: configSync ? configSync.getState() : { enabled: false, interval_seconds: 0, last_run_at: null, last_change_detected_at: null, last_error: null },
    deadbolt: deadboltController ? deadboltController.getStatus() : { enabled: false },
    capture: capture.status(),
    alerts: notifier.getStatus(),
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
// Smart-deadbolt add-on endpoints (admin-gated via the /api middleware)
// ---------------------------------------------------------------------------

// Summary of the Z-Wave transport/pairing state for the dashboard. Never
// includes key material or the DSK.
function zwaveSummary() {
  const zw = (config.devices && config.devices.zwave) || {};
  const locks = zw.locks || {};
  const lockId = (config.deadbolt_rules && config.deadbolt_rules.lock_id)
    || Object.keys(locks)[0] || 'front_deadbolt';
  const nodeId = (locks[lockId] && locks[lockId].node_id) || 0;
  return {
    configured: !!zw.serial_path,
    enabled: zw.enabled === true,
    lock_id: lockId,
    node_id: nodeId,
    paired: nodeId > 0,
    manager_running: zwaveManager.isRunning(),
    pairing_active: zwavePairing.isActive(),
  };
}

// Live deadbolt + lock state for the dashboard.
app.get('/api/devices', async (req, res) => {
  const zwave = zwaveSummary();
  if (!deadboltController) return res.json({ enabled: false, devices: [], zwave });
  const status = deadboltController.getStatus();
  let liveState = status.lock;
  if (lockDriver && typeof lockDriver.getState === 'function') {
    try { liveState = await lockDriver.getState(); } catch (e) { /* fall back to snapshot */ }
  }
  res.json({ enabled: true, deadbolt: status, lock_state: liveState, zwave });
});

// ---------------------------------------------------------------------------
// In-app S2 pairing (one session at a time). The operator flow lives in the
// dashboard; these endpoints just drive the ZwavePairing state machine.
// PIN, DSK and key material are never logged.
// ---------------------------------------------------------------------------

function pairingErrorStatus(err) {
  if (err.code === 'ACTIVE') return 409;
  if (err.code === 'NO_PORT') return 400;
  if (err.code === 'BAD_PIN') return 400;
  if (err.code === 'WRONG_STATE') return 409;
  if (/not installed/i.test(err.message || '')) return 503;
  return 500;
}

app.post('/api/deadbolt/pair/start', async (req, res) => {
  try {
    // security: 'auto' (default) | 's2' | 's0'. s0 exists for locks like the
    // Yale YRD256 whose S2 bootstrap wedges and cannot fall back in-session.
    const status = await zwavePairing.startInclusion({ security: req.body && req.body.security });
    res.json({ status: 'started', mode: 'include', state: status.state, keys_generated: status.keys_generated });
  } catch (err) {
    res.status(pairingErrorStatus(err)).json({ error: err.message, state: zwavePairing.state });
  }
});

app.get('/api/deadbolt/pair/status', (req, res) => {
  res.json(zwavePairing.status());
});

// One-file support bundle: everything needed to diagnose a pairing or
// connection problem without hunting log folders. Secrets are redacted with
// the same helper GET /api/config uses; log tails are size-capped.
app.get('/api/diagnostics', (req, res) => {
  const tailFile = (file, maxBytes) => {
    try {
      const stat = fs.statSync(file);
      const start = Math.max(0, stat.size - maxBytes);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        return { file, size: stat.size, truncated: start > 0, content: buf.toString('utf8') };
      } finally { fs.closeSync(fd); }
    } catch (e) {
      return { file, error: e.message };
    }
  };
  const newestMatching = (dir, prefix) => {
    try {
      const files = fs.readdirSync(dir)
        .filter((f) => f.startsWith(prefix) && f.includes('.log'))
        .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      return files.length ? path.join(dir, files[0].f) : null;
    } catch (e) { return null; }
  };

  const logDir = process.env.LOG_DIR || path.join(path.dirname(CONFIG_PATH), 'logs');
  const appLog = newestMatching(logDir, 'access');
  const zwaveLog = newestMatching(logDir, 'zwave');

  let pkgVersion = 'unknown';
  try { pkgVersion = require('../package.json').version; } catch (e) { /* packaged path differences */ }

  res.json({
    generated_at: new Date().toISOString(),
    app_version: pkgVersion,
    platform: { os: process.platform, arch: process.arch, node: process.version },
    config: redactSecrets(JSON.parse(JSON.stringify(config))),
    unifi: {
      connection_state: (unifiClient && unifiClient.connectionState) || 'unknown',
      doors_discovered: (unifiClient && unifiClient.doors && unifiClient.doors.size) || 0,
    },
    zwave: {
      driver_running: zwaveManager.isRunning(),
      serial_path: zwaveManager.serialPath || null,
      crypto_patched: zwaveManager.cryptoPatched, // ciphers replaced by the shim (null = driver never started)
      self_heal: zwaveManager.status(), // restart loop state + lifetime auto-restarts
      pairing: zwavePairing.status(),
      last_health_check: lastDeadboltHealth, // ping/RSSI/route numbers, null until run
    },
    logs: {
      app: appLog ? tailFile(appLog, 256 * 1024) : { error: 'no access log found' },
      zwave: zwaveLog ? tailFile(zwaveLog, 512 * 1024) : { error: 'no zwave log found (the driver may never have started)' },
    },
  });
});

app.post('/api/deadbolt/pair/pin', (req, res) => {
  try {
    const r = zwavePairing.submitPin(req.body && req.body.pin);
    res.json({ status: 'ok', state: r.state });
  } catch (err) {
    res.status(pairingErrorStatus(err)).json({ error: err.message, state: zwavePairing.state });
  }
});

app.post('/api/deadbolt/pair/cancel', async (req, res) => {
  const r = await zwavePairing.cancel();
  res.json({ status: r.status, state: zwavePairing.state });
});

// Unpair. With a node_id whose node the controller reports FAILED, remove it
// directly (no exclusion sequence possible on a dead device); otherwise start
// a normal exclusion session. Either way the saved lock entry for that node
// is cleared (exclusion clears it via onExcludeDone when the node leaves).
app.post('/api/deadbolt/unpair', async (req, res) => {
  const nodeId = req.body && Number(req.body.node_id);
  if (nodeId && zwaveManager.isRunning()) {
    try {
      const ctrl = zwaveManager.controller;
      if (ctrl && typeof ctrl.isFailedNode === 'function' && await ctrl.isFailedNode(nodeId)) {
        await ctrl.removeFailedNode(nodeId);
        persistZwaveMutation((cfg) => {
          const locks = (cfg.devices && cfg.devices.zwave && cfg.devices.zwave.locks) || {};
          for (const id of Object.keys(locks)) {
            if (locks[id] && locks[id].node_id === nodeId) locks[id].node_id = 0;
          }
        });
        await bringDeadboltOnline();
        logger.info(`Z-Wave: failed node ${nodeId} removed directly (no exclusion needed)`);
        return res.json({ status: 'removed', node_id: nodeId });
      }
    } catch (err) {
      logger.warn(`Z-Wave: direct removal of node ${nodeId} failed (${err.message}); falling back to exclusion`);
    }
  }
  try {
    const status = await zwavePairing.startExclusion();
    res.json({ status: 'started', mode: 'exclude', state: status.state });
  } catch (err) {
    res.status(pairingErrorStatus(err)).json({ error: err.message, state: zwavePairing.state });
  }
});

// Paired-locks inventory for the Smart Deadbolt panel: the saved locks map
// merged with what is actually on the stick, so ghosts (on the stick but not
// saved) and orphans (saved but gone from the stick) are both visible.
// Best-effort model label straight off a live node (device-db label), for
// rows the lock driver is not bound to. Never throws.
function nodeModelLabel(node) {
  if (!node) return null;
  try {
    if (node.deviceConfig && node.deviceConfig.label) return String(node.deviceConfig.label);
  } catch (e) { /* identity not interviewed yet */ }
  return typeof node.label === 'string' && node.label ? node.label : null;
}

app.get('/api/deadbolt/locks', (req, res) => {
  const zw = (config.devices && config.devices.zwave) || {};
  const saved = zw.locks || {};
  const ctrl = zwaveManager.controller;
  const ownNodeId = ctrl && ctrl.ownNodeId != null ? ctrl.ownNodeId : null;
  const boundNodeId = (lockDriver && lockDriver.nodeId) || 0;
  const snap = lockDriver && typeof lockDriver.snapshot === 'function' ? lockDriver.snapshot() : null;
  const seen = new Set();
  const locks = [];
  for (const [lockId, lc] of Object.entries(saved)) {
    const nodeId = (lc && lc.node_id) || 0;
    if (nodeId) seen.add(nodeId);
    const bound = nodeId > 0 && nodeId === boundNodeId && snap;
    locks.push({
      lock_id: lockId,
      name: (lc && lc.name) || null,
      node_id: nodeId,
      paired: nodeId > 0,
      on_stick: !!(nodeId && zwaveManager.getNode(nodeId)),
      model: bound ? snap.model : nodeModelLabel(zwaveManager.getNode(nodeId)),
      security_class: bound ? snap.securityClass : ((lc && lc.security_class) || null),
      bolt: bound ? snap.boltState : null,
      battery: bound ? snap.battery : null,
      battery_low: bound ? !!snap.batteryLow : false,
      link_state: bound ? snap.linkState : null,
    });
  }
  const nodes = ctrl && ctrl.nodes;
  if (nodes && typeof nodes.forEach === 'function') {
    nodes.forEach((node, id) => {
      if (id === ownNodeId || seen.has(id)) return;
      locks.push({
        lock_id: null,
        name: null,
        node_id: id,
        paired: false,
        on_stick: true,
        foreign: true, // on the stick but not saved as a lock (ghost / other device)
        model: nodeModelLabel(node),
        security_class: null,
        bolt: null,
        battery: null,
        battery_low: false,
        link_state: null,
      });
    });
  }
  res.json({ locks, controller_node_id: ownNodeId, driver_running: zwaveManager.isRunning() });
});

// Measured node health (ping, RTT/RSSI/route stats, one lifeline probe).
// Fire from the dashboard to answer "why is the link dropping" with numbers.
let lastDeadboltHealth = null;
app.post('/api/deadbolt/health-check', async (req, res) => {
  if (zwavePairing.isActive()) {
    return res.status(409).json({ error: 'A pairing session is in progress' });
  }
  if (!lockDriver || typeof lockDriver.healthCheck !== 'function') {
    return res.status(503).json({ error: 'No lock driver is active (pair a lock first)' });
  }
  try {
    const result = await lockDriver.healthCheck();
    lastDeadboltHealth = Object.assign({ checked_at: new Date().toISOString() }, result);
    res.json(lastDeadboltHealth);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual test of the paired deadbolt from the dashboard. Uses the same
// verified lock()/unlock() the automation uses; UniFi is never involved.
app.post('/api/deadbolt/control', async (req, res) => {
  const action = req.body && req.body.action;
  if (action !== 'lock' && action !== 'unlock') {
    return res.status(400).json({ error: 'action must be "lock" or "unlock"' });
  }
  if (zwavePairing.isActive()) {
    return res.status(409).json({ error: 'A pairing session is in progress' });
  }
  if (!lockDriver) {
    return res.status(503).json({ error: 'No lock driver is active (pair a lock first)' });
  }
  try {
    const result = await (action === 'lock' ? lockDriver.lock('manual_test') : lockDriver.unlock('manual_test'));
    broadcastEvent({
      type: 'deadbolt.manual_test',
      actor: 'GUI Admin',
      location: 'Deadbolt',
      action: `Test ${action}`,
      success: !!(result && result.success),
    });
    res.json({ action, success: !!(result && result.success), boltState: result && result.boltState, error: (result && result.error) || null });
  } catch (err) {
    res.status(500).json({ action, success: false, error: err.message });
  }
});

// Kick off a fresh interview of the paired lock ("heal"). Recovers a node
// whose pairing-time interview died partway (field report: node presumed dead
// mid-interview left bolt/battery unknown). Fire-and-forget by design: on a
// sleeping lock the interview finishes on its next wake, and the driver's
// ready/interview-completed handlers re-seed state when it does.
app.post('/api/deadbolt/reinterview', (req, res) => {
  if (zwavePairing.isActive()) {
    return res.status(409).json({ error: 'A pairing session is in progress' });
  }
  if (!lockDriver || typeof lockDriver.reinterview !== 'function') {
    return res.status(503).json({ error: 'No lock driver is active (pair a lock first)' });
  }
  try {
    lockDriver.reinterview().then(
      () => logger.info('Deadbolt: re-interview completed'),
      (err) => logger.warn(`Deadbolt: re-interview failed: ${err.message}`)
    );
    res.json({ status: 'started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serial-port discovery so the dashboard can offer a COM-port picker for the
// Z-Wave stick. serialport ships with the bundled zwave-js; lazy-require it so
// an install without the optional dependency (or a failed native build)
// degrades to available:false instead of breaking the API.
app.get('/api/deadbolt/serial-ports', async (req, res) => {
  let SerialPort;
  try {
    ({ SerialPort } = require('serialport')); // eslint-disable-line global-require
  } catch (err) {
    return res.json({ available: false, ports: [], error: 'Z-Wave support is not installed in this build' });
  }
  try {
    const ports = await SerialPort.list();
    res.json({
      available: true,
      ports: ports.map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer || null,
        serial_number: p.serialNumber || null,
        pnp_id: p.pnpId || null,
        vendor_id: p.vendorId || null,
        product_id: p.productId || null,
        // Zooz ZST39 LR enumerates as a Silicon Labs CP210x (VID 10c4).
        likely_zwave: /10c4/i.test(p.vendorId || '') || /silicon|cp210/i.test(`${p.manufacturer || ''} ${p.pnpId || ''}`),
      })),
    });
  } catch (err) {
    res.json({ available: true, ports: [], error: err.message });
  }
});

// Labeled event capture: pin down undocumented payload shapes on-site.
// Start a capture, perform ONE gesture (e.g. a Double-Badge Override), stop,
// then GET the recorded events. Records ALL raw events, including telemetry.
app.post('/api/capture/start', (req, res) => {
  res.json(capture.start((req.body && req.body.label) || 'capture'));
});
app.post('/api/capture/stop', (req, res) => {
  res.json(capture.stop());
});
app.post('/api/capture/label', (req, res) => {
  res.json(capture.setLabel(req.body && req.body.label));
});
app.get('/api/capture', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  res.json({ status: capture.status(), events: capture.list(limit) });
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
  // Redact every secret-valued field (unifi token, webhook secret, auto-lock
  // token, admin key, any alert secret), not just the two the UI happens to
  // display. PUT strips the same placeholders back out on save.
  res.json(redactSecrets(config));
});

// ---------------------------------------------------------------------------
// PUT /api/config - Save config changes
// ---------------------------------------------------------------------------

app.put('/api/config', async (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Invalid config data' });
  }

  // Reject malformed input before it is merged and persisted.
  const validation = validateConfigUpdates(updates);
  if (!validation.ok) {
    logger.warn(`Rejected config update: ${validation.error}`);
    return res.status(400).json({ error: validation.error });
  }

  // Z-Wave settings are frozen while a pairing session runs: the session
  // persists node_id/keys itself, and a concurrent rewrite of devices.zwave
  // could clobber them or switch the serial port mid-inclusion.
  if (zwavePairing.isActive() && updates.devices && updates.devices.zwave !== undefined) {
    return res.status(409).json({ error: 'A pairing session is in progress. Finish or cancel it before changing Z-Wave settings.' });
  }

  try {
    // Read current config (with real secrets)
    const current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

    // Drop any secret still carrying the redaction placeholder, so the UI
    // echoing a redacted GET back on save cannot clobber the real value.
    stripRedactedPlaceholders(updates);

    // Never let a save clear the admin key: an empty/whitespace value would
    // disable auth on the next reload. Drop it so the stored key is kept.
    if (updates.server && typeof updates.server === 'object'
        && updates.server.admin_api_key !== undefined
        && String(updates.server.admin_api_key).trim() === '') {
      delete updates.server.admin_api_key;
    }

    // Deep merge updates (only allow specific safe keys)
    const safeKeys = ['unlock_rules', 'doorbell_rules', 'event_source', 'logging', 'server', 'unifi', 'resolver', 'doors', 'backup', 'watchdog', 'auto_lock', 'auto_sync', 'devices', 'deadbolt_rules', 'cascade_rules', 'alerts', 'setup_wizard'];

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

    writeConfigFile(current);
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
  // Cooldown: a full-subnet scan is expensive, so rate-limit it even for an
  // authenticated admin (e.g. an impatient double-click or a stuck poller).
  const now = Date.now();
  const sinceLast = now - lastDiscoverAt;
  if (sinceLast < DISCOVER_COOLDOWN_MS) {
    const retryAfter = Math.ceil((DISCOVER_COOLDOWN_MS - sinceLast) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Discovery ran recently, please wait', retry_after_seconds: retryAfter });
  }
  lastDiscoverAt = now;

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

  // Fail secure: this endpoint drives doors and is not behind the admin-key
  // middleware, so it must have its own token. ensureAutoLockToken() generates
  // one at boot whenever buttons exist, so an empty token here should be
  // unreachable; refuse anyway rather than act anonymously.
  if (!cfg.shared_token || String(cfg.shared_token).length === 0) {
    logger.warn(`Auto-lock: refused "${button.id}" from ${sourceIp} - no shared_token configured`);
    return res.status(401).json({ success: false, message: 'Auto-lock token not configured' });
  }

  if (!timingSafeCompare(req.query.token || '', cfg.shared_token)) {
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
    // reloadServices reassigns the global config; make sure a reload can never
    // leave the admin key empty (auth disabled) or auto-lock tokenless.
    ensureAdminApiKey();
    ensureAutoLockToken();
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

// Apply deadbolt_rules / cascade_rules edits live, REUSING the running lock
// driver (no Z-Wave reconnect). Called from reloadServices when the rules
// signature changed. Removing all rules detaches the controller; adding rules
// when a paired lock exists but no driver was built yet takes the full
// activation path (safe: the driver is not running, so nothing reconnects).
async function maybeRebuildDeadboltRules(oldSig) {
  const newSig = JSON.stringify([config.deadbolt_rules, config.cascade_rules]);
  if (newSig === oldSig) return;
  if (!config.deadbolt_rules && !config.cascade_rules) {
    deadboltController = null;
    applyEventTaps();
    logger.info('Deadbolt rules removed: controller detached (lock driver untouched)');
    return;
  }
  const zw = config.devices && config.devices.zwave;
  if (!lockDriver && config.deadbolt_rules && zw && zw.enabled) {
    await bringDeadboltOnline();
    return;
  }
  deadboltController = new DeadboltController(config, {
    lockDriver,
    getUnifiClient: () => unifiClient,
    broadcaster: broadcastEvent,
    logger,
    onAlert: (a) => { logger.warn(`ALERT ${a.type}: ${JSON.stringify(a)}`); notifier.notify(a); },
  });
  applyEventTaps();
  logger.info(`Deadbolt rules updated live (cascade rules: ${deadboltController.cascadeRules.length}); lock driver untouched`);
}

async function reloadServices(newConfig) {
  const settingsChanged = controllerOrSourceChanged(config, newConfig);
  const degraded = isEventSourceDegraded();
  const fullReload = settingsChanged || degraded;
  const oldRulesSig = JSON.stringify([config.deadbolt_rules, config.cascade_rules]);

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
    notifier = new Notifier(config.alerts || {}, { logger }); // pick up alert config changes
    applyEventTaps(); // re-attach capture + deadbolt observers to the new client

    // Note: the deadbolt LOCK DRIVER is intentionally not rebuilt here (that
    // would reconnect the Z-Wave stick); rule changes rebuild only the
    // controller via maybeRebuildDeadboltRules below. The shared zwaveManager
    // and zwavePairing session likewise live outside this function by design,
    // so a config reload can never tear down the driver or a pairing session
    // mid-flight.
    await maybeRebuildDeadboltRules(oldRulesSig);

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
  const alertsChanged = JSON.stringify(config.alerts || {}) !== JSON.stringify(newConfig.alerts || {});
  config = newConfig;
  if (alertsChanged) notifier = new Notifier(config.alerts || {}, { logger }); // alert edits apply without a full reload
  startWatchdog();
  await maybeRebuildDeadboltRules(oldRulesSig);

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

  // Close the "empty key disables auth" default before the server accepts
  // requests, ensure /auto-lock has a token, and warn if the webhook is open.
  ensureAdminApiKey();
  ensureAutoLockToken();
  warnOnWebhookExposure();

  const port = config.server?.port || 3000;
  const host = config.server?.host || '0.0.0.0';
  if (host !== '127.0.0.1' && host !== 'localhost') {
    logger.warn(`Server is bound to ${host} (reachable on the LAN). Admin routes require the API key; restrict port ${port} with a host firewall to admin hosts, or bind 127.0.0.1 for WebSocket-only setups that do not receive inbound webhooks.`);
  }

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

  // Start periodic config backup — check daily, create if overdue.
  // Also runs once shortly after startup so desktop/Electron sessions
  // (which rarely stay up for a full 24h) still get scheduled backups.
  // The `daysSinceLast >= backupIntervalDays` guard prevents duplicate
  // backups when the app is restarted multiple times in the same day.
  const backupIntervalDays = config.backup?.interval_days || 30;
  const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // check once per day
  const STARTUP_CHECK_DELAY_MS = 30 * 1000; // wait 30s after boot
  const runScheduledBackupCheck = () => {
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
  };
  setTimeout(runScheduledBackupCheck, STARTUP_CHECK_DELAY_MS);
  setInterval(runScheduledBackupCheck, CHECK_INTERVAL_MS);
  logger.info(`Config backup schedule: every ${backupIntervalDays} days (checked on startup + daily)`);

  // Bring up the smart-deadbolt add-on (inert unless configured), then tap the
  // event stream before the event source connects.
  buildDeadbolt();
  if (lockDriver) {
    try {
      await lockDriver.init();
      logger.info('Deadbolt lock driver initialized');
    } catch (err) {
      logger.error(`Deadbolt lock driver init failed: ${err.message}. Retrying automatically; cascade unlock is unaffected.`);
      scheduleDeadboltInitRetry();
    }
  }
  applyEventTaps();

  startEventSource();
  startWatchdog();

  // Sustained-outage monitors (lock link + controller WebSocket). Checks
  // no-op when not applicable; the notifier gates actual delivery.
  lockLinkMonitor.start();
  controllerLinkMonitor.start();

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
  const gracefulExit = async (sig) => {
    logger.info(sig);
    if (configSync) configSync.stop();
    try {
      // Stop an active pairing session first (bounded) so the stick is not
      // left in inclusion mode across a restart.
      if (zwavePairing.isActive()) await Promise.race([
        zwavePairing.cancel('shutdown'),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    } catch (e) { /* ignore teardown errors */ }
    try {
      // Await the Z-Wave lock teardown (bounded) so listeners unbind cleanly.
      if (lockDriver) await Promise.race([
        Promise.resolve(lockDriver.shutdown()),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    } catch (e) { /* ignore teardown errors */ }
    try {
      // The shared driver session is owned here; destroy it last (bounded).
      if (zwaveManager.isRunning()) await Promise.race([
        zwaveManager.stop(),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    } catch (e) { /* ignore teardown errors */ }
    try { unifiClient.shutdown(); } catch (e) { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => gracefulExit('SIGTERM'));
  process.on('SIGINT', () => gracefulExit('SIGINT'));
  process.on('uncaughtException', (err) => { logger.error(`Uncaught: ${err.message}\n${err.stack}`); });
  process.on('unhandledRejection', (reason) => { logger.error(`Unhandled rejection: ${reason}`); });

  start().catch(err => { logger.error(`Fatal: ${err.message}`); process.exit(1); });
}
