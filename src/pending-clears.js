'use strict';

// Scheduling for keypad code clears a lock has not confirmed yet.
//
// A removed user's code is deleted from the config immediately, but the lock
// itself may not confirm the clear (a Yale on S0 times out on read-back, a
// battery lock may be out of range). Until it confirms, the old PIN may still
// open the door, so the app keeps retrying on its own: no "use the lock once"
// and no manual Remove click. Retries back off so a lock that never answers
// is not polled hard enough to drain its batteries, and an unconfirmed clear
// older than ALERT_AFTER_MS raises an alert so a human knows to look.
//
// Pure helpers only (no timers, no I/O) so the policy is unit-testable.

// Delay before retry N (1-based). Capped at the last step.
const RETRY_STEPS_MS = Object.freeze([
  60 * 1000,
  2 * 60 * 1000,
  5 * 60 * 1000,
  10 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
]);

const ALERT_AFTER_MS = 15 * 60 * 1000;

function retryDelayMs(attempts) {
  const n = Math.max(1, Math.floor(Number(attempts) || 1));
  return RETRY_STEPS_MS[Math.min(n, RETRY_STEPS_MS.length) - 1];
}

function markerKey(lockId, slot) {
  return `${lockId}|${slot}`;
}

/**
 * Decide which locks have a pending clear due for a retry, and which markers
 * are old enough to alert on.
 *
 * locks:    config.devices.zwave.locks ({ lockId: { pending_clears: { slot: marker } } })
 * schedule: Map markerKey -> { attempts, nextAt } (mutated: new markers are
 *           seeded, due markers are advanced, vanished markers are dropped)
 * alerted:  Set of markerKeys already alerted (mutated: dropped when a marker
 *           vanishes, so a later clear of the same slot can alert again)
 *
 * Returns { dueLockIds: string[], toAlert: [{ lock_id, slot, marker, age_ms }] }.
 */
function planPendingClearSweep(locks, schedule, alerted, now) {
  const live = new Set();
  const due = new Set();
  const toAlert = [];
  for (const [lockId, lock] of Object.entries(locks || {})) {
    const pend = (lock && lock.pending_clears) || {};
    for (const [slot, marker] of Object.entries(pend)) {
      const key = markerKey(lockId, slot);
      live.add(key);
      let s = schedule.get(key);
      if (!s) {
        // First sight of this marker: the initial clear just failed to
        // confirm, so the first automatic retry comes one step later.
        s = { attempts: 0, nextAt: now + retryDelayMs(1) };
        schedule.set(key, s);
      }
      if (now >= s.nextAt) {
        due.add(lockId);
        s.attempts += 1;
        s.nextAt = now + retryDelayMs(s.attempts + 1);
      }
      const requested = Date.parse(marker && marker.requested_at);
      const age = Number.isFinite(requested) ? now - requested : 0;
      if (age >= ALERT_AFTER_MS && !alerted.has(key)) {
        alerted.add(key);
        toAlert.push({ lock_id: lockId, slot: Number(slot), marker: marker || {}, age_ms: age });
      }
    }
  }
  for (const key of [...schedule.keys()]) if (!live.has(key)) schedule.delete(key);
  for (const key of [...alerted]) if (!live.has(key)) alerted.delete(key);
  return { dueLockIds: [...due], toAlert };
}

/**
 * Slots whose pending clear the lock has now confirmed on its own (a "user
 * code deleted" announcement or a late User Code report). all=true means the
 * lock reported every code deleted, which closes every marker on it.
 */
function slotsClosedByLockReport(pendingClears, event) {
  const pend = pendingClears || {};
  if (event && event.all) return Object.keys(pend);
  const slot = event && Number(event.slot);
  if (!Number.isInteger(slot) || slot < 1) return [];
  return Object.prototype.hasOwnProperty.call(pend, String(slot)) ? [String(slot)] : [];
}

module.exports = {
  RETRY_STEPS_MS,
  ALERT_AFTER_MS,
  retryDelayMs,
  markerKey,
  planPendingClearSweep,
  slotsClosedByLockReport,
};
