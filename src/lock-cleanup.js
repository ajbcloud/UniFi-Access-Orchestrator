'use strict';

/**
 * Config cleanup for unpaired locks, kept pure so it is testable without the
 * app. Field case: excluding a lock used to leave its config entry behind
 * with node_id 0 (plus its deadbolt_rules automation entry), so the UI kept
 * listing a "not paired" ghost with no working action and the automation
 * panel kept offering a lock that no longer exists.
 */

/**
 * Remove a lock's config entry AND its automation, in place: the legacy
 * deadbolt_rules entry (transitional) plus every door_flows retract edge
 * pointing at the lock. A door key left with no retract and no cascade is
 * dropped entirely. Returns true when anything was actually removed.
 */
function removeLockEntry(cfg, lockId) {
  if (!cfg || !lockId) return false;
  let removed = false;
  const locks = cfg.devices && cfg.devices.zwave && cfg.devices.zwave.locks;
  if (locks && Object.prototype.hasOwnProperty.call(locks, lockId)) {
    delete locks[lockId];
    removed = true;
  }
  if (cfg.deadbolt_rules && Object.prototype.hasOwnProperty.call(cfg.deadbolt_rules, lockId)) {
    delete cfg.deadbolt_rules[lockId];
    removed = true;
  }
  if (cfg.door_flows && typeof cfg.door_flows === 'object') {
    for (const door of Object.keys(cfg.door_flows)) {
      const flow = cfg.door_flows[door];
      if (!flow || !Array.isArray(flow.retract)) continue;
      const before = flow.retract.length;
      flow.retract = flow.retract.filter((e) => !e || e.lock_id !== lockId);
      if (flow.retract.length !== before) removed = true;
      const hasCascade = flow.cascade && Array.isArray(flow.cascade.unlock) && flow.cascade.unlock.length;
      if (!flow.retract.length && !hasCascade) delete cfg.door_flows[door];
    }
  }
  return removed;
}

/**
 * Remove saved lock entries that an earlier app version left behind after an
 * unpair (node_id 0), in place. Returns the removed lock ids.
 *
 * STRICTLY node_id === 0: only the legacy unpair paths ever wrote 0. Entries
 * with no node_id at all are deliberately left alone (dev-mode FakeLock
 * bindings and hand-written entries never carry one).
 */
function pruneGhostLocks(cfg) {
  const locks = (cfg && cfg.devices && cfg.devices.zwave && cfg.devices.zwave.locks) || {};
  const pruned = [];
  for (const [lockId, lock] of Object.entries(locks)) {
    if (lock && lock.node_id === 0) {
      removeLockEntry(cfg, lockId);
      pruned.push(lockId);
    }
  }
  return pruned;
}

module.exports = { removeLockEntry, pruneGhostLocks };
