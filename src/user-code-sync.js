'use strict';

/**
 * Cross-lock UniFi PIN sync decisions, kept pure so they are testable without
 * the app. The mismatch this resolves: the app stores keypad PINs PER LOCK
 * per user, but UniFi Access holds exactly ONE PIN per user, and it errors
 * (CODE_SYSTEM_ERROR) when asked to re-assign a PIN it already holds. Field
 * case: a user's PIN was pushed for lock A, then saving the same PIN on lock
 * B pushed again and failed, leaving lock B's entry stuck "not pushed" even
 * though UniFi was already in sync.
 */

/**
 * Decide what to do before pushing a user's PIN to UniFi.
 *
 * @param {object} locksCfg  devices.zwave.locks (per-lock user_codes maps)
 * @param {string} lockId    the lock being saved to (its own entries count too:
 *                           re-saving an already-pushed PIN is a no-op)
 * @param {string} userId    UniFi user id
 * @param {string} pin       the PIN about to be assigned
 * @returns {{action: 'skip_in_sync', source_lock: string} |
 *           {action: 'push', stale_locks: string[]}}
 *   skip_in_sync: some lock already pushed this exact PIN for this user, so
 *   UniFi already holds it; mark pushed and skip the API call.
 *   push: call UniFi; stale_locks lists OTHER locks whose entry for this user
 *   holds a DIFFERENT pushed PIN, which the push is about to invalidate
 *   (UniFi keeps one PIN per user, last write wins).
 */
function planUnifiPinPush(locksCfg, lockId, userId, pin) {
  const wanted = String(pin);
  const staleLocks = [];
  for (const [id, lock] of Object.entries(locksCfg || {})) {
    const codes = (lock && lock.user_codes) || {};
    for (const entry of Object.values(codes)) {
      if (!entry || entry.user_id !== userId || entry.pushed_to_unifi !== true) continue;
      if (String(entry.pin_code) === wanted) {
        return { action: 'skip_in_sync', source_lock: id };
      }
      if (id !== lockId && !staleLocks.includes(id)) staleLocks.push(id);
    }
  }
  return { action: 'push', stale_locks: staleLocks };
}

/**
 * Config mutator: after a successful push of a NEW pin for this user, entries
 * on other locks that recorded a different pushed PIN no longer match UniFi.
 * Flips their pushed_to_unifi to false in place; returns the lock ids touched.
 */
function markStaleAfterPush(locksCfg, lockId, userId, pin) {
  const wanted = String(pin);
  const touched = [];
  for (const [id, lock] of Object.entries(locksCfg || {})) {
    if (id === lockId) continue;
    const codes = (lock && lock.user_codes) || {};
    for (const entry of Object.values(codes)) {
      if (!entry || entry.user_id !== userId) continue;
      if (entry.pushed_to_unifi === true && String(entry.pin_code) !== wanted) {
        entry.pushed_to_unifi = false;
        if (!touched.includes(id)) touched.push(id);
      }
    }
  }
  return touched;
}

module.exports = { planUnifiPinPush, markStaleAfterPush };
