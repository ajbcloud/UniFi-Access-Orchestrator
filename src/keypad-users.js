'use strict';

/**
 * One-PIN-per-user planning over the per-lock code storage, kept pure so it
 * is testable without the app.
 *
 * The app persists keypad codes PER LOCK (locks[lockId].user_codes[slot] =
 * {user_id, name, pin_code, pushed_to_unifi, updated_at, confirmed?}) because
 * slots are a per-lock resource and the driver restore/rewrite machinery
 * consumes exactly that shape. The PRODUCT rule, though, is one PIN per user
 * everywhere (locks and UniFi alike): these helpers derive the canonical PIN
 * per user, aggregate per-user status across locks, and plan multi-lock
 * writes, so the endpoints can enforce the rule without a storage migration.
 */

/**
 * The canonical (newest) entry per user across every lock.
 * Returns Map(user_id -> {pin, name, updated_at, source_lock, pushed_to_unifi}).
 */
function canonicalPins(locksCfg) {
  const byUser = new Map();
  for (const [lockId, lock] of Object.entries(locksCfg || {})) {
    const codes = (lock && lock.user_codes) || {};
    for (const entry of Object.values(codes)) {
      if (!entry || !entry.user_id || !entry.pin_code) continue;
      const prev = byUser.get(entry.user_id);
      const at = entry.updated_at || '';
      if (!prev || at > prev.updated_at) {
        byUser.set(entry.user_id, {
          pin: String(entry.pin_code),
          name: entry.name || null,
          updated_at: at,
          source_lock: lockId,
          // "UniFi holds this PIN" survives across entries as long as the
          // PIN itself did not change: any lock's pushed record proves it.
          pushed_to_unifi: entry.pushed_to_unifi === true
            || !!(prev && prev.pushed_to_unifi && prev.pin === String(entry.pin_code)),
        });
      } else if (!prev.pushed_to_unifi && entry.pushed_to_unifi === true
                 && String(entry.pin_code) === prev.pin) {
        prev.pushed_to_unifi = true;
      }
    }
  }
  return byUser;
}

/**
 * Per-user aggregate for the global Keypad Users panel. Digits never leave:
 * only pin_length is exposed.
 *
 * @param {object} locksCfg       devices.zwave.locks
 * @param {Array}  relevantLocks  [{lock_id, label}] - bound, code-capable
 *                                locks the panel shows a status column for
 * @returns {Array<{user_id, name, pin_length, updated_at, in_unifi,
 *                  locks: Array<{lock_id, slot, status}>}>}
 *   status per lock: 'ok' (holds the canonical PIN), 'pending' (canonical PIN
 *   written but the lock has not confirmed yet), 'differs' (holds an OLDER
 *   different PIN), 'missing' (no code on that lock).
 */
function aggregateKeypadUsers(locksCfg, relevantLocks) {
  const canon = canonicalPins(locksCfg);
  const users = [];
  for (const [userId, c] of canon) {
    const perLock = [];
    for (const rl of relevantLocks || []) {
      const codes = ((locksCfg || {})[rl.lock_id] && locksCfg[rl.lock_id].user_codes) || {};
      let found = null;
      let slot = null;
      for (const [s, e] of Object.entries(codes)) {
        if (e && e.user_id === userId) { found = e; slot = Number(s); break; }
      }
      let status;
      if (!found) status = 'missing';
      else if (String(found.pin_code) !== c.pin) status = 'differs';
      // confirmed is a new field; entries written before it existed read as
      // confirmed (they predate the stricter bookkeeping).
      else if (found.confirmed === null || found.confirmed === false) status = 'pending';
      else status = 'ok';
      perLock.push({ lock_id: rl.lock_id, slot, status });
    }
    users.push({
      user_id: userId,
      name: c.name,
      pin_length: c.pin.length,
      updated_at: c.updated_at || null,
      in_unifi: c.pushed_to_unifi,
      locks: perLock,
    });
  }
  users.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return users;
}

/**
 * The PIN-length rule every lock can satisfy at once, for the shared input.
 * Returns {min, max, fixed, conflict} where fixed is a required exact length
 * (a lock with a configured fixed code length) and conflict is set when two
 * locks demand different fixed lengths (no single PIN can satisfy both).
 */
function combinedLengthRule(caps) {
  let min = 4;
  let max = 10;
  let fixed = null;
  let conflict = false;
  for (const cap of caps || []) {
    if (!cap || cap.supported === false) continue;
    if (cap.min_length) min = Math.max(min, cap.min_length);
    if (cap.max_length) max = Math.min(max, cap.max_length);
    if (cap.fixed_length && cap.configured_length) {
      if (fixed != null && fixed !== cap.configured_length) conflict = true;
      fixed = fixed != null ? fixed : cap.configured_length;
    }
  }
  return { min, max, fixed, conflict };
}

/**
 * Plan writing one user's PIN to every given lock. Pure: no I/O, the caller
 * runs the actual driver writes.
 *
 * @param {object} locksCfg  devices.zwave.locks
 * @param {Array}  lockCaps  [{lock_id, cap}] - bound locks with their
 *                           userCodesCapability() result
 * @param {string} userId
 * @param {string} pin
 * @returns {Array<{lock_id, slot} | {lock_id, error}>} one row per lock, in
 *   the given order; rows with an error are skipped by the caller (the save
 *   proceeds on the locks that CAN take the code and reports the rest).
 */
function planUserSave(locksCfg, lockCaps, userId, pin) {
  const rows = [];
  for (const { lock_id: lockId, cap } of lockCaps || []) {
    if (!cap || !cap.supported) {
      rows.push({ lock_id: lockId, error: (cap && cap.note) || 'this lock does not support keypad codes over Z-Wave' });
      continue;
    }
    if (cap.min_length && pin.length < cap.min_length) {
      rows.push({ lock_id: lockId, error: `needs codes of at least ${cap.min_length} digits` });
      continue;
    }
    if (cap.max_length && pin.length > cap.max_length) {
      rows.push({ lock_id: lockId, error: `takes codes of at most ${cap.max_length} digits` });
      continue;
    }
    if (cap.fixed_length && cap.configured_length && pin.length !== cap.configured_length) {
      // Never auto-write the length parameter: changing it WIPES every code
      // on Schlage. The operator picks a matching-length PIN instead.
      rows.push({ lock_id: lockId, error: `is set to ${cap.configured_length}-digit codes (changing that setting would wipe every stored code)` });
      continue;
    }
    const saved = ((locksCfg || {})[lockId] && locksCfg[lockId].user_codes) || {};
    let duplicate = null;
    for (const [slot, e] of Object.entries(saved)) {
      if (e && String(e.pin_code) === pin && e.user_id !== userId) { duplicate = slot; break; }
    }
    if (duplicate != null) {
      rows.push({ lock_id: lockId, error: `already has that PIN in slot ${duplicate} (locks reject duplicate codes)` });
      continue;
    }
    // Reuse the user's existing slot on update; otherwise the lowest free
    // slot within capacity, never a slot the lock reserves for itself.
    let slot = null;
    for (const [s, e] of Object.entries(saved)) {
      if (e && e.user_id === userId) { slot = Number(s); break; }
    }
    if (slot == null) {
      const reserved = Array.isArray(cap.reserved_slots) ? cap.reserved_slots : [];
      for (let s = 1; s <= (cap.slots || 0); s++) {
        if (reserved.includes(s)) continue;
        if (!saved[String(s)]) { slot = s; break; }
      }
    }
    if (slot == null) {
      rows.push({ lock_id: lockId, error: `all ${cap.slots} code slots are in use; remove one first` });
      continue;
    }
    rows.push({ lock_id: lockId, slot });
  }
  return rows;
}

/**
 * Plan seeding a NEWLY PAIRED lock with every saved user's canonical PIN.
 * Returns {assignments: {slot: entry}, skipped: [{user_id, name, reason}]}.
 * Entries inherit pushed_to_unifi from the canonical source (the PIN is
 * already in UniFi or it is not; provisioning a lock changes nothing there).
 *
 * @param {object} locksCfg  devices.zwave.locks (the new lock may or may not
 *                           already have entries; existing users keep theirs)
 * @param {string} newLockId
 * @param {object} cap       the new lock's userCodesCapability() result
 * @param {string} nowIso    timestamp for the new entries
 */
function planNewLockProvision(locksCfg, newLockId, cap, nowIso) {
  const assignments = {};
  const skipped = [];
  if (!cap || !cap.supported) return { assignments, skipped };
  const existing = Object.assign({}, ((locksCfg || {})[newLockId] && locksCfg[newLockId].user_codes) || {});
  const usersOnNewLock = new Set(Object.values(existing).filter(Boolean).map((e) => e.user_id));
  const reserved = Array.isArray(cap.reserved_slots) ? cap.reserved_slots : [];
  const takenPins = new Set(Object.values(existing).filter(Boolean).map((e) => String(e.pin_code)));
  let next = 1;
  const nextFreeSlot = () => {
    for (let s = next; s <= (cap.slots || 0); s++) {
      if (reserved.includes(s)) continue;
      if (existing[String(s)] || assignments[String(s)]) continue;
      next = s + 1;
      return s;
    }
    return null;
  };
  for (const [userId, c] of canonicalPins(locksCfg)) {
    if (usersOnNewLock.has(userId)) continue;
    if (c.source_lock === newLockId) continue;
    if (cap.min_length && c.pin.length < cap.min_length) {
      skipped.push({ user_id: userId, name: c.name, reason: `PIN shorter than this lock's ${cap.min_length}-digit minimum` });
      continue;
    }
    if (cap.max_length && c.pin.length > cap.max_length) {
      skipped.push({ user_id: userId, name: c.name, reason: `PIN longer than this lock's ${cap.max_length}-digit maximum` });
      continue;
    }
    if (cap.fixed_length && cap.configured_length && c.pin.length !== cap.configured_length) {
      skipped.push({ user_id: userId, name: c.name, reason: `PIN is not ${cap.configured_length} digits (this lock's fixed code length)` });
      continue;
    }
    if (takenPins.has(c.pin)) {
      skipped.push({ user_id: userId, name: c.name, reason: 'another user already holds that PIN on this lock' });
      continue;
    }
    const slot = nextFreeSlot();
    if (slot == null) {
      skipped.push({ user_id: userId, name: c.name, reason: 'no free code slots left on this lock' });
      continue;
    }
    takenPins.add(c.pin);
    assignments[String(slot)] = {
      user_id: userId,
      name: c.name,
      pin_code: c.pin,
      pushed_to_unifi: c.pushed_to_unifi,
      confirmed: null,
      updated_at: nowIso || null,
    };
  }
  return { assignments, skipped };
}

module.exports = {
  canonicalPins,
  aggregateKeypadUsers,
  combinedLengthRule,
  planUserSave,
  planNewLockProvision,
};
