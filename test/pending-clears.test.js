'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const pc = require('../src/pending-clears');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-18T18:00:00Z');

function locksWith(markers) {
  // markers: { lockId: { slot: requested_at } }
  const out = {};
  for (const [lockId, slots] of Object.entries(markers)) {
    out[lockId] = { pending_clears: {} };
    for (const [slot, at] of Object.entries(slots)) {
      out[lockId].pending_clears[slot] = { user_id: 'u-luis', name: 'Luis', requested_at: new Date(at).toISOString(), reason: 'removed by admin' };
    }
  }
  return out;
}

test('retryDelayMs backs off and caps at 30 minutes', () => {
  assert.equal(pc.retryDelayMs(1), 1 * MIN);
  assert.equal(pc.retryDelayMs(3), 5 * MIN);
  assert.equal(pc.retryDelayMs(6), 30 * MIN);
  assert.equal(pc.retryDelayMs(500), 30 * MIN, 'never slower than every 30 minutes');
});

test('a fresh marker is retried automatically after one minute, with no human action', () => {
  const sched = new Map();
  const alerted = new Set();
  const locks = locksWith({ conf: { 5: T0 } });
  assert.deepEqual(pc.planPendingClearSweep(locks, sched, alerted, T0).due, [], 'not immediately');
  assert.deepEqual(pc.planPendingClearSweep(locks, sched, alerted, T0 + 30 * 1000).due, []);
  assert.deepEqual(pc.planPendingClearSweep(locks, sched, alerted, T0 + 61 * 1000).due, [{ lock_id: 'conf', slots: ['5'] }]);
  // Next retry waits the second step (2 minutes), not every sweep.
  assert.deepEqual(pc.planPendingClearSweep(locks, sched, alerted, T0 + 90 * 1000).due, []);
  assert.deepEqual(pc.planPendingClearSweep(locks, sched, alerted, T0 + 4 * MIN).due, [{ lock_id: 'conf', slots: ['5'] }]);
});

test('the retry keeps going indefinitely until the marker is gone', () => {
  const sched = new Map();
  const alerted = new Set();
  const locks = locksWith({ conf: { 5: T0 } });
  let now = T0;
  let retries = 0;
  for (let i = 0; i < 24 * 60 * 2; i++) { // a full day of 30s sweeps
    now += 30 * 1000;
    retries += pc.planPendingClearSweep(locks, sched, alerted, now).due.length;
  }
  assert.ok(retries >= 40, `retried ${retries} times in a day`);
  assert.ok(retries <= 60, `but backed off to protect the battery (${retries})`);
});

test('staggered markers on one lock keep their own backoff (only due slots retry)', () => {
  // Review finding: retrying the whole lock whenever any slot was due let
  // ten markers seen a minute apart hit the lock ~20 times an hour each.
  const sched = new Map();
  const alerted = new Set();
  const locks = { conf: { pending_clears: {} } };
  let now = T0;
  const perSlot = {};
  for (let i = 0; i < 10; i++) {
    locks.conf.pending_clears[String(i + 1)] = { user_id: 'u' + i, requested_at: new Date(now).toISOString() };
    pc.planPendingClearSweep(locks, sched, alerted, now);
    now += MIN;
  }
  const start = now + 6 * 60 * MIN; // let every schedule reach the 30-minute cap
  for (; now < start + 60 * MIN; now += 30 * 1000) {
    for (const d of pc.planPendingClearSweep(locks, sched, alerted, now).due) {
      for (const s of d.slots) if (now >= start) perSlot[s] = (perSlot[s] || 0) + 1;
    }
  }
  for (let i = 1; i <= 10; i++) {
    assert.ok((perSlot[String(i)] || 0) <= 3, `slot ${i} retried ${perSlot[String(i)]} times in an hour at the cap`);
  }
});

test('stale removals across several locks become one alert that names them all', () => {
  // Review finding: the notifier de-dupes per type, so per-lock alerts lost
  // all but the first.
  const sched = new Map();
  const alerted = new Set();
  const locks = locksWith({ conf: { 5: T0 }, front: { 2: T0 } });
  const toAlert = pc.planPendingClearSweep(locks, sched, alerted, T0 + 16 * MIN).toAlert;
  assert.equal(toAlert.length, 2);
  const body = pc.describeStaleClears(toAlert, (id) => (id === 'conf' ? 'Conf Room' : 'Front Door'));
  assert.match(body, /^2 keypad code removal/);
  assert.match(body, /Conf Room \(Luis, 16 min\)/);
  assert.match(body, /Front Door \(Luis, 16 min\)/);
  assert.equal(pc.describeStaleClears([], () => ''), '');
});

test('a confirmed marker drops out of the schedule', () => {
  const sched = new Map();
  const alerted = new Set();
  const locks = locksWith({ conf: { 5: T0 } });
  pc.planPendingClearSweep(locks, sched, alerted, T0);
  assert.equal(sched.size, 1);
  delete locks.conf.pending_clears['5'];
  pc.planPendingClearSweep(locks, sched, alerted, T0 + MIN);
  assert.equal(sched.size, 0);
});

test('an unconfirmed clear older than 15 minutes alerts exactly once', () => {
  const sched = new Map();
  const alerted = new Set();
  const locks = locksWith({ conf: { 5: T0 }, front: { 2: T0 + 10 * MIN } });
  assert.equal(pc.planPendingClearSweep(locks, sched, alerted, T0 + 14 * MIN).toAlert.length, 0);
  const first = pc.planPendingClearSweep(locks, sched, alerted, T0 + 16 * MIN).toAlert;
  assert.equal(first.length, 1);
  assert.equal(first[0].lock_id, 'conf');
  assert.equal(first[0].slot, 5);
  assert.equal(first[0].marker.name, 'Luis');
  assert.equal(pc.planPendingClearSweep(locks, sched, alerted, T0 + 20 * MIN).toAlert.length, 0, 'no repeat for conf');
  const second = pc.planPendingClearSweep(locks, sched, alerted, T0 + 26 * MIN).toAlert;
  assert.deepEqual(second.map((a) => a.lock_id), ['front']);
});

test('slotsClosedByLockReport closes only the reported slot, or all on a wipe', () => {
  const pend = { 3: {}, 5: {} };
  assert.deepEqual(pc.slotsClosedByLockReport(pend, { slot: 5 }), ['5']);
  assert.deepEqual(pc.slotsClosedByLockReport(pend, { slot: 9 }), []);
  assert.deepEqual(pc.slotsClosedByLockReport(pend, { slot: null }), [], 'an unattributed deletion closes nothing');
  assert.deepEqual(pc.slotsClosedByLockReport(pend, { all: true }).sort(), ['3', '5']);
  assert.deepEqual(pc.slotsClosedByLockReport(undefined, { slot: 5 }), []);
});

// Source-level wiring guards (index.js touches live drivers; see
// reconcile-wiring.test.js for why these are text assertions).
const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

test('index starts the pending-clear sweep and wires lock self-reports', () => {
  assert.match(indexSrc, /startPendingClearSweep\(\);/, 'the sweep starts with the app');
  assert.match(indexSrc, /driver\.on\('node-activity'/, 'FLiRS lock activity retries pending clears');
  assert.match(indexSrc, /driver\.on\('user-code-cleared'/, 'a lock announcement closes the pending clear');
  assert.match(indexSrc, /monitorAlert\('revoked_code_used'/, 'keypad use of a revoked slot alerts');
  assert.match(indexSrc, /monitorAlert\('keypad_clear_unconfirmed', pendingClears\.describeStaleClears\(/,
    'stale clears are reported in one combined alert');
  assert.match(indexSrc, /retryPendingClears\(d\.lock_id, d\.slots\)/, 'the sweep retries only the due slots');
});

test('a removal the lock confirms later leaves a named Live Events and audit trail', () => {
  const rec = indexSrc.slice(indexSrc.indexOf('function recordPendingClearConfirmed'));
  assert.match(rec, /broadcastEvent\(/, 'Live Events shows the confirmation');
  assert.match(rec, /action: 'pin_removal_confirmed'/, 'the audit log records it');
  assert.match(rec, /m\.name \|\| m\.user_id/, 'the entry names the person, not just a slot');
  const retry = indexSrc.slice(indexSrc.indexOf('async function retryPendingClears'));
  assert.match(retry.slice(0, 3500), /recordPendingClearConfirmed\(lockId, slotKey, marker, via\)/,
    'a retry that confirms is recorded');
  assert.match(indexSrc, /slots\.forEach\(\(s, i\) => recordPendingClearConfirmed\(/,
    'a lock announcement that confirms is recorded');
});

test('automatic (UniFi-driven) removals are written to the audit log', () => {
  const start = indexSrc.indexOf('async function reconcileAccessRevocations');
  const body = indexSrc.slice(start, indexSrc.indexOf('function scheduleReconcile', start));
  assert.match(body, /action: r\.revoked \? 'pin_revoked_auto' : 'pin_revoke_pending_auto'/);
});

test('the per-slot DELETE endpoint uses the serialized, retry-arming revoke path', () => {
  const start = indexSrc.indexOf("app.delete('/api/deadbolt/user-codes/:slot'");
  assert.ok(start >= 0);
  const body = indexSrc.slice(start, indexSrc.indexOf('app.post(', start));
  assert.match(body, /withKeypadLock\(\(\) => revokeHeldCode\(/);
  assert.ok(!/driver\.clearUserCode\(/.test(body), 'no direct, unserialized clear');
});
