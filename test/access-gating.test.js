'use strict';

// Guards src/access-gating.js: the pure layer that decides whether a user may
// hold a keypad code on a given deadbolt, based on the lock's gating door
// (deadbolt_rules[lockId].trigger_door) and the user's UniFi door access.
// The safety keystone under test: uncertainty (no data, incomplete policy,
// unknown door) yields 'unknown', never 'denied', so codes are never wiped
// on an API hiccup.

const test = require('node:test');
const assert = require('node:assert');
const {
  parseAccessPolicies,
  buildAccess,
  doorAccessVerdict,
  classifyLocksForUser,
  WRITE_VERDICTS,
  REVOKE_VERDICTS,
  PROVISION_VERDICTS,
} = require('../src/access-gating');

// ---- parseAccessPolicies --------------------------------------------------

test('parseAccessPolicies: door + door_group resources union into the user set', () => {
  const users = [{
    id: 'u1',
    access_policies: [
      { resources: [{ type: 'door', id: 'd-a' }] },
      { resources: [{ type: 'door_group', id: 'g-1' }] },
    ],
  }];
  const doorGroups = { 'g-1': ['d-b', 'd-c'] };
  const { allowedDoorsByUser, completeByUser } = parseAccessPolicies(users, doorGroups);
  assert.deepEqual([...allowedDoorsByUser.get('u1')].sort(), ['d-a', 'd-b', 'd-c']);
  assert.equal(completeByUser.get('u1'), true);
});

test('parseAccessPolicies: an unexpandable door_group marks the user incomplete', () => {
  const users = [{ id: 'u1', access_policies: [{ resources: [{ type: 'door_group', id: 'g-x' }] }] }];
  const { allowedDoorsByUser, completeByUser } = parseAccessPolicies(users, {});
  assert.equal(completeByUser.get('u1'), false, 'unknown group -> incomplete (fail open later)');
  assert.equal(allowedDoorsByUser.get('u1').size, 0);
});

test('parseAccessPolicies: an unknown resource type marks the user incomplete', () => {
  const users = [{ id: 'u1', access_policies: [{ resources: [{ type: 'all_doors', id: '*' }] }] }];
  const { completeByUser } = parseAccessPolicies(users, {});
  assert.equal(completeByUser.get('u1'), false);
});

test('parseAccessPolicies: no policies -> empty set but complete (a real "no access" user)', () => {
  const { allowedDoorsByUser, completeByUser } = parseAccessPolicies([{ id: 'u1', access_policies: [] }], {});
  assert.equal(allowedDoorsByUser.get('u1').size, 0);
  assert.equal(completeByUser.get('u1'), true);
});

test('parseAccessPolicies: Map doorGroups and empty input are tolerated', () => {
  const r = parseAccessPolicies([], new Map([['g', new Set(['d'])]]));
  assert.equal(r.allowedDoorsByUser.size, 0);
});

test('parseAccessPolicies: groupsReferenced is true when any user grants via a door_group', () => {
  const users = [{ id: 'u1', access_policies: [{ resources: [{ type: 'door_group', id: 'g-1' }] }] }];
  const { groupsReferenced } = parseAccessPolicies(users, { 'g-1': ['d-b'] });
  assert.equal(groupsReferenced, true);
});

test('parseAccessPolicies: groupsReferenced is false for door-only and unknown types', () => {
  const users = [{
    id: 'u1',
    access_policies: [
      { resources: [{ type: 'door', id: 'd-a' }] },
      { resources: [{ type: 'all_doors', id: '*' }] },
    ],
  }];
  const { groupsReferenced } = parseAccessPolicies(users, {});
  assert.equal(groupsReferenced, false, 'no door_group resource means the door-groups banner never fires');
});

// ---- doorAccessVerdict ----------------------------------------------------

function access({ available = true, doors = { 'Door A': 'd-a', 'Door B': 'd-b' }, allowed = {}, complete = {} } = {}) {
  return buildAccess({
    available,
    doorsByName: doors,
    allowedDoorsByUser: new Map(Object.entries(allowed).map(([u, ids]) => [u, new Set(ids)])),
    completeByUser: new Map(Object.entries(complete)),
  });
}

test('doorAccessVerdict: no gating door -> ungated', () => {
  assert.equal(doorAccessVerdict(access(), 'u1', null), 'ungated');
  assert.equal(doorAccessVerdict(access(), 'u1', ''), 'ungated');
});

test('doorAccessVerdict: allowed when the door id is in the user set', () => {
  const a = access({ allowed: { u1: ['d-a'] }, complete: { u1: true } });
  assert.equal(doorAccessVerdict(a, 'u1', 'Door A'), 'allowed');
});

test('doorAccessVerdict: denied when door known, user complete, not in set', () => {
  const a = access({ allowed: { u1: ['d-b'] }, complete: { u1: true } });
  assert.equal(doorAccessVerdict(a, 'u1', 'Door A'), 'denied');
});

test('doorAccessVerdict: unavailable data -> unknown (fail open)', () => {
  const a = access({ available: false });
  assert.equal(doorAccessVerdict(a, 'u1', 'Door A'), 'unknown');
});

test('doorAccessVerdict: incomplete user -> unknown (fail open)', () => {
  const a = access({ allowed: { u1: ['d-b'] }, complete: { u1: false } });
  assert.equal(doorAccessVerdict(a, 'u1', 'Door A'), 'unknown', 'never deny an incomplete user');
});

test('doorAccessVerdict: undiscovered / renamed door -> unknown', () => {
  const a = access({ allowed: { u1: ['d-a'] }, complete: { u1: true } });
  assert.equal(doorAccessVerdict(a, 'u1', 'Ghost Door'), 'unknown');
});

// ---- classifyLocksForUser -------------------------------------------------

test('classifyLocksForUser: per-lock verdict off each lock trigger_door', () => {
  const rules = {
    lockA: { trigger_door: 'Door A' },
    lockB: { trigger_door: 'Door B' },
    lockManual: {}, // no trigger_door
  };
  const a = access({ allowed: { u1: ['d-a'] }, complete: { u1: true } });
  const out = classifyLocksForUser('u1', [{ lock_id: 'lockA' }, { lock_id: 'lockB' }, { lock_id: 'lockManual' }], rules, a);
  assert.deepEqual(out, [
    { lock_id: 'lockA', verdict: 'allowed', door: 'Door A' },
    { lock_id: 'lockB', verdict: 'denied', door: 'Door B' },
    { lock_id: 'lockManual', verdict: 'ungated', door: null },
  ]);
});

test('classifyLocksForUser: two locks on ONE door gate identically', () => {
  const rules = { lock1: { trigger_door: 'Door A' }, lock2: { trigger_door: 'Door A' } };
  const a = access({ allowed: { u1: ['d-a'] }, complete: { u1: true } });
  const out = classifyLocksForUser('u1', [{ lock_id: 'lock1' }, { lock_id: 'lock2' }], rules, a);
  assert.ok(out.every((r) => r.verdict === 'allowed'), 'many locks -> one door, same verdict');
});

// ---- policy sets (the caller contract) ------------------------------------

test('verdict policy sets encode the fail-open/fail-safe rules', () => {
  // Write (new push) fails OPEN on unknown; revoke only on a sure denial;
  // provisioning is additive so it defers unknown.
  assert.ok(WRITE_VERDICTS.has('unknown') && WRITE_VERDICTS.has('allowed') && WRITE_VERDICTS.has('ungated'));
  assert.ok(!WRITE_VERDICTS.has('denied'));
  assert.deepEqual([...REVOKE_VERDICTS], ['denied']);
  assert.ok(!REVOKE_VERDICTS.has('unknown'), 'never revoke on uncertainty');
  assert.ok(PROVISION_VERDICTS.has('allowed') && PROVISION_VERDICTS.has('ungated'));
  assert.ok(!PROVISION_VERDICTS.has('unknown') && !PROVISION_VERDICTS.has('denied'));
});

// Source-level guard on the endpoint wiring: the revoke branch in index.js
// must key off REVOKE_VERDICTS (denied only), never on the write/unknown set,
// so an API hiccup can never mass-wipe codes.
test('index.js revokes only on REVOKE_VERDICTS (the safety keystone)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(src, /REVOKE_VERDICTS\.has\(verdictByLock\.get\(l\.lock_id\)\.verdict\)/,
    'the denied/revoke set is filtered with REVOKE_VERDICTS');
  assert.match(src, /WRITE_VERDICTS\.has\(verdictByLock\.get\(l\.lock_id\)\.verdict\)/,
    'the writable set is filtered with WRITE_VERDICTS (fail open on unknown)');
});
