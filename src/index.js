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
const lockCatalog = require('./drivers/lock-catalog');
const { ZwavePairing } = require('./drivers/zwave-pairing');
const { loadSecurityKeys, ensureSecurityKeys } = require('./drivers/zwave-keys');
const { SustainedFlagMonitor } = require('./alert-monitors');
const deadboltRules = require('./deadbolt-rules');
const doorFlows = require('./door-flows');
const { planUnifiPinPush, markStaleAfterPush, recordUnifiPin } = require('./user-code-sync');
const { removeLockEntry, pruneGhostLocks } = require('./lock-cleanup');
const keypadUsers = require('./keypad-users');
const accessGating = require('./access-gating');
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
  const parsed = JSON.parse(raw);
  // Migrate a legacy flat deadbolt_rules block to the per-lock map shape on
  // EVERY load (startup, ConfigSync reload, hand-edited file), so the rest
  // of the app only ever sees the map. Persisted once at startup below.
  const migrated = deadboltRules.toMapShape(
    parsed.deadbolt_rules,
    parsed.devices && parsed.devices.zwave && parsed.devices.zwave.locks
  );
  if (migrated.changed) parsed.deadbolt_rules = migrated.rules;
  // Door-flow spine: fold {deadbolt_rules, cascade_rules, unlock_rules,
  // doorbell_rules} into the trigger-shaped door_flows on EVERY load. From here
  // the live app reads ONLY door_flows; the legacy keys exist transitionally
  // for old readers (GET projects them) and are deleted from disk at startup.
  const flowsResult = doorFlows.migrateToTriggers(parsed, parsed.devices && parsed.devices.zwave && parsed.devices.zwave.locks);
  parsed.door_flows = flowsResult.flows;
  // One source of truth in memory: the legacy keys are consumed above and
  // must never be read again (GET /api/config serves a computed projection).
  delete parsed.deadbolt_rules;
  delete parsed.cascade_rules;
  delete parsed.unlock_rules;
  delete parsed.doorbell_rules;
  return parsed;
}

// The rules engine runs a derived, read-only PROJECTION of the automation
// (unlock_rules / doorbell_rules) so the simulate + preflight endpoints keep
// working off the door-flow triggers. It is NOT fed live events any more (the
// deadbolt controller owns live entry + doorbell + cascade execution), so it
// never double-fires.
function rulesEngineConfig(cfg) {
  const proj = doorFlows.legacyProjection(cfg.door_flows || {});
  return Object.assign({}, cfg, { unlock_rules: proj.unlock_rules, doorbell_rules: proj.doorbell_rules });
}

let config = loadConfig();

// Migrate the legacy flat deadbolt_rules shape ON DISK to the per-lock map,
// so backups/diagnostics and external readers see the shape the app uses and
// a later PUT never deep-merges a map update into a flat file. loadConfig
// already migrates IN MEMORY on every load; this canonicalizes the file.
// Runs at startup AND after any path that can drop a legacy file on disk (a
// backup restore, a hand-edit). Best-effort: a failure leaves the in-memory
// (already-migrated) config authoritative. Pass markApplied=true once
// configSync exists so the write does not trigger a redundant reload.
function migrateConfigFileOnDisk(markApplied) {
  try {
    const disk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const diskMigrated = deadboltRules.toMapShape(
      disk.deadbolt_rules,
      disk.devices && disk.devices.zwave && disk.devices.zwave.locks
    );
    if (!diskMigrated.changed) return false;
    disk.deadbolt_rules = diskMigrated.rules;
    writeConfigFile(disk);
    if (markApplied && configSync && typeof configSync.markConfigApplied === 'function') {
      configSync.markConfigApplied();
    }
    logger.info('Config: migrated deadbolt_rules to the per-lock map shape (multi-lock support)');
    return true;
  } catch (e) {
    logger.warn(`Config: deadbolt_rules migration skipped (${e.message}); continuing with the in-memory shape`);
    return false;
  }
}

// One-time at startup (configSync does not exist yet, so no markApplied).
migrateConfigFileOnDisk(false);

// Canonicalize the door-centric shape ON DISK: write door_flows and DELETE
// the legacy deadbolt_rules / cascade_rules keys, so there is exactly ONE
// persisted source of truth (the flat-vs-map era proved dual shapes drift).
// Mirrors migrateConfigFileOnDisk: best-effort, runs at startup and after a
// backup restore (a restored pre-redesign backup migrates forward here).
function migrateDoorFlowsOnDisk(markApplied) {
  try {
    const disk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const hadLegacy = disk.deadbolt_rules !== undefined || disk.cascade_rules !== undefined
      || disk.unlock_rules !== undefined || disk.doorbell_rules !== undefined;
    // migrateToTriggers reports changed=true when a flat door_flows is upgraded,
    // so a single call covers both the legacy-keys and flat-door_flows cases.
    const result = doorFlows.migrateToTriggers(disk, disk.devices && disk.devices.zwave && disk.devices.zwave.locks);
    if (!result.changed && !hadLegacy) return false;
    // One-time safety: snapshot the pre-spine config before the first rewrite
    // (the app does not otherwise back up on save).
    try { createBackup(CONFIG_PATH, BACKUP_DIR); } catch (e) { logger.warn(`Config: pre-migration backup skipped (${e.message})`); }
    disk.door_flows = result.flows;
    delete disk.deadbolt_rules;
    delete disk.cascade_rules;
    delete disk.unlock_rules;
    delete disk.doorbell_rules;
    writeConfigFile(disk);
    if (markApplied && configSync && typeof configSync.markConfigApplied === 'function') {
      configSync.markConfigApplied();
    }
    for (const line of result.logs) logger.info(`Config: ${line}`);
    logger.info(`Config: migrated automation rules to the door-flow spine (${Object.keys(result.flows).length} door(s))`);
    return true;
  } catch (e) {
    logger.warn(`Config: door_flows migration skipped (${e.message}); continuing with the in-memory shape`);
    return false;
  }
}
migrateDoorFlowsOnDisk(false);

// Remove lock entries an earlier version left behind after an unpair
// (node_id 0): they render as un-actionable "not paired" ghosts and keep a
// dead automation rule alive. Runs against BOTH the in-memory config and the
// file, best-effort (a failure leaves the in-memory prune authoritative).
function pruneGhostLocksOnDisk() {
  const pruned = pruneGhostLocks(config);
  if (!pruned.length) return;
  try {
    const disk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    pruneGhostLocks(disk);
    writeConfigFile(disk);
  } catch (e) {
    logger.warn(`Config: ghost lock prune not persisted (${e.message}); in-memory config is clean`);
  }
  for (const id of pruned) {
    logger.info(`Config: removed unpaired ghost lock entry "${id}" (left behind by an earlier unpair)`);
  }
}
pruneGhostLocksOnDisk();

// ---------------------------------------------------------------------------
// Initialize components
// ---------------------------------------------------------------------------

let unifiClient = new UniFiClient(config);
wireUnifiClientCallbacks(unifiClient);
let resolver = new Resolver(config, unifiClient);
// The rules engine runs on the derived projection (simulate/preflight only);
// live entry/doorbell/cascade execution belongs to the deadbolt controller.
let rulesEngine = new RulesEngine(rulesEngineConfig(config), unifiClient, resolver);
let configSync = null;  // initialized in start() once Express + UniFi client are up
// Case-insensitive viewer-device -> group map, merged from every doorbell
// trigger, used to resolve the answering viewer when a doorbell has no actor id.
let _viewerToGroupCI = {};

// ---------------------------------------------------------------------------
// Smart-deadbolt add-on (Phase 2). Entirely inert unless deadbolt_rules or
// cascade_rules are configured, so existing deployments are unaffected.
// ---------------------------------------------------------------------------
const captureDir = process.env.CAPTURE_DIR || path.join(path.dirname(CONFIG_PATH), 'captures');
const capture = new CaptureSession({ dir: captureDir });
let notifier = new Notifier(config.alerts || {}, { logger });
// Multi-lock core: one driver per PAIRED lock (all sharing the one Z-Wave
// manager/stick), one controller per AUTOMATED lock (a deadbolt_rules entry),
// and one dedicated controller carrying only the cascade rules so they never
// double-fire when several locks are automated.
let lockDrivers = new Map();          // lockId -> ZwaveLock | FakeLock
let deadboltControllers = new Map();  // lockId -> DeadboltController
let cascadeController = null;         // cascade_rules only (lockDriver: null)
// Active-lock aliases (the first automated lock, else the first paired):
// endpoints and legacy single-lock paths keep working through these until
// they carry an explicit lock_id.
let lockDriver = null;
let deadboltController = null;
// Set by /api/deadbolt/reinterview so the driver's 'interview-completed'
// event can announce the OPERATOR-requested re-interview finishing (the
// refreshInfo() promise resolves when the interview is merely re-queued).
// A Set of pending lock ids (not a single flag): with several locks the
// first interview to complete anywhere must not claim another lock's request.
let _reinterviewRequested = new Set();
// Lock ids whose driver.init() is currently failing (self-heal retries just
// these, never the healthy ones), and the subset we have already alerted for
// (so a persistent failure does not re-email every retry cycle; edge-triggered
// per lock, re-armed when the lock recovers).
let _failedInitLocks = new Set();
let _alertedInitLocks = new Set();

// Shared Z-Wave plumbing: ONE driver session per serial port, borrowed by both
// the lock driver and the pairing flow so they never contend for the port.
// Live getters keep these valid across config reloads.
const zwaveManager = new ZwaveManager({
  logger,
  // Write the zwave-js debug log alongside the app log so a pairing failure
  // (for example "secure join timeout") can be diagnosed from the log folder.
  logDir: process.env.LOG_DIR || path.join(path.dirname(CONFIG_PATH), 'logs'),
  // Persist the zwave-js network cache alongside the config/logs. zwave-js's
  // own default (<cwd>/cache) lands inside the install dir on packaged
  // builds and is wiped by every update; a lost cache forces a full
  // "initial" interview, which clears every keypad code on the lock (field
  // diagnostics 2026-07). devices.zwave.cache_dir still wins when set.
  defaultCacheDir: process.env.ZWAVE_CACHE_DIR || path.join(path.dirname(CONFIG_PATH), 'zwave-cache'),
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
  isLockBound: () => Array.from(lockDrivers.values()).some((d) => d instanceof ZwaveLock),
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
  onIncludeDone: async ({ nodeId, securityClass, lockId: chosenId, modelKey, name }) => {
    // Resolve the target lock id. Add Deadbolt supplies an explicit id so a
    // second lock is stored under its OWN key; without one we keep today's
    // single-lock behavior (the rules' lock id, else the first saved, else
    // the default). A chosen id that collides with an existing DIFFERENT node
    // is de-duplicated so pairing never silently clobbers another lock.
    let resolvedId = null;
    persistZwaveMutation((cfg) => {
      cfg.devices = cfg.devices || {};
      const zw = cfg.devices.zwave = cfg.devices.zwave || {};
      zw.locks = zw.locks || {};
      let lockId = chosenId
        || doorFlows.automatedLockIdsFromFlows(cfg.door_flows)[0]
        || Object.keys(zw.locks)[0] || 'front_deadbolt';
      // Never overwrite a different, still-paired lock that happens to share
      // the requested id: pick a free suffix instead.
      if (chosenId && zw.locks[lockId] && zw.locks[lockId].node_id
          && zw.locks[lockId].node_id !== nodeId) {
        let n = 2;
        while (zw.locks[`${lockId}_${n}`] && zw.locks[`${lockId}_${n}`].node_id
               && zw.locks[`${lockId}_${n}`].node_id !== nodeId) n++;
        lockId = `${lockId}_${n}`;
      }
      resolvedId = lockId;
      const model = modelKey && lockCatalog.profileForKey(modelKey);
      zw.locks[lockId] = Object.assign(
        { verify_timeout_ms: 12000, verify_retries: 1, retry_backoff_ms: 1500, poll_minutes: 20, low_battery_pct: 25 },
        zw.locks[lockId],
        // security_class persists the class the join actually granted so the
        // UI shows it after restarts without a live node read. manufacturer /
        // model_key record the operator's catalog choice for the locks table
        // and the per-model exclude/reset guidance.
        {
          node_id: nodeId,
          security_class: securityClass || null,
          name: name || (zw.locks[lockId] && zw.locks[lockId].name) || null,
          manufacturer: (model && model.manufacturer) || (zw.locks[lockId] && zw.locks[lockId].manufacturer) || null,
          model_key: modelKey || (zw.locks[lockId] && zw.locks[lockId].model_key) || null,
        }
      );
      zw.enabled = true;
      // Door-centric model: automation is a door's retract edge, created in
      // the Door Flows editor. A freshly paired lock is manually controllable
      // immediately (zw.enabled gates that) and gets wired to a door when the
      // operator adds it to a flow - no empty placeholder entry to seed.
    });
    await bringDeadboltOnline();
    logger.info(`Z-Wave: lock paired as node ${nodeId} (${securityClass || 'class unknown'}) under "${resolvedId}" and brought online`);
    // One PIN per user: seed the new lock with every saved user's PIN so the
    // owner never re-enters codes per lock. Fire-and-forget: the writes wait
    // for the pairing session to fully end and the interview to reveal the
    // User Code capability, which can take minutes on a battery lock.
    provisionUserCodesOnNewLock(resolvedId).catch((e) =>
      logger.warn(`Deadbolt: auto-provision of keypad codes on "${resolvedId}" failed: ${e.message}`));
  },
  onExcludeDone: async ({ nodeId }) => {
    const zw = config.devices && config.devices.zwave;
    const locks = (zw && zw.locks) || {};
    const lockId = Object.keys(locks).find((id) => locks[id] && locks[id].node_id === nodeId);
    if (!lockId) {
      logger.info(`Z-Wave: excluded node ${nodeId} (not the configured lock; nothing to clean up)`);
      return;
    }
    // The lock is gone from the network, so its config entry AND its
    // automation rule go with it: a ghost row would sit in the Paired locks
    // table and the automation dropdown with no working action. Capture the
    // label before the entry is deleted.
    const label = lockLabel(lockId);
    persistZwaveMutation((cfg) => { removeLockEntry(cfg, lockId); });
    await bringDeadboltOnline();
    const remaining = Object.values((config.devices && config.devices.zwave && config.devices.zwave.locks) || {})
      .filter((l) => l && l.node_id > 0).length;
    logger.info(`Z-Wave: "${label}" (node ${nodeId}) unpaired and removed from the config; ${remaining} paired lock(s) remain`);
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
// Names of locks currently offline, for the link alert detail. Empty = all up.
function offlineLockNames() {
  const names = [];
  for (const [lockId, driver] of lockDrivers) {
    if (typeof driver.snapshot !== 'function') continue;
    if (!driver.snapshot().online) names.push(lockLabel(lockId));
  }
  return names;
}
const lockLinkMonitor = new SustainedFlagMonitor({
  name: 'deadbolt-link',
  logger,
  graceSeconds: (config.alerts && config.alerts.offline_grace_seconds) || 60,
  // One monitor across all locks: down when ANY paired lock's link is down,
  // with the offenders named in the alert. (A second lock failing during an
  // existing outage extends it rather than re-alerting.)
  check: () => {
    if (!lockDrivers.size) return null;
    return offlineLockNames().length === 0;
  },
  onDown: (s) => monitorAlert('deadbolt_lock_offline', `deadbolt link down for ${s}s (${offlineLockNames().join(', ') || 'lock'}: stick unplugged, lock unreachable, or driver error)`),
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

// Friendly display label for a lock (its saved name, else its id).
function lockLabel(lockId) {
  const locks = (config.devices && config.devices.zwave && config.devices.zwave.locks) || {};
  return (locks[lockId] && locks[lockId].name) || lockId;
}

// Per-driver event wiring: device-origin alerts (low battery, jam), the
// late-confirm correction, informational device notes, keypad attribution,
// and truthful interview completion. Fresh driver instances are built on
// every rebuild, so listeners never stack. Every line names the lock so two
// locks stay distinguishable in logs and the event feed.
function wireDriverEvents(lockId, driver) {
  if (!driver || typeof driver.on !== 'function') return;
  const label = lockLabel(lockId);
  driver.on('alert', (a) => monitorAlert(a.type, `${label}: ${a.detail || ''}`));
  driver.on('late-confirm', (e) => {
    logger.info(`Deadbolt ${label}: ${e.action} confirmed late (${Math.round((e.after_ms || 0) / 1000)}s after the wait window)`);
    broadcastEvent({
      type: 'deadbolt.late_confirm',
      actor: 'Deadbolt Controller',
      location: label,
      action: `${e.action} completed late; bolt is now ${e.boltState}`,
      success: true,
    });
  });
  driver.on('device-note', (n) => {
    logger.info(`Deadbolt ${label}: device note: ${n.detail || n.code}`);
    broadcastEvent({
      type: 'deadbolt.device_note',
      actor: 'Deadbolt Controller',
      location: label,
      action: n.detail || n.code || 'device note',
      success: true,
    });
  });
  driver.on('keypad-activity', (e) => {
    const entry = savedUserCodes(lockId)[String(e.slot)];
    const who = (entry && entry.name) || `slot ${e.slot}, unassigned`;
    logger.info(`Deadbolt ${label}: keypad ${e.action} (slot ${e.slot}${entry && entry.name ? `, ${entry.name}` : ''})`);
    broadcastEvent({
      type: 'deadbolt.keypad',
      actor: entry && entry.name ? entry.name : 'Keypad',
      location: label,
      action: `Keypad ${e.action} by ${who}${entry && entry.name ? ` (slot ${e.slot})` : ''}`,
      success: true,
    });
  });
  driver.on('interview-completed', () => {
    logger.info(`Deadbolt ${label}: interview completed; bolt and battery readings are fresh`);
    // Announce completion only for the lock whose re-interview was actually
    // requested (delete returns true only for the pending id), so a different
    // lock finishing an interview cannot claim (and clear) this one's request.
    if (_reinterviewRequested.delete(lockId)) {
      broadcastEvent({
        type: 'deadbolt.reinterview',
        actor: 'Deadbolt Controller',
        location: label,
        action: 'Re-interview completed; readings refreshed',
        success: true,
      });
    }
  });
  // The driver noticed an interview wiped saved keypad codes (zwave-js clears
  // all codes on a cache-loss initial interview) and rewrote them. Surface
  // the cause-and-effect pair in the event feed so future diagnostics show
  // why codes changed without anyone touching the dashboard.
  driver.on('user-codes-restored', (e) => {
    const detail = `Restored ${e.restored} keypad code(s) wiped by a node re-interview`
      + (e.kept ? `, ${e.kept} intact` : '')
      + (e.failed ? `; ${e.failed} FAILED (use Rewrite Codes to Lock)` : '');
    logger.warn(`Deadbolt ${label}: ${detail}`);
    broadcastEvent({
      type: 'deadbolt.user_code',
      actor: 'Deadbolt Controller',
      location: label,
      action: detail,
      success: e.failed === 0,
    });
  });
  // A battery lock that could not confirm a code clear left a pending_clears
  // marker. When the node next wakes, finish that clear so a revoked PIN cannot
  // keep opening the door.
  driver.on('node-awake', () => {
    withKeypadLock(() => retryPendingClears(lockId))
      .catch((e) => logger.debug(`Deadbolt ${label}: pending-clear retry on wake failed: ${e.message}`));
  });
}

// Controllers only (no driver teardown): one per automated lock with ITS
// rules slice and NO cascade rules, plus one dedicated cascade controller so
// cascades fire exactly once regardless of how many locks are automated.
// Reused by the live rules-reload path, which must not touch the drivers.
// Controllers now hold timers (per-edge relock) and driver listeners, so the
// OLD instances MUST be destroyed on every rebuild or they leak and can
// double-fire a lock after a rules reload.
function destroyDeadboltControllers() {
  for (const [, ctl] of deadboltControllers) {
    try { if (typeof ctl.destroy === 'function') ctl.destroy(); } catch (e) { /* teardown is best-effort */ }
  }
  if (cascadeController && typeof cascadeController.destroy === 'function') {
    try { cascadeController.destroy(); } catch (e) { /* teardown is best-effort */ }
  }
  deadboltControllers = new Map();
  cascadeController = null;
}

// Resolve the acting user's group for a scoped trigger. Tries the resolver
// (by actor id) first, then falls back to the doorbell viewer-device map (an
// answered doorbell often carries no actor id). Returns null when unresolved.
function resolveGroupForEvent(info) {
  const i = info || {};
  let group = null;
  if (i.actorId) {
    const r = resolver.resolve(i.actorId);
    group = (r && r.group) || null;
  }
  if (!group) {
    const a = i.actorName ? String(i.actorName).trim().toLowerCase() : '';
    const d = i.deviceName ? String(i.deviceName).trim().toLowerCase() : '';
    group = (a && _viewerToGroupCI[a]) || (d && _viewerToGroupCI[d]) || null;
  }
  return group;
}

function buildDeadboltControllers() {
  destroyDeadboltControllers();
  // Refresh the merged viewer->group map from EVERY doorbell trigger, including
  // retract-only ones (unlockRulesFromFlows drops triggers with no unlock, which
  // would lose the viewer map for a doorbell that only retracts a deadbolt).
  _viewerToGroupCI = {};
  for (const flow of Object.values(config.door_flows || {})) {
    for (const trig of doorFlows.triggersOf(flow)) {
      if (trig.type === 'doorbell' && trig.doorbell && trig.doorbell.viewer_to_group) {
        for (const [k, v] of Object.entries(trig.doorbell.viewer_to_group)) {
          if (typeof k === 'string' && v) _viewerToGroupCI[k.trim().toLowerCase()] = v;
        }
      }
    }
  }
  const deps = {
    getUnifiClient: () => unifiClient,
    broadcaster: broadcastEvent,
    logger,
    resolveGroup: resolveGroupForEvent,
    onAlert: (a) => { logger.warn(`ALERT ${a.type}: ${JSON.stringify(a)}`); notifier.notify(a); },
  };
  // One controller per lock referenced by any door's retract edges, fed the
  // full list of door->lock edges (each carrying its own after-unlock, trigger
  // type and scope) so several doors can drive one deadbolt differently.
  for (const lockId of doorFlows.automatedLockIdsFromFlows(config.door_flows)) {
    const edges = doorFlows.edgesForLock(config.door_flows, lockId);
    const controller = new DeadboltController(
      Object.assign({}, config, { edges, cascade_rules: { rules: [] } }),
      Object.assign({ lockDriver: lockDrivers.get(lockId) || null }, deps)
    );
    if (controller.enabled) deadboltControllers.set(lockId, controller);
  }
  // One dedicated controller (lockDriver: null, never a lock command) owns every
  // scoped/unscoped UNLOCK action across all triggers (entry cascades, group
  // unlocks and doorbell unlocks), so they never double-fire when several locks
  // are automated.
  const cascadeRules = doorFlows.unlockRulesFromFlows(config.door_flows);
  if (cascadeRules.length) {
    cascadeController = new DeadboltController(
      Object.assign({}, config, { deadbolt_rules: undefined, cascade_rules: { rules: cascadeRules } }),
      Object.assign({ lockDriver: null }, deps)
    );
  }
  // Active-lock aliases for endpoints that do not carry a lock_id (yet).
  const activeId = activeLockId(config);
  lockDriver = (activeId && lockDrivers.get(activeId)) || lockDrivers.values().next().value || null;
  deadboltController = (activeId && deadboltControllers.get(activeId))
    || deadboltControllers.values().next().value || cascadeController || null;
}

// The add-on is active when a lock transport is enabled OR any rules exist.
// Drivers are built from zw.enabled alone (every paired lock is controllable
// even with no automation), so gates that gate on deadbolt_rules would wrongly
// disable the self-heal retry for an enabled-but-rules-less config.
function shouldRunDeadbolt() {
  const zw = config.devices && config.devices.zwave;
  return !!((config.door_flows && Object.keys(config.door_flows).length) || (zw && zw.enabled === true));
}

function buildDeadbolt() {
  const flowLockIds = doorFlows.automatedLockIdsFromFlows(config.door_flows);
  const zw = config.devices && config.devices.zwave;
  const zwEnabled = !!(zw && zw.enabled);
  // Inert unless something is configured: a paired/enabled Z-Wave setup,
  // automation rules, or cascades.
  if (!shouldRunDeadbolt()) return;

  if (zwEnabled) {
    // One driver per PAIRED lock, all sharing the one Z-Wave manager. Every
    // paired lock is immediately controllable (test buttons, auto-relock,
    // PIN codes) whether or not it is wired to a trigger door.
    const locks = zw.locks || {};
    const pairedIds = Object.keys(locks).filter((id) => locks[id] && locks[id].node_id > 0);
    for (const lockId of pairedIds) {
      const lockCfg = Object.assign(
        { serial_path: zw.serial_path, cache_dir: zw.cache_dir, id: lockId },
        locks[lockId]
      );
      const driver = new ZwaveLock(lockCfg, {
        logger,
        manager: zwaveManager,
        // Always-fresh reads: the cfg snapshot above goes stale after PIN
        // saves and config reloads. lockId is captured per driver, so a
        // multi-lock interview restores only its own lock's codes.
        getUserCodes: () => savedUserCodes(lockId),
        isPairingActive: () => zwavePairing.isActive(),
      });
      lockDrivers.set(lockId, driver);
      wireDriverEvents(lockId, driver);
    }
    if (!pairedIds.length) {
      // Enabled but nothing paired yet: normal mid-setup state, not an
      // error. The dashboard's Pair flow fills in node_id and reactivates.
      logger.info('Deadbolt: Z-Wave is enabled but no lock is paired yet. Use Pair New Lock in the dashboard (Configuration tab).');
    }
  } else if ((zw && zw.dev_fake_lock) || (flowLockIds.length && process.env.NODE_ENV === 'development')) {
    // Fake locks are OPT-IN only. They ALWAYS report success and drive no
    // hardware, so they must never be substituted silently in production.
    // One instance per automated lock so dev-mode multi-lock testing is real;
    // a dev config with no flows yet still gets one bootstrap fake so the
    // Door Flows editor has a lock to wire.
    for (const lockId of (flowLockIds.length ? flowLockIds : ['fake_deadbolt'])) {
      const driver = new FakeLock({ initial: 'locked' });
      lockDrivers.set(lockId, driver);
      wireDriverEvents(lockId, driver);
    }
    logger.warn('Deadbolt: using in-memory FakeLock(s) (dev/dry-run). They ALWAYS report success and drive no hardware. Never use in production.');
  } else if (flowLockIds.length) {
    // Configured but no real transport: fail loud, do NOT fake success.
    logger.error('Deadbolt configured but devices.zwave.enabled is not true and dev_fake_lock is not set. Deadbolt LOCK/RETRACT are DISABLED (cascade still active). Set devices.zwave.enabled for hardware, or devices.zwave.dev_fake_lock for dev.');
    notifier.notify({ type: 'deadbolt_no_transport', detail: 'deadbolt configured but no lock transport enabled' });
  }

  buildDeadboltControllers();
  logger.info(`Deadbolt add-on active (drivers: ${lockDrivers.size}, automated: ${deadboltControllers.size}, cascade rules: ${cascadeController ? cascadeController.cascadeRules.length : 0})`);
}

// Rebuild and activate the deadbolt after pairing/unpairing WITHOUT an app
// restart. The old lock is shut down first (which unbinds its node listeners
// but leaves the SHARED driver running), then the controller is rebuilt from
// the just-persisted config and the event taps re-applied.
async function bringDeadboltOnline() {
  for (const [lockId, driver] of lockDrivers) {
    try { await driver.shutdown(); } catch (e) { logger.warn(`Deadbolt: old lock "${lockId}" shutdown failed: ${e.message}`); }
  }
  destroyDeadboltControllers(); // clears relock timers + driver listeners
  lockDrivers = new Map();
  lockDriver = null;
  deadboltController = null;
  // A full rebuild is a fresh start: clear the failed/alerted tracking so a
  // lock that recovered by pairing/unpair/reload is not still "failed".
  _failedInitLocks = new Set();
  buildDeadbolt();
  // Init every driver concurrently: one lock's failure (a dead node, a bad
  // entry) must never block another lock from coming online.
  const entries = Array.from(lockDrivers.entries());
  const results = await Promise.allSettled(entries.map(([, driver]) => driver.init()));
  const succeeded = new Set();
  results.forEach((r, i) => {
    const lockId = entries[i][0];
    if (r.status === 'fulfilled') {
      succeeded.add(lockId);
      logger.info(`Deadbolt lock driver initialized ("${lockId}")`);
    } else {
      _noteLockInitFailure(lockId, r.reason && r.reason.message);
    }
  });
  // A lock that just succeeded is no longer in an alerted-failure state.
  for (const id of succeeded) _alertedInitLocks.delete(id);
  if (_failedInitLocks.size) scheduleDeadboltInitRetry();
  applyEventTaps();
  // Decision 2: the app owns relock in software now, so hand the hardware
  // auto-relock off for every flow-wired lock (best-effort; retried on the
  // next rebuild if the lock is asleep).
  ensureHardwareAutoRelockOff().catch((e) => logger.warn(`Deadbolt: hardware auto-relock handoff error: ${e.message}`));
  return _failedInitLocks.size === 0 && lockDrivers.size > 0;
}

// Force every flow-wired lock's OWN hardware auto-relock OFF (decision 2: the
// app schedules relock in software). Only touches locks currently known to be
// ON, so it converges and never churns unsupported/already-off locks. A lock
// that cannot be written now (asleep) keeps its state and is retried on the
// next rebuild; doorFlowWarnings stays honest until the write confirms.
async function ensureHardwareAutoRelockOff() {
  const locks = (config.devices && config.devices.zwave && config.devices.zwave.locks) || {};
  for (const lockId of doorFlows.automatedLockIdsFromFlows(config.door_flows)) {
    const driver = lockDrivers.get(lockId);
    const lc = locks[lockId];
    if (!driver || typeof driver.setAutoRelock !== 'function') continue;
    if (!lc || lc.auto_relock !== true) continue; // only turn OFF locks currently on
    try {
      const r = await driver.setAutoRelock(false);
      if (r && r.confirmed !== false) {
        persistZwaveMutation((cfg) => {
          const zwc = cfg.devices && cfg.devices.zwave;
          if (zwc && zwc.locks && zwc.locks[lockId]) zwc.locks[lockId].auto_relock = false;
        });
        if (locks[lockId]) locks[lockId].auto_relock = false;
        logger.info(`Deadbolt: forced hardware auto-relock OFF on "${lockLabel(lockId)}" (the app owns relock now)`);
      } else {
        logger.info(`Deadbolt: hardware auto-relock off not confirmed for "${lockLabel(lockId)}" (asleep?); will retry on the next rebuild`);
      }
    } catch (e) {
      logger.warn(`Deadbolt: could not turn off hardware auto-relock for "${lockLabel(lockId)}" (${e.message}); will retry`);
    }
  }
}

// One PIN per user: after a NEW lock pairs, write every saved user's PIN to
// it automatically. Runs only from onIncludeDone (never from a plain rebuild,
// which must stay write-free for battery locks). Waits until the pairing
// session fully ends and the interview reveals the User Code capability -
// minutes on a battery lock - then reuses the driver's verify-then-write
// restore (sequential, queue-friendly on a sleeping node). Overlap with the
// post-interview code restore is harmless: verify-first turns the second
// pass into an all-kept no-op.
const PROVISION_POLL_MS = 15000;
const PROVISION_GIVE_UP_MS = 10 * 60 * 1000;
async function provisionUserCodesOnNewLock(lockId) {
  const others = (config.devices && config.devices.zwave && config.devices.zwave.locks) || {};
  const anySource = Object.entries(others).some(([id, l]) =>
    id !== lockId && l && l.user_codes && Object.keys(l.user_codes).length);
  if (!anySource) return; // nothing saved anywhere: nothing to seed
  const deadline = Date.now() + PROVISION_GIVE_UP_MS;
  let cap = null;
  for (;;) {
    if (Date.now() > deadline) {
      logger.warn(`Deadbolt: gave up auto-provisioning keypad codes on "${lockLabel(lockId)}" (capability never appeared; use Rewrite Codes to Lock once the interview finishes)`);
      return;
    }
    const driver = lockDrivers.get(lockId);
    if (!zwavePairing.isActive() && driver && typeof driver.userCodesCapability === 'function'
        && typeof driver.restoreUserCodes === 'function') {
      try {
        cap = await driver.userCodesCapability();
      } catch (e) {
        cap = null;
      }
      if (cap && cap.supported) break;
      if (cap && cap.supported === false && cap.note) {
        logger.info(`Deadbolt: not auto-provisioning keypad codes on "${lockLabel(lockId)}": ${cap.note}`);
        return;
      }
    }
    await new Promise((r) => { const t = setTimeout(r, PROVISION_POLL_MS); if (t.unref) t.unref(); });
  }
  const locksCfg = (config.devices && config.devices.zwave && config.devices.zwave.locks) || {};
  // Access gating: if the new lock has gating doors (any door with a retract
  // edge to it), seed only users UniFi allows on AT LEAST ONE of them - the
  // same id-aware UNION verdict every other gate uses. 'unknown' (access data
  // not yet available) is deferred and logged, not seeded, since provisioning
  // is additive and retryable via Rewrite Codes to Lock; a lock wired to no
  // door seeds everyone (ungated).
  const gatingDoors = doorFlows.gatingDoorsForLock(config.door_flows, lockId);
  let eligibleUserIds = null;
  if (gatingDoors.length) {
    const access = currentAccessModel();
    const doorNames = gatingDoors.map((d) => d.name).join('", "');
    eligibleUserIds = new Set();
    for (const userId of keypadUsers.canonicalPins(locksCfg).keys()) {
      const verdict = accessGating.doorAccessVerdictUnion(access, userId, gatingDoors);
      if (verdict === 'allowed' || verdict === 'ungated') eligibleUserIds.add(userId);
      else logger.info(`Deadbolt: not seeding "${userId}" onto "${lockLabel(lockId)}" (${verdict === 'denied' ? `no UniFi access to "${doorNames}"` : 'access not yet known; retry with Rewrite Codes to Lock'})`);
    }
  }
  const plan = keypadUsers.planNewLockProvision(locksCfg, lockId, cap, new Date().toISOString(), eligibleUserIds);
  const slots = Object.keys(plan.assignments);
  for (const s of plan.skipped) {
    logger.warn(`Deadbolt: cannot copy the keypad code for "${s.name || s.user_id}" to "${lockLabel(lockId)}": ${s.reason}`);
  }
  if (!slots.length) return;
  persistZwaveMutation((cfg) => {
    const locks = cfg.devices && cfg.devices.zwave && cfg.devices.zwave.locks;
    if (!locks || !locks[lockId]) return;
    locks[lockId].user_codes = Object.assign({}, locks[lockId].user_codes, plan.assignments);
  });
  logger.info(`Deadbolt: writing ${slots.length} saved keypad code(s) to newly paired "${lockLabel(lockId)}"`);
  const driver = lockDrivers.get(lockId);
  if (!driver) return; // rebuilt away mid-wait (unpaired again)
  const results = await driver.restoreUserCodes(savedUserCodes(lockId));
  const failed = results.filter((r) => r.action === 'failed');
  persistZwaveMutation((cfg) => {
    const uc = cfg.devices && cfg.devices.zwave && cfg.devices.zwave.locks
      && cfg.devices.zwave.locks[lockId] && cfg.devices.zwave.locks[lockId].user_codes;
    if (!uc) return;
    for (const r of results) {
      const entry = uc[String(r.slot)];
      if (entry) entry.confirmed = r.action === 'failed' ? false : (r.confirmed === true ? true : entry.confirmed);
    }
  });
  broadcastEvent({
    type: 'deadbolt.user_code',
    actor: 'Deadbolt Controller',
    location: lockLabel(lockId),
    action: `Copied ${results.length - failed.length}/${results.length} saved keypad code(s) to the new lock`
      + (failed.length ? ' (use Rewrite Codes to Lock to retry the rest)' : '')
      + (plan.skipped.length ? `; ${plan.skipped.length} skipped (see log)` : ''),
    success: failed.length === 0,
  });
}

// Record a per-lock init failure. The alert is EDGE-triggered per lock (fired
// once when a lock enters the failed state, re-armed only after it recovers),
// so a permanently-orphaned node no longer emails every retry cycle.
function _noteLockInitFailure(lockId, message) {
  _failedInitLocks.add(lockId);
  logger.error(`Deadbolt lock driver "${lockId}" failed to initialize: ${message}`);
  if (!_alertedInitLocks.has(lockId)) {
    _alertedInitLocks.add(lockId);
    notifier.notify({ type: 'deadbolt_no_transport', detail: `lock driver "${lockId}" init failed: ${message}` });
  }
}

// Self-healing, layer 1b: a failed lock-driver init (serial port not there
// yet after a power outage, stick enumerating late, port briefly busy) used
// to stay dead until an app restart. Retry ONLY the failed drivers in place,
// on a capped backoff, so healthy locks (and their controllers) are never
// torn down because a different lock is broken. Skips (and re-arms) while a
// pairing session owns the controller.
let _deadboltInitRetryTimer = null;
let _deadboltInitRetryAttempt = 0;
function scheduleDeadboltInitRetry() {
  if (_deadboltInitRetryTimer) return;
  if (!_failedInitLocks.size) { _deadboltInitRetryAttempt = 0; return; }
  const delay = Math.min(10000 * 2 ** _deadboltInitRetryAttempt, 300000);
  _deadboltInitRetryAttempt++;
  logger.warn(`Deadbolt: retrying ${_failedInitLocks.size} failed lock driver(s) in ${Math.round(delay / 1000)}s`);
  _deadboltInitRetryTimer = setTimeout(() => {
    _deadboltInitRetryTimer = null;
    if (!shouldRunDeadbolt()) { _failedInitLocks = new Set(); return; } // no longer configured
    if (zwavePairing.isActive()) { scheduleDeadboltInitRetry(); return; }
    retryFailedLockInits().catch((e) => {
      logger.warn(`Deadbolt: init retry failed: ${e.message}`);
      scheduleDeadboltInitRetry();
    });
  }, delay);
  if (typeof _deadboltInitRetryTimer.unref === 'function') _deadboltInitRetryTimer.unref();
}

// Re-init just the drivers still failing. Each driver object already exists
// (buildDeadbolt created and wired it; only init() rejected) and its
// controller already holds the reference, so a bare init() retry is enough:
// on success the node starts emitting and the controller works. A lock that
// dropped out of config (unpaired) is pruned from the failed set.
async function retryFailedLockInits() {
  for (const lockId of Array.from(_failedInitLocks)) {
    const driver = lockDrivers.get(lockId);
    if (!driver) { _failedInitLocks.delete(lockId); _alertedInitLocks.delete(lockId); continue; }
    try {
      await driver.init();
      _failedInitLocks.delete(lockId);
      _alertedInitLocks.delete(lockId); // recovered: re-arm the alert edge
      logger.info(`Deadbolt: lock driver "${lockId}" recovered by init retry`);
    } catch (e) {
      logger.warn(`Deadbolt: lock driver "${lockId}" still failing: ${e.message}`);
    }
  }
  applyEventTaps();
  if (_failedInitLocks.size) { scheduleDeadboltInitRetry(); return; }
  _deadboltInitRetryAttempt = 0;
  logger.info('Deadbolt: all lock drivers recovered');
}

// Route every raw UniFi event to the capture recorder and the deadbolt
// controller. Re-applied whenever the UniFi client is rebuilt (reload).
// /health deadbolt block: the first automated lock's status (legacy shape)
// plus a `locks` array covering every driven lock, so the dashboard card can
// show all of them.
function deadboltHealthStatus() {
  if (!deadboltController && !lockDrivers.size) return { enabled: false };
  const base = deadboltController ? deadboltController.getStatus() : { enabled: lockDrivers.size > 0 };
  base.locks = Array.from(lockDrivers.entries()).map(([lockId, driver]) => {
    const ctl = deadboltControllers.get(lockId);
    const status = ctl ? ctl.getStatus() : null;
    return {
      lock_id: lockId,
      name: lockLabel(lockId),
      automated: !!ctl,
      // Compat single field + the full multi-door list.
      trigger_door: status ? status.trigger_door : null,
      trigger_doors: status ? status.trigger_doors : [],
      lock: typeof driver.snapshot === 'function' ? driver.snapshot() : null,
      stats: ctl ? Object.assign({}, ctl.stats) : null,
    };
  });
  return withCascadeStats(base);
}

// Cascade rules run on a dedicated controller, so the per-lock/alias
// controllers' stats always show 0 cascades. Overlay the real cascade
// counters (and last_action, when it is the more recent) onto a status
// payload so the dashboard "cascades N (M failed)" line is truthful.
function withCascadeStats(status) {
  if (!status || !status.stats || !cascadeController) return status;
  const cs = cascadeController.stats;
  status.stats.cascades = cs.cascades;
  status.stats.cascades_failed = cs.cascades_failed;
  if (cs.last_action && (!status.stats.last_action
      || (cs.last_action.time || '') > (status.stats.last_action.time || ''))) {
    status.stats.last_action = cs.last_action;
  }
  return status;
}

// Every observer that should see a raw event: one controller per automated
// lock plus the dedicated cascade controller.
function deadboltObservers() {
  const out = Array.from(deadboltControllers.values());
  if (cascadeController) out.push(cascadeController);
  return out;
}

function applyEventTaps() {
  if (!unifiClient || typeof unifiClient.setRawTap !== 'function') return;
  // Install the tap whenever the add-on is CONFIGURED or a capture is running
  // (not only when a controller is enabled): the labeled capture recorder
  // feeds only from this tap in websocket mode, and it must keep recording
  // while the only lock is unpaired or mid-setup. Clear it only when there is
  // genuinely nothing to feed, so an unconfigured deployment is unchanged.
  if (!shouldRunDeadbolt() && !capture.active) {
    unifiClient.setRawTap(null);
    return;
  }
  unifiClient.setRawTap((e) => {
    capture.add(e); // no-op unless a capture session is active
    for (const controller of deadboltObservers()) {
      try { controller.observe(e); } catch (err) { logger.warn(`deadbolt observe error: ${err.message}`); }
    }
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

// Serializes every keypad driver-plus-persistence operation so a periodic
// reconcile, a wake-triggered retry, and a POST Save can never interleave
// clear/set calls on the same lock. Not reentrant: callers that already run
// under withKeypadLock must call the raw helpers (revokeHeldCode,
// retryPendingClears) directly rather than wrapping again.
let _keypadOpChain = Promise.resolve();
function withKeypadLock(fn) {
  const run = _keypadOpChain.then(() => fn());
  _keypadOpChain = run.then(() => {}, () => {}); // keep the chain alive after a rejection
  return run;
}

// The single path that removes a user's code from one lock. revoked is true
// ONLY when clearUserCode confirms the slot is now empty. On a throw or an
// unconfirmed clear (confirmed false or null, common for a sleeping battery
// lock) the user_codes entry is still deleted, because a kept entry would be
// resurrected by restoreUserCodes on the next re-interview, and a pending_clears
// marker is armed so retryPendingClears can finish the job when the lock next
// responds. The marker never stores the PIN; clearUserCode needs only the slot.
// Raw: callers serialize with withKeypadLock.
async function revokeHeldCode({ lockId, driver, label }, slot, userId, reason) {
  let confirmed = null;
  let error = null;
  try {
    if (driver && typeof driver.clearUserCode === 'function') {
      const r = await driver.clearUserCode(slot);
      confirmed = r ? r.confirmed : null;
    }
  } catch (e) {
    confirmed = null;
    error = e.message;
    logger.debug(`Deadbolt: clearUserCode threw on "${label}" slot ${slot}: ${e.message}`);
  }
  const revoked = confirmed === true;
  const requestedAt = new Date().toISOString(); // computed once, mutator runs twice
  persistZwaveMutation((cfg) => {
    const lock = cfg.devices && cfg.devices.zwave && cfg.devices.zwave.locks
      && cfg.devices.zwave.locks[lockId];
    if (!lock) return;
    if (lock.user_codes) delete lock.user_codes[String(slot)];
    if (revoked) {
      if (lock.pending_clears) delete lock.pending_clears[String(slot)];
    } else {
      lock.pending_clears = lock.pending_clears || {};
      lock.pending_clears[String(slot)] = { user_id: userId, requested_at: requestedAt, reason };
    }
  });
  if (revoked) {
    logger.info(`Deadbolt: revoked "${userId}" from "${label}" (${reason})`);
  } else {
    logger.warn(`Deadbolt: clear unconfirmed for "${userId}" on "${label}" slot ${slot}; entry removed, retry queued (${reason})`);
  }
  return { lock_id: lockId, slot, confirmed, revoked, revoke_pending: !revoked, reason, error };
}

// Re-attempt every armed pending clear. Deletes the marker only when the
// physical clear confirms. onlyLockId scopes a wake-triggered retry to the lock
// that woke, so it never pokes sleeping siblings. Raw: callers serialize with
// withKeypadLock.
async function retryPendingClears(onlyLockId) {
  const zwLocks = (config.devices && config.devices.zwave && config.devices.zwave.locks) || {};
  for (const [lockId, lock] of Object.entries(zwLocks)) {
    if (onlyLockId && lockId !== onlyLockId) continue;
    const pend = (lock && lock.pending_clears) || {};
    const slots = Object.keys(pend);
    if (!slots.length) continue;
    const driver = lockDrivers.get(lockId);
    if (!driver || typeof driver.clearUserCode !== 'function') continue;
    for (const slotKey of slots) {
      let confirmed = null;
      try {
        const r = await driver.clearUserCode(Number(slotKey));
        confirmed = r ? r.confirmed : null;
      } catch (e) {
        confirmed = null;
      }
      if (confirmed === true) {
        persistZwaveMutation((cfg) => {
          const pc = cfg.devices && cfg.devices.zwave && cfg.devices.zwave.locks
            && cfg.devices.zwave.locks[lockId] && cfg.devices.zwave.locks[lockId].pending_clears;
          if (pc) delete pc[slotKey];
        });
        logger.info(`Deadbolt: pending clear confirmed on "${lockLabel(lockId)}" slot ${slotKey}`);
      }
    }
  }
}

// UniFi health-monitor state callback: when connectivity is restored, retry any
// keypad clears that could not confirm while the controller or a lock was away.
function onUnifiStateChange(state) {
  if (state === 'connected') {
    withKeypadLock(() => retryPendingClears())
      .catch((e) => logger.debug(`Deadbolt: pending-clear retry failed: ${e.message}`));
  }
}

// Revoke keypad codes for users who lost UniFi access to a lock's gating door,
// detected by a periodic or reconnect access sync rather than a manual Save.
// This closes the gap where the dashboard showed a lock "blocked" while the PIN
// still opened it. Reuses the exact fail-open rule (only a confirmed 'denied'
// verdict acts, via the shared revoke executor) so an API hiccup or an
// unresolved door never wipes a code, and serializes with Saves and retries
// through withKeypadLock. A no-op while access data is unavailable or a pairing
// session owns the controller.
async function reconcileAccessRevocations(trigger) {
  if (zwavePairing.isActive()) return;
  backfillTriggerDoorIds(); // keep rule door ids current before classifying
  const access = currentAccessModel();
  if (!access.available) return; // fail open: uncertainty does nothing
  return withKeypadLock(async () => {
    await retryPendingClears(); // finish any queued clears first
    const capable = await codeCapableLocks();
    const relevant = capable.filter((l) => l.cap && l.cap.supported !== false);
    if (!relevant.length) return;
    const zwLocks = (config.devices && config.devices.zwave && config.devices.zwave.locks) || {};
    const userIds = new Set();
    for (const l of relevant) {
      for (const e of Object.values((zwLocks[l.lock_id] && zwLocks[l.lock_id].user_codes) || {})) {
        if (e && e.user_id) userIds.add(e.user_id);
      }
    }
    if (!userIds.size) return;
    const verdictMap = new Map();
    for (const userId of userIds) {
      // classifyLocksForUser returns the COLLAPSED union verdict per lock
      // (allowed on ANY gating door wins; unknown fails open) - the reconcile
      // revoke planner must never see a raw per-door 'denied'.
      const verdicts = accessGating.classifyLocksForUser(
        userId, relevant.map((l) => ({ lock_id: l.lock_id })), config.door_flows, access);
      for (const v of verdicts) verdictMap.set(`${userId}|${v.lock_id}`, { verdict: v.verdict, door: v.doors.join('", "') });
    }
    const plan = keypadUsers.planReconciliation(
      zwLocks, relevant.map((l) => ({ lock_id: l.lock_id })), verdictMap);
    if (!plan.length) return;
    const byId = new Map(capable.map((l) => [l.lock_id, l]));
    const done = [];
    for (const item of plan) {
      const le = byId.get(item.lock_id);
      if (!le) continue;
      done.push(await revokeHeldCode(
        { lockId: item.lock_id, driver: le.driver, label: le.label },
        item.slot, item.user_id, item.reason));
    }
    if (!done.length) return;
    const confirmed = done.filter((r) => r.revoked).length;
    const pending = done.filter((r) => r.revoke_pending).length;
    broadcastEvent({
      type: 'deadbolt.user_code',
      actor: 'Access Reconciler',
      location: [...new Set(done.map((r) => lockLabel(r.lock_id)))].join(', '),
      action: `Access sync revoked ${confirmed} keypad code(s) for users who lost UniFi door access`
        + (pending ? `; ${pending} clear(s) queued to retry when the lock responds` : ''),
      success: pending === 0,
    });
    logger.info(`Deadbolt: access reconciliation (${trigger}) revoked ${confirmed}, queued ${pending}`);
  });
}

// Trailing debounce so the 5-minute periodic sync, the 15-second config-sync
// refresh, and the reconnect burst coalesce into one reconcile rather than
// three back to back.
let _reconcileTimer = null;
function scheduleReconcile(reason) {
  if (_reconcileTimer) clearTimeout(_reconcileTimer);
  _reconcileTimer = setTimeout(() => {
    _reconcileTimer = null;
    reconcileAccessRevocations(reason).catch((e) => logger.warn(`Deadbolt: reconcile failed: ${e.message}`));
  }, 4000);
  if (_reconcileTimer.unref) _reconcileTimer.unref();
}

// Register the access-change hook on a (re)built UniFi client so a reconcile
// runs after each real access change, and once after the first sync. Called at
// every construction site so the hook survives a full reload.
function wireUnifiClientCallbacks(client) {
  if (!client) return;
  client.onAccessPoliciesChanged = ({ reason, changed }) => {
    if (changed) scheduleReconcile(reason || 'access_sync');
  };
}

// Resolve each gating rule's trigger_door name to a stable door id once the
// controller is connected, and refresh the display name if an id's door was
// renamed. Keying gating and the unlock automation by id (name kept for
// display) means a UniFi rename no longer silently un-gates a lock. Idempotent
// and guarded: only the map shape is touched (flat configs are migrated on
// load), and it rebuilds controllers only when something actually changed,
// against the running drivers (never reconnects the Z-Wave stick).
function backfillTriggerDoorIds() {
  if (zwavePairing.isActive()) return;
  if (!unifiClient || !unifiClient.doors || !unifiClient.doors.size) return;
  let changed = false;
  persistZwaveMutation((cfg) => {
    // door_flows is the sole live shape: backfill flow door ids, re-key
    // renamed doors under their live names, and give cascade unlock TARGETS
    // parallel ids too (closing the remaining rename hole the legacy shape
    // had on cascade destinations).
    if (cfg.door_flows && doorFlows.backfillFlowDoorIds(cfg.door_flows, unifiClient.doors, unifiClient.doorsById)) {
      changed = true;
    }
  });
  if (changed) {
    logger.info('Deadbolt: backfilled door ids on door_flows from the door registry (rename-proof automation and gating)');
    buildDeadboltControllers();
    applyEventTaps();
  }
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
  // Display-only: mirror the observed webhook event onto the Live Events feed.
  // Kept in its own try/catch so a projection error never turns a valid,
  // already-received webhook into a 500. Automation stays with the observers.
  try {
    const feed = rulesEngine.describeForFeed(payload);
    if (feed) broadcastEvent({ ...feed, action: '' });
  } catch (e) {
    logger.warn(`Live feed projection failed: ${e.message}`);
  }
  // The deadbolt controller owns live automation now (entry, doorbell and
  // cascade/scoped unlocks), so events flow to the observers only. The rules
  // engine runs the derived projection for simulate/preflight, never live.
  try {
    for (const controller of deadboltObservers()) {
      try { controller.observe(payload); } catch (err) { logger.warn(`deadbolt observe error: ${err.message}`); }
    }
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
    deadbolt: deadboltHealthStatus(),
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
  const lockId = activeLockId(config) || 'front_deadbolt';
  const lc = locks[lockId] || {};
  const nodeId = lc.node_id || 0;
  return {
    configured: !!zw.serial_path,
    enabled: zw.enabled === true,
    lock_id: lockId,
    node_id: nodeId,
    paired: nodeId > 0,
    manager_running: zwaveManager.isRunning(),
    pairing_active: zwavePairing.isActive(),
    // After-unlock behavior: the saved preference (null until first applied)
    // and the driver's capability report for the paired model, so the
    // dashboard can offer "stay unlocked" only where it actually works.
    auto_relock: lc.auto_relock == null ? null : !!lc.auto_relock,
    auto_relock_support: (lockDriver && typeof lockDriver.autoRelockInfo === 'function')
      ? lockDriver.autoRelockInfo() : null,
  };
}

// Live deadbolt + lock state for the dashboard. `zwave`/`lock_state` keep
// the single active-lock shape for existing consumers; `zwave_locks` carries
// one summary per SAVED lock (multi-lock UI renders a card per entry).
app.get('/api/devices', async (req, res) => {
  const zwave = zwaveSummary();
  const zwaveLocks = perLockSummaries();
  if (!deadboltController) return res.json({ enabled: false, devices: [], zwave, zwave_locks: zwaveLocks });
  const status = withCascadeStats(deadboltController.getStatus());
  let liveState = status.lock;
  if (lockDriver && typeof lockDriver.getState === 'function') {
    try { liveState = await lockDriver.getState(); } catch (e) { /* fall back to snapshot */ }
  }
  res.json({ enabled: true, deadbolt: status, lock_state: liveState, zwave, zwave_locks: zwaveLocks });
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
    const b = req.body || {};
    // security: 'auto' (default) | 's2' | 's0'. s0 exists for locks like the
    // Yale YRD256 whose S2 bootstrap wedges and cannot fall back in-session.
    // lock_id + model_key drive Add Deadbolt: pair a NEW named lock of a
    // chosen catalog model (both optional; absent = single-lock behavior).
    const status = await zwavePairing.startInclusion({
      security: b.security,
      lock_id: b.lock_id,
      model_key: b.model_key,
      name: b.name,
    });
    res.json({ status: 'started', mode: 'include', state: status.state, keys_generated: status.keys_generated });
  } catch (err) {
    res.status(pairingErrorStatus(err)).json({ error: err.message, state: zwavePairing.state });
  }
});

// The deadbolt model catalog: manufacturers, models, and per-model enroll /
// exclude / reset gestures for the Add Deadbolt pickers and the locks table.
// Static reference data; admin-gated like the rest of /api.
app.get('/api/deadbolt/catalog', (req, res) => {
  res.json({ manufacturers: lockCatalog.getCatalog() });
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
            if (locks[id] && locks[id].node_id === nodeId) removeLockEntry(cfg, id);
          }
        });
        await bringDeadboltOnline();
        logger.info(`Z-Wave: failed node ${nodeId} removed directly (no exclusion needed) and its saved lock entry deleted`);
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

// Resolve which lock a deadbolt endpoint targets. An explicit lock_id (POST/
// DELETE body, or ?lock_id= for GETs) wins; omitted resolves to the only
// driver when exactly one exists, so single-lock callers never change. With
// several locks and no lock_id the request is ambiguous and gets a 400.
// Writes the error response itself and returns null so handlers can bail.
function resolveLockRequest(req, res) {
  const requested = (req.body && req.body.lock_id) || (req.query && req.query.lock_id);
  if (requested) {
    if (typeof requested !== 'string' || !lockDrivers.has(requested)) {
      res.status(404).json({ error: `unknown lock_id "${String(requested)}" (no live driver for it; is it paired?)` });
      return null;
    }
    return { lockId: requested, driver: lockDrivers.get(requested) };
  }
  if (lockDrivers.size === 1) {
    const [lockId, driver] = lockDrivers.entries().next().value;
    return { lockId, driver };
  }
  if (lockDrivers.size === 0) {
    res.status(503).json({ error: 'No lock driver is active (pair a lock first)' });
    return null;
  }
  res.status(400).json({ error: 'lock_id is required (multiple locks are configured)' });
  return null;
}

// Per-lock summaries for the dashboard: every SAVED lock with its live
// driver snapshot (each row from ITS OWN driver, so a second lock gets real
// telemetry), automation binding, and per-lock control context.
function perLockSummaries() {
  const zw = (config.devices && config.devices.zwave) || {};
  const locks = zw.locks || {};
  const pairingActive = zwavePairing.isActive();
  return Object.entries(locks).map(([lockId, lc]) => {
    const driver = lockDrivers.get(lockId) || null;
    const snap = driver && typeof driver.snapshot === 'function' ? driver.snapshot() : null;
    const triggerDoors = doorFlows.gatingDoorsForLock(config.door_flows, lockId).map((d) => d.name);
    return {
      lock_id: lockId,
      name: (lc && lc.name) || null,
      node_id: (lc && lc.node_id) || 0,
      paired: !!(lc && lc.node_id > 0),
      configured: !!zw.serial_path,
      pairing_active: pairingActive,
      bound: !!driver,
      automated: triggerDoors.length > 0,
      trigger_door: triggerDoors[0] || null,
      trigger_doors: triggerDoors,
      lock_state: snap,
      auto_relock: !lc || lc.auto_relock == null ? null : !!lc.auto_relock,
      auto_relock_support: (driver && typeof driver.autoRelockInfo === 'function')
        ? driver.autoRelockInfo() : null,
      // Lets the card show Rewrite Codes only when there is something to
      // rewrite (the per-card PIN editor moved to the global Keypad users
      // panel).
      user_code_count: Object.keys((lc && lc.user_codes) || {}).length,
    };
  });
}

app.get('/api/deadbolt/locks', (req, res) => {
  const zw = (config.devices && config.devices.zwave) || {};
  const saved = zw.locks || {};
  const ctrl = zwaveManager.controller;
  const ownNodeId = ctrl && ctrl.ownNodeId != null ? ctrl.ownNodeId : null;
  const seen = new Set();
  const locks = [];
  for (const [lockId, lc] of Object.entries(saved)) {
    const nodeId = (lc && lc.node_id) || 0;
    if (nodeId) seen.add(nodeId);
    // Each row reads ITS OWN driver (multi-lock), so every paired lock shows
    // live bolt/battery/link, not just the single active one.
    const driver = lockDrivers.get(lockId);
    const snap = driver && typeof driver.snapshot === 'function' ? driver.snapshot() : null;
    const bound = nodeId > 0 && snap;
    const triggerDoors = doorFlows.gatingDoorsForLock(config.door_flows, lockId).map((d) => d.name);
    locks.push({
      lock_id: lockId,
      name: (lc && lc.name) || null,
      node_id: nodeId,
      paired: nodeId > 0,
      bound: !!bound,
      automation: triggerDoors.length
        ? { trigger_door: triggerDoors[0], trigger_doors: triggerDoors }
        : null,
      on_stick: !!(nodeId && zwaveManager.getNode(nodeId)),
      model: bound ? snap.model : nodeModelLabel(zwaveManager.getNode(nodeId)),
      model_key: (lc && lc.model_key) || null,
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

// Remove a SAVED lock entry that is no longer paired (an old ghost, or a
// hand-added entry that never paired). A paired lock must go through Unpair
// first so the node actually leaves the network; this only cleans config.
app.delete('/api/deadbolt/locks/:lock_id', async (req, res) => {
  const lockId = req.params.lock_id;
  if (zwavePairing.isActive()) {
    return res.status(409).json({ error: 'A pairing session is in progress' });
  }
  const locks = (config.devices && config.devices.zwave && config.devices.zwave.locks) || {};
  const entry = locks[lockId];
  if (!entry) return res.status(404).json({ error: `no saved lock "${lockId}"` });
  if (entry.node_id > 0) {
    return res.status(409).json({ error: `"${lockLabel(lockId)}" is still paired (node ${entry.node_id}); use Unpair first` });
  }
  const label = lockLabel(lockId);
  persistZwaveMutation((cfg) => { removeLockEntry(cfg, lockId); });
  await bringDeadboltOnline();
  logger.info(`Z-Wave: removed saved lock entry "${label}" (was not paired)`);
  res.json({ status: 'removed', lock_id: lockId });
});

// Measured node health (ping, RTT/RSSI/route stats, one lifeline probe).
// Fire from the dashboard to answer "why is the link dropping" with numbers.
let lastDeadboltHealth = null;
app.post('/api/deadbolt/health-check', async (req, res) => {
  if (zwavePairing.isActive()) {
    return res.status(409).json({ error: 'A pairing session is in progress' });
  }
  const target = resolveLockRequest(req, res);
  if (!target) return;
  if (typeof target.driver.healthCheck !== 'function') {
    return res.status(503).json({ error: 'the active lock driver does not support health checks' });
  }
  try {
    const result = await target.driver.healthCheck();
    lastDeadboltHealth = Object.assign({ checked_at: new Date().toISOString(), lock_id: target.lockId }, result);
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
  const target = resolveLockRequest(req, res);
  if (!target) return;
  try {
    const result = await (action === 'lock' ? target.driver.lock('manual_test') : target.driver.unlock('manual_test'));
    broadcastEvent({
      type: 'deadbolt.manual_test',
      actor: 'GUI Admin',
      location: lockLabel(target.lockId),
      action: `Test ${action}`,
      success: !!(result && result.success),
    });
    res.json({ action, success: !!(result && result.success), boltState: result && result.boltState, verified: (result && result.verified) || null, error: (result && result.error) || null });
  } catch (err) {
    res.status(500).json({ action, success: false, error: err.message });
  }
});

// Per-lock after-unlock behavior. "Stay unlocked" (enabled=false) turns off
// the lock's OWN auto-relock feature by writing its configuration parameter
// over Z-Wave (the ~30s re-throw after an unlock is the lock's built-in
// behavior, not this app). The choice is persisted on the saved lock entry so
// the driver re-applies it after restarts and re-pairing.
app.post('/api/deadbolt/auto-relock', async (req, res) => {
  const enabled = req.body && req.body.enabled;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be true or false' });
  }
  if (zwavePairing.isActive()) {
    return res.status(409).json({ error: 'A pairing session is in progress' });
  }
  const target = resolveLockRequest(req, res);
  if (!target) return;
  if (typeof target.driver.setAutoRelock !== 'function') {
    return res.status(503).json({ error: 'the active lock driver does not support auto-relock' });
  }
  try {
    const result = await target.driver.setAutoRelock(enabled);
    // Persist on the RESOLVED lock entry so each lock keeps its own choice.
    persistZwaveMutation((cfg) => {
      const zwc = cfg.devices && cfg.devices.zwave;
      if (!zwc || !zwc.locks) return;
      if (zwc.locks[target.lockId]) zwc.locks[target.lockId].auto_relock = enabled;
    });
    broadcastEvent({
      type: 'deadbolt.auto_relock',
      actor: 'GUI Admin',
      location: lockLabel(target.lockId),
      action: enabled
        ? 'Auto-relock enabled (lock re-locks itself after an unlock)'
        : 'Auto-relock disabled (lock stays unlocked until a lock command)',
      success: result.confirmed !== false,
    });
    res.json({ lock_id: target.lockId, enabled, confirmed: result.confirmed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Per-user keypad PIN codes on the deadbolt (User Code CC). The app is the
// source of truth: codes are written to the lock's slots and persisted (0600
// config, pin_code fields redacted everywhere by SECRET_KEY_RX). Optionally
// the same PIN is pushed to the user's UniFi Access account so UniFi readers
// match; UniFi never returns existing PINs in plaintext, so there is no
// mirror-from-UniFi path. All lock operations are targeted per-slot writes
// (the interview-wide queryAllUserCodes stays disabled: Yale battery guard).
// ---------------------------------------------------------------------------

// The lock entry the driver is bound to (same resolution buildDeadbolt uses):
// the first lock referenced by any door's retract edge, else the first saved
// lock.
function activeLockId(cfg) {
  const c = cfg || config;
  const locks = (c.devices && c.devices.zwave && c.devices.zwave.locks) || {};
  return doorFlows.automatedLockIdsFromFlows(c.door_flows)[0] || Object.keys(locks)[0] || null;
}

function savedUserCodes(lockId) {
  const id = lockId || activeLockId();
  const locks = (config.devices && config.devices.zwave && config.devices.zwave.locks) || {};
  return (id && locks[id] && locks[id].user_codes) || {};
}

// List assigned codes + the lock's capability. Digits never leave the server:
// each entry exposes only the code LENGTH for the masked dashboard display.
app.get('/api/deadbolt/user-codes', async (req, res) => {
  const target = resolveLockRequest(req, res);
  if (!target) return;
  if (typeof target.driver.userCodesCapability !== 'function') {
    return res.status(503).json({ error: 'the active lock driver does not support keypad codes' });
  }
  try {
    const cap = await target.driver.userCodesCapability();
    const known = (unifiClient && unifiClient.userNames) || new Map();
    const codes = Object.entries(savedUserCodes(target.lockId)).map(([slot, e]) => ({
      slot: Number(slot),
      user_id: e.user_id || null,
      name: e.name || null,
      pin_length: e.pin_code ? String(e.pin_code).length : 0,
      pushed_to_unifi: !!e.pushed_to_unifi,
      updated_at: e.updated_at || null,
      // The user disappeared from the UniFi sync (deleted/archived): the code
      // still opens the deadbolt, so surface it for cleanup.
      user_missing: !!(e.user_id && known.size && !known.has(e.user_id)),
    })).sort((a, b) => a.slot - b.slot);
    res.json(Object.assign({ lock_id: target.lockId }, cap, { codes }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assign or update a user's keypad code. Writes the lock FIRST (a code that
// the lock rejected is never persisted), then optionally pushes the same PIN
// to the user's UniFi account. A UniFi failure does not fail the request: the
// lock code stands and the response carries the UniFi outcome separately.
app.post('/api/deadbolt/user-codes', async (req, res) => {
  const b = req.body || {};
  if (zwavePairing.isActive()) {
    return res.status(409).json({ error: 'A pairing session is in progress' });
  }
  const target = resolveLockRequest(req, res);
  if (!target) return;
  if (typeof target.driver.setUserCode !== 'function') {
    return res.status(503).json({ error: 'the active lock driver does not support keypad codes' });
  }
  if (!b.user_id || typeof b.user_id !== 'string') {
    return res.status(400).json({ error: 'user_id is required (pick a synced UniFi user)' });
  }
  const pin = typeof b.pin === 'string' ? b.pin.trim() : '';
  if (!/^[0-9]{4,10}$/.test(pin)) {
    return res.status(400).json({ error: 'pin must be 4 to 10 digits' });
  }
  try {
    const cap = await target.driver.userCodesCapability();
    if (!cap.supported) {
      return res.status(400).json({ error: cap.note || 'this lock does not support keypad codes over Z-Wave' });
    }
    if (cap.min_length && pin.length < cap.min_length) {
      return res.status(400).json({ error: `this lock needs codes of at least ${cap.min_length} digits` });
    }
    if (cap.max_length && pin.length > cap.max_length) {
      return res.status(400).json({ error: `this lock takes codes of at most ${cap.max_length} digits` });
    }
    if (cap.fixed_length && cap.configured_length && pin.length !== cap.configured_length) {
      // Never auto-write the length parameter: changing it WIPES every code
      // on Schlage. Tell the operator to enter a matching-length PIN instead.
      return res.status(400).json({ error: `this lock is set to ${cap.configured_length}-digit codes (all codes share one length; changing it would wipe every stored code). Enter a ${cap.configured_length}-digit PIN` });
    }
    const saved = savedUserCodes(target.lockId);
    for (const [slot, e] of Object.entries(saved)) {
      if (e && e.pin_code === pin && e.user_id !== b.user_id) {
        return res.status(409).json({ error: `that PIN is already assigned (slot ${slot}); locks reject duplicate codes` });
      }
    }
    // Reuse the user's existing slot on update; otherwise take the lowest
    // free slot within the lock's capacity.
    let slot = null;
    for (const [s, e] of Object.entries(saved)) {
      if (e && e.user_id === b.user_id) { slot = Number(s); break; }
    }
    if (slot == null) {
      const reserved = Array.isArray(cap.reserved_slots) ? cap.reserved_slots : [];
      for (let s = 1; s <= (cap.slots || 0); s++) {
        // Never hand out a slot the lock reserves for itself (Yale counts
        // its admin/master code as a slot); the driver refuses these too.
        if (reserved.includes(s)) continue;
        if (!saved[String(s)]) { slot = s; break; }
      }
    }
    if (slot == null) {
      return res.status(409).json({ error: `all ${cap.slots} code slots on this lock are in use; remove one first` });
    }
    const result = await target.driver.setUserCode(slot, pin);
    if (result.confirmed === false) {
      return res.status(409).json({ error: 'the lock rejected this code (usually a duplicate PIN or a length that does not match its code-length setting)' });
    }
    const known = (unifiClient && unifiClient.userNames) || new Map();
    const name = (typeof b.name === 'string' && b.name.trim()) || known.get(b.user_id) || null;
    persistZwaveMutation((cfg) => {
      const lockId = target.lockId;
      const locks = cfg.devices && cfg.devices.zwave && cfg.devices.zwave.locks;
      if (!lockId || !locks || !locks[lockId]) return;
      locks[lockId].user_codes = locks[lockId].user_codes || {};
      locks[lockId].user_codes[String(slot)] = {
        user_id: b.user_id,
        name,
        pin_code: pin,
        pushed_to_unifi: false,
        updated_at: new Date().toISOString(),
      };
    });
    // Optional UniFi push, decided per save by the operator ("overwrite the
    // PIN in UniFi for this user?"). Failure keeps the lock code and is
    // reported separately so the UI can explain (e.g. token scope).
    // UniFi holds ONE PIN per user and errors on re-assigning the PIN it
    // already holds (field case: same user, same PIN saved to a second lock
    // came back CODE_SYSTEM_ERROR), so an already-in-sync save skips the API
    // call and just records the sync.
    let unifi = { attempted: false, success: null, permission_denied: false, error: null };
    if (b.push_to_unifi === true) {
      unifi.attempted = true;
      const zwLocks = (config.devices && config.devices.zwave && config.devices.zwave.locks) || {};
      const plan = planUnifiPinPush(zwLocks, target.lockId, b.user_id, pin, config.unifi_pin_state);
      if (plan.action === 'skip_in_sync') {
        unifi.success = true;
        unifi.skipped = 'already in sync';
        logger.info(`Deadbolt: UniFi already holds this PIN for "${name || b.user_id}" (known via ${plan.source_lock ? `"${plan.source_lock}"` : 'the recorded UniFi PIN state'}); skipping the push`);
        const now = new Date().toISOString();
        persistZwaveMutation((cfg) => {
          const lockId = target.lockId;
          const entry = cfg.devices && cfg.devices.zwave && cfg.devices.zwave.locks
            && cfg.devices.zwave.locks[lockId] && cfg.devices.zwave.locks[lockId].user_codes
            && cfg.devices.zwave.locks[lockId].user_codes[String(slot)];
          if (entry) entry.pushed_to_unifi = true;
          // Backfill the durable user-level record (a legacy-inferred skip
          // roots in a real push, so recording the same fact is safe).
          recordUnifiPin(cfg, b.user_id, pin, now);
        });
      } else if (unifiClient && typeof unifiClient.assignUserPin === 'function') {
        const push = await unifiClient.assignUserPin(b.user_id, pin);
        unifi.success = !!push.success;
        unifi.permission_denied = !!push.permission_denied;
        unifi.error = push.error || null;
        if (push.statusCode) unifi.status_code = push.statusCode;
        if (push.success) {
          const now = new Date().toISOString();
          persistZwaveMutation((cfg) => {
            const lockId = target.lockId;
            const locks = cfg.devices && cfg.devices.zwave && cfg.devices.zwave.locks;
            const entry = locks && locks[lockId] && locks[lockId].user_codes
              && locks[lockId].user_codes[String(slot)];
            if (entry) entry.pushed_to_unifi = true;
            // This push just replaced the user's single UniFi PIN: any other
            // lock that recorded a DIFFERENT pushed PIN for them no longer
            // matches UniFi and must stop claiming it does.
            if (locks) markStaleAfterPush(locks, lockId, b.user_id, pin);
            recordUnifiPin(cfg, b.user_id, pin, now);
          });
          if (plan.stale_locks.length) {
            unifi.note = `UniFi keeps one PIN per user; the PIN stored for ${plan.stale_locks.map((l) => `"${lockLabel(l)}"`).join(', ')} no longer matches UniFi`;
            logger.warn(`Deadbolt: ${unifi.note}`);
          }
        }
      } else {
        unifi.success = false;
        unifi.error = 'UniFi client is not connected';
      }
      if (!unifi.success && /CODE_SYSTEM_ERROR/i.test(unifi.error || '')) {
        unifi.hint = 'UniFi already has this exact PIN. If it is this user\'s existing PIN everything already matches; if another user holds it, choose a different PIN (UniFi PINs are unique per person).';
      }
    }
    broadcastEvent({
      type: 'deadbolt.user_code',
      actor: 'GUI Admin',
      location: lockLabel(target.lockId),
      action: `Keypad code ${result.confirmed === true ? 'set' : 'queued'} for ${name || b.user_id} (slot ${slot}${unifi.attempted ? unifi.success ? ', also set in UniFi' : ', UniFi push failed' : ''})`,
      success: true,
    });
    res.json({ lock_id: target.lockId, slot, confirmed: result.confirmed, name, unifi });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a keypad code slot from the deadbolt. Deliberately never touches
// UniFi: the UniFi PIN is a separate credential still valid at UniFi readers,
// silently revoking building access on a local cleanup would surprise, and
// there is no restore path since UniFi never reveals PINs.
app.delete('/api/deadbolt/user-codes/:slot', async (req, res) => {
  const slot = Number(req.params.slot);
  if (!Number.isInteger(slot) || slot < 1) {
    return res.status(400).json({ error: 'slot must be a positive integer' });
  }
  if (zwavePairing.isActive()) {
    return res.status(409).json({ error: 'A pairing session is in progress' });
  }
  const target = resolveLockRequest(req, res);
  if (!target) return;
  if (typeof target.driver.clearUserCode !== 'function') {
    return res.status(503).json({ error: 'the active lock driver does not support keypad codes' });
  }
  try {
    const result = await target.driver.clearUserCode(slot);
    // Persist the removal even on an unconfirmed clear: the command is queued
    // on the lock, and keeping the entry would resurrect the code on the next
    // manual rewrite.
    let removedName = null;
    persistZwaveMutation((cfg) => {
      const lockId = target.lockId;
      const uc = cfg.devices && cfg.devices.zwave && cfg.devices.zwave.locks
        && cfg.devices.zwave.locks[lockId] && cfg.devices.zwave.locks[lockId].user_codes;
      if (uc && uc[String(slot)]) {
        removedName = uc[String(slot)].name || null;
        delete uc[String(slot)];
      }
    });
    broadcastEvent({
      type: 'deadbolt.user_code',
      actor: 'GUI Admin',
      location: lockLabel(target.lockId),
      action: `Keypad code removed (slot ${slot}${removedName ? `, ${removedName}` : ''}). The user's UniFi PIN is untouched`,
      success: true,
    });
    res.json({ lock_id: target.lockId, slot, confirmed: result.confirmed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually rewrite every saved code to the lock, for after a re-pair. Never
// automatic: dozens of queued writes on each restart would drain a battery
// lock, so the operator presses the button once when it is actually needed.
app.post('/api/deadbolt/user-codes/rewrite', async (req, res) => {
  if (zwavePairing.isActive()) {
    return res.status(409).json({ error: 'A pairing session is in progress' });
  }
  const target = resolveLockRequest(req, res);
  if (!target) return;
  if (typeof target.driver.rewriteUserCodes !== 'function') {
    return res.status(503).json({ error: 'the active lock driver does not support keypad codes' });
  }
  try {
    const results = await target.driver.rewriteUserCodes(savedUserCodes(target.lockId));
    broadcastEvent({
      type: 'deadbolt.user_code',
      actor: 'GUI Admin',
      location: lockLabel(target.lockId),
      action: `Rewrote ${results.filter((r) => r.ok).length}/${results.length} keypad codes to the lock`,
      success: results.every((r) => r.ok),
    });
    res.json({ lock_id: target.lockId, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// User-centric keypad codes: ONE PIN per user, applied to every paired lock
// and always kept in sync with the user's single UniFi PIN. These are the
// endpoints the dashboard uses; the per-lock routes above remain as the
// low-level API (and for the per-card Rewrite button).
// ---------------------------------------------------------------------------

// Bound, code-capable locks with their capability, for planning and display.
async function codeCapableLocks() {
  const rows = [];
  for (const [lockId, driver] of lockDrivers) {
    if (typeof driver.setUserCode !== 'function' || typeof driver.userCodesCapability !== 'function') continue;
    let cap;
    try {
      cap = await driver.userCodesCapability();
    } catch (e) {
      cap = { supported: false, note: e.message };
    }
    rows.push({ lock_id: lockId, label: lockLabel(lockId), driver, cap });
  }
  return rows;
}

// Snapshot the current UniFi door-access model for keypad-PIN gating. A user
// only holds a code on a deadbolt whose gating door (deadbolt_rules.trigger_
// door) their UniFi access allows. When access data is unavailable this
// returns available:false, and every gate fails OPEN (no code is revoked).
function currentAccessModel() {
  return accessGating.buildAccess({
    available: !!(unifiClient && unifiClient.accessPolicyAvailable),
    doorsByName: (unifiClient && unifiClient.doors) || new Map(),
    doorsById: (unifiClient && unifiClient.doorsById) || new Map(),
    allowedDoorsByUser: (unifiClient && unifiClient.userDoorAccess) || new Map(),
    completeByUser: (unifiClient && unifiClient.userAccessComplete) || new Map(),
  });
}

// Access-gating status block for the keypad-users UI (warning banner data).
function accessGatingStatus() {
  const st = (unifiClient && typeof unifiClient.accessPolicyStatus === 'function')
    ? unifiClient.accessPolicyStatus()
    : { available: false, synced_at: null, users: 0, incomplete_users: 0, error: null };
  return {
    available: st.available,
    synced_at: st.synced_at,
    incomplete_users: st.incomplete_users,
    error: st.error,
    door_groups_error: st.door_groups_error || null,
    groups_referenced: !!st.groups_referenced,
  };
}

// Aggregate per-user view across all locks. Digits never leave the server.
app.get('/api/deadbolt/keypad-users', async (req, res) => {
  try {
    const capable = await codeCapableLocks();
    const relevant = capable.filter((l) => l.cap && l.cap.supported !== false);
    const zwLocks = (config.devices && config.devices.zwave && config.devices.zwave.locks) || {};
    const known = (unifiClient && unifiClient.userNames) || new Map();
    // Per-lock gating doors (a lock may be triggered by SEVERAL doors) +
    // per-(user,lock) UNION verdicts, so the panel shows which users are
    // blocked from which deadbolts and why.
    const gatingDoorsFor = (lockId) =>
      doorFlows.gatingDoorsForLock(config.door_flows, lockId).map((d) => d.name);
    const relevantForAgg = relevant.map((l) => ({ lock_id: l.lock_id, label: l.label, gating_doors: gatingDoorsFor(l.lock_id) }));
    const access = currentAccessModel();
    const base = keypadUsers.aggregateKeypadUsers(zwLocks, relevantForAgg);
    const verdicts = new Map();
    for (const u of base) {
      for (const v of accessGating.classifyLocksForUser(u.user_id, relevant.map((l) => ({ lock_id: l.lock_id })), config.door_flows, access)) {
        verdicts.set(`${u.user_id}|${v.lock_id}`, v.verdict);
      }
    }
    const users = keypadUsers.aggregateKeypadUsers(zwLocks, relevantForAgg, verdicts).map((u) => Object.assign(u, {
      user_missing: !!(u.user_id && known.size && !known.has(u.user_id)),
    }));
    res.json({
      locks: capable.map((l) => {
        const doors = gatingDoorsFor(l.lock_id);
        return {
          lock_id: l.lock_id,
          name: l.label,
          supported: !!(l.cap && l.cap.supported !== false),
          note: (l.cap && l.cap.note) || null,
          // Compat single field + the full list for multi-door gating.
          gating_door: doors[0] || null,
          gating_doors: doors,
        };
      }),
      pin_rule: keypadUsers.combinedLengthRule(relevant.map((l) => l.cap)),
      access_gating: accessGatingStatus(),
      // Pickable users straight from the live sync (in-memory, zero extra
      // I/O). The frontend picker sources from THIS on every refresh, so it
      // self-heals after a boot that raced the controller and never goes
      // stale after a Save/Remove (the old page-load /api/users snapshot
      // could stay empty for a whole session).
      available_users: [...known.entries()]
        .map(([id, nm]) => ({ id, name: nm }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
      users,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set a user's ONE PIN: written to every code-capable lock (sequentially -
// battery locks queue writes), then always synced to the user's UniFi PIN.
// Locks that cannot take the code (full, duplicate, length rule) are reported
// per lock; the save proceeds on the rest.
app.post('/api/deadbolt/keypad-users', async (req, res) => {
  const b = req.body || {};
  if (zwavePairing.isActive()) {
    return res.status(409).json({ error: 'A pairing session is in progress' });
  }
  if (!b.user_id || typeof b.user_id !== 'string') {
    return res.status(400).json({ error: 'user_id is required (pick a synced UniFi user)' });
  }
  const pin = typeof b.pin === 'string' ? b.pin.trim() : '';
  if (!/^[0-9]{4,10}$/.test(pin)) {
    return res.status(400).json({ error: 'pin must be 4 to 10 digits' });
  }
  try {
    const capable = await codeCapableLocks();
    if (!capable.length) {
      return res.status(503).json({ error: 'no paired lock supports keypad codes' });
    }
    const zwLocks = (config.devices && config.devices.zwave && config.devices.zwave.locks) || {};
    const known = (unifiClient && unifiClient.userNames) || new Map();
    const name = (typeof b.name === 'string' && b.name.trim()) || known.get(b.user_id) || null;
    const results = [];

    // Access gating: split the code-capable locks into those this user may
    // hold a code on (allowed / ungated / unknown -> fail open) and those they
    // are confirmed NOT allowed on (denied on EVERY gating door -> block +
    // revoke any existing code; the collapsed UNION verdict, so allowed via a
    // second trigger door always wins). A lock wired to no door is 'ungated'
    // and behaves as before.
    const access = currentAccessModel();
    const verdicts = accessGating.classifyLocksForUser(
      b.user_id, capable.map((l) => ({ lock_id: l.lock_id })), config.door_flows, access
    );
    const verdictByLock = new Map(verdicts.map((v) => [v.lock_id, v]));
    const writable = capable.filter((l) => accessGating.WRITE_VERDICTS.has(verdictByLock.get(l.lock_id).verdict));
    const denied = capable.filter((l) => accessGating.REVOKE_VERDICTS.has(verdictByLock.get(l.lock_id).verdict));

    // All driver-plus-persistence work runs under one lock so a periodic
    // reconcile or a wake-triggered retry cannot interleave with this Save.
    await withKeypadLock(async () => {
      // Revoke first: a user who lost access to a door must not keep a working
      // code on its deadbolt. Only fires on a CONFIRMED denial (never 'unknown').
      // revokeHeldCode marks revoked true only when the physical clear confirms;
      // an unconfirmed clear reports revoke_pending and queues a retry.
      for (const l of denied) {
        const v = verdictByLock.get(l.lock_id);
        const reason = `no UniFi access to "${v.doors.join('", "')}"`;
        const held = Object.entries((zwLocks[l.lock_id] && zwLocks[l.lock_id].user_codes) || {})
          .find(([, e]) => e && e.user_id === b.user_id);
        if (held) {
          const r = await revokeHeldCode(
            { lockId: l.lock_id, driver: l.driver, label: l.label },
            Number(held[0]), b.user_id, reason);
          results.push({ lock_id: l.lock_id, blocked: true, revoked: r.revoked, revoke_pending: r.revoke_pending, reason });
        } else {
          results.push({ lock_id: l.lock_id, blocked: true, revoked: false, revoke_pending: false, reason });
        }
      }

      const plan = keypadUsers.planUserSave(
        zwLocks,
        writable.map((l) => ({ lock_id: l.lock_id, cap: l.cap })),
        b.user_id, pin
      );
      for (const row of plan) {
        if (row.error) { results.push(row); continue; }
        const entry = capable.find((l) => l.lock_id === row.lock_id);
        try {
          const r = await entry.driver.setUserCode(row.slot, pin);
          if (r.confirmed === false) {
            results.push({ lock_id: row.lock_id, error: 'the lock rejected this code (usually a duplicate PIN or a mismatched code length)' });
            continue;
          }
          persistZwaveMutation((cfg) => {
            const locks = cfg.devices && cfg.devices.zwave && cfg.devices.zwave.locks;
            if (!locks || !locks[row.lock_id]) return;
            locks[row.lock_id].user_codes = locks[row.lock_id].user_codes || {};
            locks[row.lock_id].user_codes[String(row.slot)] = {
              user_id: b.user_id,
              name,
              pin_code: pin,
              pushed_to_unifi: false,
              confirmed: r.confirmed === true ? true : null,
              updated_at: new Date().toISOString(),
            };
            // Writing this slot supersedes any queued clear for it, so drop a
            // stale pending_clears marker rather than let a retry wipe the new code.
            if (locks[row.lock_id].pending_clears) delete locks[row.lock_id].pending_clears[String(row.slot)];
          });
          results.push({ lock_id: row.lock_id, slot: row.slot, confirmed: r.confirmed });
        } catch (e) {
          results.push({ lock_id: row.lock_id, error: e.message });
        }
      }
    });
    const written = results.filter((r) => r.slot != null);
    const revokedCount = results.filter((r) => r.revoked).length;
    const pendingCount = results.filter((r) => r.revoke_pending).length;
    // A total failure is only when writable locks existed and none accepted
    // AND there was no gating action. Being blocked/revoked everywhere is a
    // legitimate gated outcome, not an error, and the UniFi push still runs.
    if (!written.length && !denied.length) {
      return res.status(409).json({ error: 'no lock accepted the code', results });
    }
    // Always keep UniFi in sync: one PIN per user everywhere. The PIN is the
    // user's UniFi credential; UniFi readers enforce their own door access, so
    // we push even if the user is gated off every deadbolt keypad. Skip the
    // API call when UniFi already holds this exact PIN (re-assigning it errors
    // with CODE_SYSTEM_ERROR), then record which entries match UniFi.
    const unifi = { attempted: true, success: null, permission_denied: false, error: null };
    const pushPlan = planUnifiPinPush(
      (config.devices && config.devices.zwave && config.devices.zwave.locks) || {},
      written[0] ? written[0].lock_id : null, b.user_id, pin,
      config.unifi_pin_state
    );
    let synced = pushPlan.action === 'skip_in_sync';
    if (synced) {
      unifi.success = true;
      unifi.skipped = 'already in sync';
      logger.info(`Deadbolt: UniFi already holds this PIN for "${name || b.user_id}"; skipping the push`);
    } else if (unifiClient && typeof unifiClient.assignUserPin === 'function') {
      const push = await unifiClient.assignUserPin(b.user_id, pin);
      unifi.success = !!push.success;
      unifi.permission_denied = !!push.permission_denied;
      unifi.error = push.error || null;
      if (push.statusCode) unifi.status_code = push.statusCode;
      synced = !!push.success;
    } else {
      unifi.success = false;
      unifi.error = 'UniFi client is not connected';
    }
    // CODE_SYSTEM_ERROR is UniFi's "that PIN already exists" rejection. It is
    // ambiguous (this user's own PIN = harmless, someone else's = pick a new
    // one), so explain rather than guess; state is never written on failure.
    if (!unifi.success && /CODE_SYSTEM_ERROR/i.test(unifi.error || '')) {
      unifi.hint = 'UniFi already has this exact PIN. If it is this user\'s existing PIN everything already matches; if another user holds it, choose a different PIN (UniFi PINs are unique per person).';
    }
    if (synced) {
      const now = new Date().toISOString();
      persistZwaveMutation((cfg) => {
        const locks = (cfg.devices && cfg.devices.zwave && cfg.devices.zwave.locks) || {};
        for (const lock of Object.values(locks)) {
          for (const e of Object.values((lock && lock.user_codes) || {})) {
            if (!e || e.user_id !== b.user_id) continue;
            // Entries holding THIS pin now match UniFi; an older different
            // PIN on some lock no longer does.
            e.pushed_to_unifi = String(e.pin_code) === pin;
          }
        }
        // Durable user-level memory: survives code deletion/revocation, so a
        // later re-add of the same PIN skips the push UniFi would reject.
        recordUnifiPin(cfg, b.user_id, pin, now);
      });
    }
    broadcastEvent({
      type: 'deadbolt.user_code',
      actor: 'GUI Admin',
      location: (written.length ? written : results).map((r) => lockLabel(r.lock_id)).join(', '),
      action: `PIN set for ${name || b.user_id} on ${written.length}/${results.length} lock(s)`
        + (revokedCount ? `; revoked on ${revokedCount} (no door access)` : '')
        + (pendingCount ? `; revoke pending on ${pendingCount} (lock did not confirm, will retry)` : '')
        + `${unifi.success ? (unifi.skipped ? '; UniFi already in sync' : '; UniFi updated') : '; UniFi push FAILED'}`,
      // A blocked lock (revoked or revoke pending) is a legitimate gated outcome,
      // not a failure. Only a write error leaves an entry that is neither written
      // nor blocked, so count those as the failures.
      success: results.every((r) => r.slot != null || r.blocked) && !!unifi.success,
    });
    res.json({ user_id: b.user_id, name, results, unifi });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a user's keypad code from EVERY lock. Deliberately never touches
// UniFi (same policy as the per-slot delete: the UniFi PIN is a separate
// credential and there is no restore path since UniFi never reveals PINs).
app.delete('/api/deadbolt/keypad-users/:user_id', async (req, res) => {
  const userId = req.params.user_id;
  if (zwavePairing.isActive()) {
    return res.status(409).json({ error: 'A pairing session is in progress' });
  }
  try {
    const zwLocks = (config.devices && config.devices.zwave && config.devices.zwave.locks) || {};
    const holdings = [];
    for (const [lockId, lock] of Object.entries(zwLocks)) {
      for (const [slot, e] of Object.entries((lock && lock.user_codes) || {})) {
        if (e && e.user_id === userId) holdings.push({ lock_id: lockId, slot: Number(slot), name: (e && e.name) || null });
      }
    }
    if (!holdings.length) {
      return res.status(404).json({ error: 'no saved keypad code for that user' });
    }
    const removedName = (holdings.find((h) => h.name) || {}).name || null;
    const results = [];
    // Route through the shared executor so an unconfirmed clear (a sleeping
    // lock) reports revoke_pending and queues a retry rather than claiming the
    // code was removed. The user's UniFi PIN is a separate credential, untouched.
    await withKeypadLock(async () => {
      for (const h of holdings) {
        const driver = lockDrivers.get(h.lock_id);
        const r = await revokeHeldCode(
          { lockId: h.lock_id, driver, label: lockLabel(h.lock_id) },
          h.slot, userId, 'removed by admin');
        results.push(Object.assign(
          { lock_id: h.lock_id, slot: h.slot, confirmed: r.confirmed, revoke_pending: r.revoke_pending },
          r.error ? { error: r.error } : {}));
      }
    });
    const pendingClears = results.filter((r) => r.revoke_pending).length;
    broadcastEvent({
      type: 'deadbolt.user_code',
      actor: 'GUI Admin',
      location: holdings.map((h) => lockLabel(h.lock_id)).join(', '),
      action: `Keypad code removed for ${removedName || userId} on ${holdings.length} lock(s)`
        + (pendingClears ? `; ${pendingClears} clear(s) pending, will retry when the lock responds` : '')
        + ". The user's UniFi PIN is untouched",
      success: results.every((r) => !r.error),
    });
    res.json({ user_id: userId, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
  const target = resolveLockRequest(req, res);
  if (!target) return;
  if (typeof target.driver.reinterview !== 'function') {
    return res.status(503).json({ error: 'the active lock driver does not support re-interview' });
  }
  try {
    _reinterviewRequested.add(target.lockId);
    target.driver.reinterview().then(
      // refreshInfo resolves when the interview is re-QUEUED, not finished;
      // the driver's 'interview-completed' listener logs actual completion.
      () => logger.info(`Deadbolt: re-interview request accepted for "${target.lockId}" (interview re-queued; completion is logged when the node finishes; wake the lock to speed it up)`),
      (err) => {
        _reinterviewRequested.delete(target.lockId);
        logger.warn(`Deadbolt: re-interview failed: ${err.message}`);
      }
    );
    res.json({ status: 'started', lock_id: target.lockId });
  } catch (err) {
    _reinterviewRequested.delete(target.lockId);
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
  const r = capture.start((req.body && req.body.label) || 'capture');
  applyEventTaps(); // ensure the tap is installed even with no add-on configured
  res.json(r);
});
app.post('/api/capture/stop', (req, res) => {
  const r = capture.stop();
  applyEventTaps(); // tear the tap back down if nothing else needs it
  res.json(r);
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
        policy_id: '', policy_name: '', result: 'ACCESS',
        reason_code: reason_code !== undefined ? parseInt(reason_code) : undefined
      }
    }
  };

  logger.info(`Simulating event: type=${synthetic.event} at "${location}"`);

  try {
    // Drive the live automation path (the deadbolt controller observers) the
    // same way a real event does; the rules engine is no longer live.
    for (const controller of deadboltObservers()) {
      try { controller.observe(synthetic); } catch (err) { logger.warn(`deadbolt observe error: ${err.message}`); }
    }
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
  const out = redactSecrets(config);
  // Transition (one release): external readers of the legacy shapes keep
  // working via a COMPUTED projection derived from door_flows. Never
  // persisted; a multi-door lock projects only its first edge.
  const projection = doorFlows.legacyProjection(config.door_flows);
  out.deadbolt_rules = projection.deadbolt_rules;
  out.cascade_rules = projection.cascade_rules;
  out.unlock_rules = projection.unlock_rules;
  out.doorbell_rules = projection.doorbell_rules;
  res.json(out);
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

    // Transition (one release): external writers may still PUT the legacy
    // automation keys (deadbolt_rules, cascade_rules, unlock_rules,
    // doorbell_rules). Fold each into the trigger-shaped door_flows WITHOUT
    // disturbing the categories it does not own: retract edges, everyone
    // cascades, group unlocks and doorbell triggers are independent. door_flows
    // stays the sole persisted shape.
    const legacyRuleKeys = ['deadbolt_rules', 'cascade_rules', 'unlock_rules', 'doorbell_rules'];
    if (legacyRuleKeys.some((k) => updates[k] !== undefined)) {
      const locks = current.devices && current.devices.zwave && current.devices.zwave.locks;
      const flows = JSON.parse(JSON.stringify(current.door_flows || {}));
      const isEntry = (t) => (t.type || 'entry') === 'entry';
      const everyoneEntry = (door) => {
        flows[door] = flows[door] || { door_id: null, triggers: [] };
        if (!Array.isArray(flows[door].triggers)) flows[door].triggers = [];
        let t = flows[door].triggers.find((x) => isEntry(x) && x.scope == null);
        if (!t) { t = { type: 'entry', scope: null, actions: { unlock: null, retract: [] } }; flows[door].triggers.push(t); }
        if (!t.actions) t.actions = { unlock: null, retract: [] };
        if (!Array.isArray(t.actions.retract)) t.actions.retract = [];
        return t;
      };

      // deadbolt_rules -> everyone-entry retract edges (repoint each lock).
      if (updates.deadbolt_rules !== undefined) {
        const normalized = deadboltRules.normalizePutRules(
          updates.deadbolt_rules,
          doorFlows.legacyProjection(current.door_flows || {}).deadbolt_rules,
          locks
        );
        const incoming = doorFlows.migrateToFlows({ deadbolt_rules: normalized }, locks).flows;
        const touchedLocks = new Set(doorFlows.automatedLockIdsFromFlows(incoming));
        for (const k of Object.keys(normalized || {})) {
          if (!deadboltRules.FLAT_KEYS.includes(k)) touchedLocks.add(k);
        }
        // Only the everyone-entry trigger owns the legacy deadbolt_rules retract;
        // a doorbell or group-scoped retract is a category deadbolt_rules never
        // expressed, so it must survive an unrelated deadbolt_rules PUT.
        for (const door of Object.keys(flows)) {
          for (const t of (flows[door].triggers || [])) {
            if (isEntry(t) && t.scope == null && t.actions && Array.isArray(t.actions.retract)) {
              t.actions.retract = t.actions.retract.filter((e) => !e || !touchedLocks.has(e.lock_id));
            }
          }
        }
        for (const [door, flow] of Object.entries(incoming)) {
          const t = everyoneEntry(door);
          if (flow.door_id && !flows[door].door_id) flows[door].door_id = flow.door_id;
          for (const edge of (flow.retract || [])) t.actions.retract.push(edge);
        }
      }

      // cascade_rules -> everyone-entry unlock action (per mentioned door).
      if (updates.cascade_rules !== undefined) {
        const incoming = doorFlows.migrateToFlows({ cascade_rules: updates.cascade_rules }, locks).flows;
        for (const [door, flow] of Object.entries(incoming)) {
          if (!flow.cascade || !Array.isArray(flow.cascade.unlock) || !flow.cascade.unlock.length) continue;
          const t = everyoneEntry(door);
          if (flow.door_id && !flows[door].door_id) flows[door].door_id = flow.door_id;
          t.actions.unlock = [{
            doors: [...flow.cascade.unlock],
            door_ids: Array.isArray(flow.cascade.unlock_ids) ? [...flow.cascade.unlock_ids] : undefined,
            debounce_seconds: flow.cascade.debounce_seconds == null ? 8 : flow.cascade.debounce_seconds,
            delay_seconds: 0,
          }];
        }
      }

      // unlock_rules -> scoped entry triggers (full replace of that category).
      if (updates.unlock_rules !== undefined) {
        for (const door of Object.keys(flows)) {
          flows[door].triggers = (flows[door].triggers || []).filter((t) => !(isEntry(t) && t.scope != null));
        }
        const fresh = doorFlows.migrateToTriggers({ unlock_rules: updates.unlock_rules }, locks).flows;
        for (const [door, flow] of Object.entries(fresh)) {
          flows[door] = flows[door] || { door_id: flow.door_id || null, triggers: [] };
          if (!Array.isArray(flows[door].triggers)) flows[door].triggers = [];
          for (const t of flow.triggers) if (isEntry(t) && t.scope != null) flows[door].triggers.push(t);
        }
      }

      // doorbell_rules -> doorbell triggers (full replace of that category).
      if (updates.doorbell_rules !== undefined) {
        for (const door of Object.keys(flows)) {
          flows[door].triggers = (flows[door].triggers || []).filter((t) => (t.type || 'entry') !== 'doorbell');
        }
        const fresh = doorFlows.migrateToTriggers({ doorbell_rules: updates.doorbell_rules }, locks).flows;
        for (const [door, flow] of Object.entries(fresh)) {
          flows[door] = flows[door] || { door_id: flow.door_id || null, triggers: [] };
          if (!Array.isArray(flows[door].triggers)) flows[door].triggers = [];
          for (const t of flow.triggers) if ((t.type || 'entry') === 'doorbell') flows[door].triggers.push(t);
        }
      }

      // Drop empty triggers / doors.
      for (const door of Object.keys(flows)) {
        flows[door].triggers = (flows[door].triggers || []).filter((t) => {
          const hasUnlock = doorFlows.unlockActionsOf(t).length > 0;
          const hasRetract = t.actions && Array.isArray(t.actions.retract) && t.actions.retract.length;
          return hasUnlock || hasRetract;
        });
        if (!flows[door].triggers.length) delete flows[door];
      }
      updates.door_flows = flows;
      for (const k of legacyRuleKeys) delete updates[k];
    }

    // door_flows is validated and REPLACED whole (deep-merge cannot express
    // a deletion, which is exactly how the old shape accumulated ghosts).
    if (updates.door_flows !== undefined) {
      const flowErrors = doorFlows.validateFlows(updates.door_flows);
      if (flowErrors.length) {
        return res.status(400).json({ error: `door_flows invalid: ${flowErrors.join('; ')}` });
      }
    }

    // Deep merge updates (only allow specific safe keys). door_flows is
    // handled with REPLACE semantics below, never deep-merged.
    // unlock_rules / doorbell_rules are NOT here: they are folded into
    // door_flows above and deleted, so they never deep-merge onto disk.
    const safeKeys = ['event_source', 'logging', 'server', 'unifi', 'resolver', 'doors', 'backup', 'watchdog', 'auto_lock', 'auto_sync', 'devices', 'door_flows', 'alerts', 'setup_wizard'];

    // recursive merge for plain objects: source values override primitives/arrays
    function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
    // Keys that would let a crafted PUT body walk into Object.prototype via the
    // assignment below. JSON.parse makes __proto__ an own enumerable key, so
    // Object.keys surfaces it; skip the whole dangerous set defensively (this
    // endpoint is admin-gated, but the guard is free).
    const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
    function deepMerge(target, source) {
      if (!isPlainObject(source)) return source;
      if (!isPlainObject(target)) target = {};
      for (const k of Object.keys(source)) {
        if (UNSAFE_KEYS.has(k)) continue;
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
        if (key === 'door_flows') {
          // WHOLE-OBJECT REPLACE: an edge/door removed by the editor must
          // actually go away; deep-merge would resurrect it.
          current[key] = updates[key];
        } else if (isPlainObject(updates[key]) && isPlainObject(current[key])) {
          current[key] = deepMerge(current[key], updates[key]);
        } else {
          current[key] = updates[key];
        }
      }
    }
    // The file carries door_flows only; stale legacy keys (old backup/hand
    // edit) are dropped on every save.
    delete current.deadbolt_rules;
    delete current.cascade_rules;
    delete current.unlock_rules;
    delete current.doorbell_rules;

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
// Door Flows API - the door-centric automation editor's endpoints.
// door_flows is the sole persisted automation shape; PUT REPLACES it whole
// (deep-merge cannot express a deleted edge/door).
// ---------------------------------------------------------------------------

// Per-edge hardware-conflict annotation + response warnings: a stay_unlocked
// edge cannot hold the bolt open when the LOCK's own hardware auto-relock
// timer is on (a device-level Z-Wave parameter). The app never fights the
// hardware; it tells the operator where to change it.
function doorFlowWarnings(flows) {
  const zwLocks = (config.devices && config.devices.zwave && config.devices.zwave.locks) || {};
  const warnings = [];
  for (const [door, flow] of Object.entries(flows || {})) {
    for (const trig of doorFlows.triggersOf(flow)) {
      const retract = trig.actions && Array.isArray(trig.actions.retract) ? trig.actions.retract : [];
      for (const edge of retract) {
        if (!edge || !edge.lock_id) continue;
        const hw = zwLocks[edge.lock_id] && zwLocks[edge.lock_id].auto_relock;
        if (edge.after_unlock === 'stay_unlocked' && hw === true) {
          warnings.push(`"${lockLabel(edge.lock_id)}" still has its hardware auto-relock on, so "stay unlocked" from "${door}" cannot hold it open yet. The app is turning it off; this clears once the lock confirms.`);
        }
      }
    }
  }
  return warnings;
}

app.get('/api/door-flows', (req, res) => {
  try {
    const flows = config.door_flows || {};
    const zwLocks = (config.devices && config.devices.zwave && config.devices.zwave.locks) || {};
    // Doors the editor can offer: everything the controller knows about plus
    // any door that already has a flow (it may be temporarily undiscovered).
    const doorSet = new Map(); // name -> id|null
    if (unifiClient && unifiClient.doors) {
      for (const [name, id] of unifiClient.doors) doorSet.set(name, String(id));
    }
    for (const [door, flow] of Object.entries(flows)) {
      if (!doorSet.has(door)) doorSet.set(door, (flow && flow.door_id) || null);
    }
    // Annotate per-edge hardware conflicts (computed, never persisted). The
    // editor consumes the trigger shape; a flat legacy flow normalizes first.
    const annotated = {};
    for (const [door, flow] of Object.entries(flows)) {
      const triggers = doorFlows.triggersOf(flow).map((trig) => {
        const retract = (trig.actions && Array.isArray(trig.actions.retract) ? trig.actions.retract : []).map((e) => Object.assign({}, e, {
          hardware_conflict: !!(e && e.after_unlock === 'stay_unlocked'
            && zwLocks[e.lock_id] && zwLocks[e.lock_id].auto_relock === true),
        }));
        return Object.assign({}, trig, { actions: Object.assign({}, trig.actions, { retract }) });
      });
      annotated[door] = { door_id: (flow && flow.door_id) || null, triggers };
    }
    res.json({
      doors: [...doorSet.entries()].map(([name, id]) => ({ name, id, discovered: !!(unifiClient && unifiClient.doors && unifiClient.doors.has(name)) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      flows: annotated,
      locks: Object.entries(zwLocks).map(([lockId, lc]) => ({
        lock_id: lockId,
        name: lockLabel(lockId),
        paired: !!(lc && lc.node_id > 0),
        bound: lockDrivers.has(lockId),
        hardware_auto_relock: !lc || lc.auto_relock == null ? null : !!lc.auto_relock,
      })),
      warnings: doorFlowWarnings(flows),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Canonicalize one trigger from the editor: drop annotations, fill defaults,
// keep only the two written after-unlock modes.
function cleanDoorFlowTrigger(trig) {
  const type = trig && trig.type === 'doorbell' ? 'doorbell' : 'entry';
  let scope = null;
  const rs = trig && trig.scope;
  if (rs && typeof rs === 'object') {
    if (rs.any_group === true) scope = { any_group: true };
    else if (Array.isArray(rs.groups)) {
      const g = rs.groups.filter((x) => typeof x === 'string' && x.trim());
      if (g.length) scope = { groups: g };
    }
  }
  const actions = (trig && trig.actions) || {};
  const retract = (Array.isArray(actions.retract) ? actions.retract : []).map((e) => ({
    lock_id: e.lock_id,
    after_unlock: (e.after_unlock === 'relock_after' || e.after_unlock === 'stay_unlocked') ? e.after_unlock
      : (e.after_unlock === 'lock_default' ? 'lock_default' : 'stay_unlocked'),
    relock_seconds: e.relock_seconds == null ? null : e.relock_seconds,
    require_result: e.require_result || 'ACCESS',
    mirror_unlock: !!e.mirror_unlock,
    relock_cooldown_seconds: e.relock_cooldown_seconds == null ? 10 : e.relock_cooldown_seconds,
  })).filter((e) => typeof e.lock_id === 'string' && e.lock_id);
  // unlock is an ARRAY of actions; a legacy single object normalizes to [obj].
  const rawUnlock = Array.isArray(actions.unlock) ? actions.unlock
    : (actions.unlock ? [actions.unlock] : []);
  const unlock = rawUnlock
    .filter((u) => u && Array.isArray(u.doors) && u.doors.some((d) => typeof d === 'string' && d))
    .map((u) => ({
      doors: u.doors.filter((d) => typeof d === 'string' && d),
      door_ids: Array.isArray(u.door_ids) ? [...u.door_ids] : undefined,
      debounce_seconds: u.debounce_seconds == null ? 8 : u.debounce_seconds,
      delay_seconds: u.delay_seconds == null ? 0 : u.delay_seconds,
    }));
  const out = { type, scope, actions: { unlock, retract } };
  if (type === 'doorbell') {
    const db = (trig && trig.doorbell) || {};
    out.doorbell = {
      reason_code: Number.isFinite(db.reason_code) ? db.reason_code : 107,
      viewer_to_group: (db.viewer_to_group && typeof db.viewer_to_group === 'object') ? db.viewer_to_group : {},
    };
  }
  return out;
}

app.put('/api/door-flows', async (req, res) => {
  const body = req.body || {};
  // Accept {flows: {...}} or the bare flows object.
  const flows = body.flows && typeof body.flows === 'object' ? body.flows : body;
  const errors = doorFlows.validateFlows(flows);
  if (errors.length) {
    return res.status(400).json({ error: errors.join('; ') });
  }
  // Strip client-side annotations and canonicalize before persisting. The
  // editor sends the trigger shape; a flat legacy payload normalizes first.
  const clean = {};
  for (const [door, flow] of Object.entries(flows)) {
    const triggers = doorFlows.triggersOf(flow).map(cleanDoorFlowTrigger).filter((t) => {
      const hasUnlock = Array.isArray(t.actions.unlock) && t.actions.unlock.length;
      return hasUnlock || t.actions.retract.length;
    });
    if (triggers.length) clean[door] = { door_id: flow.door_id || null, triggers };
  }
  try {
    const current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    current.door_flows = clean;    // REPLACE, never merge
    delete current.deadbolt_rules; // door_flows is the sole persisted shape
    delete current.cascade_rules;
    delete current.unlock_rules;
    delete current.doorbell_rules;
    writeConfigFile(current);
    if (configSync) configSync.markConfigApplied();
    logger.info(`Door flows saved (${Object.keys(clean).length} door(s))`);
    // Live apply: reload from disk (rebuilds controllers via the door_flows
    // signature), backfill any new door ids, and re-run access gating since
    // the gating doors may just have changed.
    let reloadMode = 'skipped';
    try {
      const result = await reloadOrchestrator({
        reason: 'door_flows_saved',
        actor: 'API',
        eventType: 'system.config_reload',
        actionPrefix: 'Door flows reloaded',
      });
      reloadMode = result.mode;
    } catch (reloadErr) {
      logger.warn(`Auto-reload after door-flows save failed: ${reloadErr.message}`);
    }
    backfillTriggerDoorIds();
    scheduleReconcile('door_flows_changed');
    res.json({ status: 'saved', reload_mode: reloadMode, warnings: doorFlowWarnings(clean) });
  } catch (err) {
    logger.error(`Door flows save failed: ${err.message}`);
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
    // A pre-redesign backup restores legacy deadbolt_rules/cascade_rules;
    // migrate them forward to door_flows right away (after the flat->map
    // canonicalization below).
    logger.info(`Config restored from backup: ${filename}`);
    if (configSync) configSync.markConfigApplied();
    // A restored backup may be a pre-migration (flat) config; canonicalize it
    // on disk immediately so the reload below and later PUTs work on the map
    // shape. markApplied so this write does not itself trigger a reload.
    migrateConfigFileOnDisk(true);
    migrateDoorFlowsOnDisk(true);

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
  // Default to websocket: it matches the shipped example configs and the
  // README ("listens over WebSocket by default"). An unset mode previously
  // fell back to 'alarm_manager', which has no ingestion branch here, so a
  // config that omitted event_source.mode started no event source at all and
  // the feed stayed empty. connectWebSocket still guards a missing host.
  const mode = config.event_source?.mode || 'websocket';
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
    // Live automation runs off the raw tap (setRawTap -> deadbolt observers),
    // which sees every event pre-whitelist. This whitelisted callback only
    // records liveness + the raw log; the rules engine is no longer live.
    unifiClient.connectWebSocket((event) => {
      lastEventTime = Date.now();
      storeRawPayload('websocket', event);
      // Display-only: project the observed access event onto the Live Events
      // feed. This does NOT run automation (the deadbolt/cascade controller
      // owns that via the raw tap); it only mirrors what happened so the feed
      // is not empty on a normal install. describeForFeed is pure.
      try {
        const feed = rulesEngine.describeForFeed(event);
        if (feed) broadcastEvent({ ...feed, action: '' });
      } catch (e) {
        logger.warn(`Live feed projection failed: ${e.message}`);
      }
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
  const mode = config.event_source?.mode || 'websocket';
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

// Apply door_flows edits live, REUSING the running lock driver (no Z-Wave
// reconnect). Called from reloadServices when the flows signature changed.
// Removing all flows detaches (and DESTROYS - timers/listeners) the
// controllers; adding flows when a paired lock exists but no driver was built
// yet takes the full activation path (safe: the driver is not running, so
// nothing reconnects).
async function maybeRebuildDeadboltRules(oldSig) {
  const newSig = JSON.stringify(config.door_flows);
  if (newSig === oldSig) return;
  if (!config.door_flows || !Object.keys(config.door_flows).length) {
    destroyDeadboltControllers();
    deadboltController = null;
    applyEventTaps();
    logger.info('Door flows removed: controllers detached (lock drivers untouched)');
    return;
  }
  const zw = config.devices && config.devices.zwave;
  // Build drivers whenever Z-Wave is enabled, not only when rules exist: a
  // paired lock is controllable (test/PIN) even with no automation.
  if (!lockDrivers.size && zw && zw.enabled) {
    await bringDeadboltOnline();
    return;
  }
  // Controllers rebuild from the current rules against the RUNNING drivers;
  // the Z-Wave connections are never touched by a rules edit.
  buildDeadboltControllers();
  applyEventTaps();
  // A rules edit may have newly wired a lock; hand its hardware auto-relock off.
  ensureHardwareAutoRelockOff().catch((e) => logger.warn(`Deadbolt: hardware auto-relock handoff error: ${e.message}`));
  logger.info(`Deadbolt rules updated live (automated: ${deadboltControllers.size}, cascade rules: ${cascadeController ? cascadeController.cascadeRules.length : 0}); lock drivers untouched`);
}

async function reloadServices(newConfig) {
  const settingsChanged = controllerOrSourceChanged(config, newConfig);
  const degraded = isEventSourceDegraded();
  const fullReload = settingsChanged || degraded;
  const oldRulesSig = JSON.stringify(config.door_flows);

  if (degraded && !settingsChanged) {
    logger.info('Reload: event source is degraded — escalating to full reconnect');
  }

  if (fullReload) {
    logger.info('Reload: controller/event-source settings changed — rebuilding UniFi client');
    unifiClient.shutdown();
    unifiClient = new UniFiClient(newConfig);
    wireUnifiClientCallbacks(unifiClient);
    resolver = new Resolver(newConfig, unifiClient);
    rulesEngine = new RulesEngine(rulesEngineConfig(newConfig), unifiClient, resolver);
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
      unifiClient.startHealthMonitor(onUnifiStateChange);
    } else {
      unifiClient.initializeWithRetry().then(() => unifiClient.startHealthMonitor(onUnifiStateChange));
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
    unifiClient.startHealthMonitor(onUnifiStateChange);
    backfillTriggerDoorIds();
  } else {
    logger.warn('Initial connection failed. Retrying in background...');
    unifiClient.initializeWithRetry().then(() => {
      unifiClient.startHealthMonitor(onUnifiStateChange);
      backfillTriggerDoorIds();
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
  // event stream before the event source connects. Drivers init concurrently;
  // one lock's failure never blocks another's startup.
  buildDeadbolt();
  {
    const entries = Array.from(lockDrivers.entries());
    const results = await Promise.allSettled(entries.map(([, driver]) => driver.init()));
    results.forEach((r, i) => {
      const lockId = entries[i][0];
      if (r.status === 'fulfilled') {
        logger.info(`Deadbolt lock driver initialized ("${lockId}")`);
      } else {
        _noteLockInitFailure(lockId, `${r.reason && r.reason.message}. Retrying automatically; cascade unlock is unaffected.`);
      }
    });
    if (_failedInitLocks.size) scheduleDeadboltInitRetry();
  }
  applyEventTaps();
  // Decision 2: hand the hardware auto-relock off for flow-wired locks so the
  // app owns relock in software (best-effort; retried on rebuild).
  ensureHardwareAutoRelockOff().catch((e) => logger.warn(`Deadbolt: hardware auto-relock handoff error: ${e.message}`));

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
      // the live client. Notify the dashboard so it re-renders, and reconcile
      // keypad codes: a door rename or a newly discovered door can flip a
      // gating verdict, so a user may have just lost access to a lock's door.
      broadcastEvent({
        type: 'system.auto_reload',
        actor: 'auto-sync',
        location: '-',
        action: `Doors changed on controller, refreshed registry`,
        success: true,
        reason
      });
      backfillTriggerDoorIds(); // a rename may have changed a door id or name
      scheduleReconcile('doors_changed');
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
      // Await the Z-Wave lock teardowns (bounded) so listeners unbind cleanly.
      if (lockDrivers.size) await Promise.race([
        Promise.allSettled(Array.from(lockDrivers.values()).map((d) => Promise.resolve(d.shutdown()))),
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
