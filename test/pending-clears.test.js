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
  assert.deepEqual(pc.planPendingClearSweep(locks, sched, alerted, T0).dueLockIds, [], 'not immediately');
  assert.deepEqual(pc.planPendingClearSweep(locks, sched, alerted, T0 + 30 * 1000).dueLockIds, []);
  assert.deepEqual(pc.planPendingClearSweep(locks, sched, alerted, T0 + 61 * 1000).dueLockIds, ['conf']);
  // Next retry waits the second step (2 minutes), not every sweep.
  assert.deepEqual(pc.planPendingClearSweep(locks, sched, alerted, T0 + 90 * 1000).dueLockIds, []);
  assert.deepEqual(pc.planPendingClearSweep(locks, sched, alerted, T0 + 4 * MIN).dueLockIds, ['conf']);
});

test('the retry keeps going indefinitely until the marker is gone', () => {
  const sched = new Map();
  const alerted = new Set();
  const locks = locksWith({ conf: { 5: T0 } });
  let now = T0;
  let retries = 0;
  for (let i = 0; i < 24 * 60 * 2; i++) { // a full day of 30s sweeps
    now += 30 * 1000;
    retries += pc.planPendingClearSweep(locks, sched, alerted, now).dueLockIds.length;
  }
  assert.ok(retries >= 40, `retried ${retries} times in a day`);
  assert.ok(retries <= 60, `but backed off to protect the battery (${retries})`);
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
  assert.match(indexSrc, /monitorAlert\('keypad_clear_unconfirmed'/, 'a long-unconfirmed clear alerts');
});
