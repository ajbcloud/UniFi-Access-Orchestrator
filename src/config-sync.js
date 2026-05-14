/**
 * Config Sync Background Job
 *
 * Periodically detects two kinds of pending changes and triggers callbacks:
 *
 *   1. Local config file changes — `config/config.json` was edited on disk
 *      (mtime + sha256). Triggers `onConfigFileChanged(reason)` so the
 *      caller can run the same in-place reload as POST /reload.
 *
 *   2. Upstream UniFi controller changes — door list or user/group
 *      membership changed (sha256 of sorted door-id list and
 *      user-id->group-name map). Triggers `onControllerDoorsChanged` /
 *      `onControllerUsersChanged` callbacks.
 *
 * Read-only contract:
 *   - This module never writes to `config/config.json`.
 *   - This module never PATCHes/POSTs to the UniFi controller. It only
 *     calls the existing GET-based `discoverDoors()` and `syncUserGroups()`
 *     helpers on the live client.
 *
 * Configuration (config.auto_sync):
 *   { enabled: true, interval_seconds: 15 }   // 5–600s
 */

const fs = require('fs');
const crypto = require('crypto');
const logger = require('./logger');

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function hashDoors(client) {
  if (!client || !client.doorsById) return null;
  const ids = [...client.doorsById.keys()].sort();
  const data = ids.map(id => `${id}:${client.doorsById.get(id)}`).join('\n');
  return sha256(data);
}

function hashUsers(client) {
  if (!client || !client.userGroupMap) return null;
  const entries = [...client.userGroupMap.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const data = entries.map(([uid, g]) => `${uid}:${g}`).join('\n');
  return sha256(data);
}

class ConfigSync {
  constructor({
    configPath,
    getUnifiClient,
    onConfigFileChanged,
    onControllerDoorsChanged,
    onControllerUsersChanged,
    onError
  }) {
    this.configPath = configPath;
    this.getUnifiClient = getUnifiClient || (() => null);
    this.onConfigFileChanged = onConfigFileChanged || (async () => {});
    this.onControllerDoorsChanged = onControllerDoorsChanged || (async () => {});
    this.onControllerUsersChanged = onControllerUsersChanged || (async () => {});
    this.onError = onError || (() => {});

    this.timer = null;
    this.tickInProgress = false;
    this.enabled = false;
    this.intervalSeconds = 15;
    // Generation token: incremented on every start()/stop() so any in-flight
    // tick whose finally-handler tries to reschedule can detect that a newer
    // start() (e.g. the one inside reloadOrchestrator after a config-file
    // change) has already taken over. Without this, a tick that triggered a
    // reload would spawn a duplicate timer chain.
    this.generation = 0;

    this.lastConfigMtimeMs = 0;
    this.lastConfigHash = null;
    this.lastDoorsHash = null;
    this.lastUsersHash = null;

    this.lastRunAt = null;
    this.lastChangeDetectedAt = null;
    this.lastError = null;
  }

  start({ enabled = true, intervalSeconds = 15 } = {}) {
    this.stop();
    this.enabled = enabled !== false;
    this.intervalSeconds = Math.min(600, Math.max(5, parseInt(intervalSeconds, 10) || 15));
    this.generation++;
    if (!this.enabled) {
      logger.info('Config sync job disabled');
      return;
    }
    this._seedBaselines();
    this._scheduleNext(this.generation);
    logger.info(`Config sync job started: every ${this.intervalSeconds}s (gen ${this.generation})`);
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.enabled = false;
    this.generation++;
  }

  // Re-seed file baseline after a known-good in-process config write
  // (PUT /api/config, restore backup) so the next tick doesn't see it
  // as an external change.
  markConfigApplied() {
    try {
      const stat = fs.statSync(this.configPath);
      this.lastConfigMtimeMs = stat.mtimeMs;
      this.lastConfigHash = sha256(fs.readFileSync(this.configPath, 'utf-8'));
    } catch (err) {
      logger.debug(`markConfigApplied failed: ${err.message}`);
    }
  }

  // Re-seed controller baselines after a full client rebuild so the
  // next tick doesn't false-trigger.
  resyncControllerBaselines() {
    const client = this.getUnifiClient();
    this.lastDoorsHash = hashDoors(client);
    this.lastUsersHash = hashUsers(client);
  }

  getState() {
    return {
      enabled: this.enabled,
      interval_seconds: this.intervalSeconds,
      last_run_at: this.lastRunAt,
      last_change_detected_at: this.lastChangeDetectedAt,
      last_error: this.lastError
    };
  }

  _seedBaselines() {
    try {
      const stat = fs.statSync(this.configPath);
      this.lastConfigMtimeMs = stat.mtimeMs;
      this.lastConfigHash = sha256(fs.readFileSync(this.configPath, 'utf-8'));
    } catch (err) {
      logger.warn(`Config sync: initial config baseline failed: ${err.message}`);
    }
    this.resyncControllerBaselines();
  }

  _scheduleNext(generation) {
    // If a newer start()/stop() has bumped the generation since this chain
    // was scheduled, abandon it — the new timer chain owns the schedule.
    if (!this.enabled || generation !== this.generation) return;
    const baseMs = this.intervalSeconds * 1000;
    const jitter = Math.floor(Math.random() * Math.min(2000, baseMs * 0.1));
    this.timer = setTimeout(() => {
      this._tick(generation).finally(() => this._scheduleNext(generation));
    }, baseMs + jitter);
  }

  async _tick(generation) {
    if (this.tickInProgress) return;
    // Bail early if a reload+restart bumped the generation while we were
    // queued — the new chain will run its own ticks.
    if (generation !== undefined && generation !== this.generation) return;
    this.tickInProgress = true;
    try {
      await this._checkConfigFile();
      await this._checkController();
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
      logger.warn(`Config sync tick error: ${err.message}`);
      try { this.onError(err); } catch (_) {}
    } finally {
      this.lastRunAt = new Date().toISOString();
      this.tickInProgress = false;
    }
  }

  async _checkConfigFile() {
    let stat;
    try {
      stat = fs.statSync(this.configPath);
    } catch (err) {
      throw new Error(`config.json stat failed: ${err.message}`);
    }
    if (stat.mtimeMs === this.lastConfigMtimeMs) return;

    const content = fs.readFileSync(this.configPath, 'utf-8');
    const hash = sha256(content);
    if (hash === this.lastConfigHash) {
      // Touched but content unchanged — refresh mtime baseline only.
      this.lastConfigMtimeMs = stat.mtimeMs;
      return;
    }

    logger.info('Config sync: detected config.json change on disk');
    this.lastConfigMtimeMs = stat.mtimeMs;
    this.lastConfigHash = hash;
    this.lastChangeDetectedAt = new Date().toISOString();

    await this.onConfigFileChanged({ reason: 'config_file_changed' });

    // The reload may have rebuilt the client; resync controller baselines
    // so the next tick compares against the fresh state.
    this.resyncControllerBaselines();
  }

  async _checkController() {
    const client = this.getUnifiClient();
    if (!client) return;
    // Skip while the client is reconnecting/initializing — pulling now
    // would just produce noisy errors.
    if (client.connectionState && client.connectionState !== 'connected') return;

    let doorsChanged = false;
    let usersChanged = false;

    try {
      await client.discoverDoors();
      const h = hashDoors(client);
      if (this.lastDoorsHash !== null && h !== this.lastDoorsHash) doorsChanged = true;
      this.lastDoorsHash = h;
    } catch (err) {
      throw new Error(`door discovery failed: ${err.message}`);
    }

    try {
      await client.syncUserGroups();
      const h = hashUsers(client);
      if (this.lastUsersHash !== null && h !== this.lastUsersHash) usersChanged = true;
      this.lastUsersHash = h;
    } catch (err) {
      throw new Error(`user sync failed: ${err.message}`);
    }

    if (doorsChanged) {
      this.lastChangeDetectedAt = new Date().toISOString();
      logger.info('Config sync: controller doors changed');
      try {
        await this.onControllerDoorsChanged({ reason: 'controller_doors_changed' });
      } catch (e) {
        logger.warn(`onControllerDoorsChanged callback failed: ${e.message}`);
      }
    }
    if (usersChanged) {
      this.lastChangeDetectedAt = new Date().toISOString();
      logger.info('Config sync: controller users/groups changed');
      try {
        await this.onControllerUsersChanged({ reason: 'controller_users_changed' });
      } catch (e) {
        logger.warn(`onControllerUsersChanged callback failed: ${e.message}`);
      }
    }
  }
}

module.exports = ConfigSync;
