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
  doorAccessVerdictUnion,
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

test('parseAccessPolicies: a disabled user gets an empty COMPLETE set (confirmed denied) and is not entitled', () => {
  const users = [{ id: 'u1', status: 'DEACTIVATED', access_policies: [{ resources: [{ type: 'door', id: 'd-a' }] }] }];
  const { allowedDoorsByUser, completeByUser, presentActiveIds } = parseAccessPolicies(users, {});
  assert.equal(allowedDoorsByUser.get('u1').size, 0, 'a disabled user keeps no door access');
  assert.equal(completeByUser.get('u1'), true, 'complete so the verdict is a confirmed denied, never unknown');
  assert.equal(presentActiveIds.has('u1'), false, 'a disabled user is not entitled (departed-user sweep clears them)');
});

test('parseAccessPolicies: an ACTIVE user is entitled and keeps their access', () => {
  const users = [{ id: 'u1', status: 'ACTIVE', access_policies: [{ resources: [{ type: 'door', id: 'd-a' }] }] }];
  const { allowedDoorsByUser, presentActiveIds } = parseAccessPolicies(users, {});
  assert.deepEqual([...allowedDoorsByUser.get('u1')], ['d-a']);
  assert.equal(presentActiveIds.has('u1'), true);
});

test('parseAccessPolicies: a missing status is treated as active (older firmware never wrongly revoked)', () => {
  const users = [{ id: 'u1', access_policies: [{ resources: [{ type: 'door', id: 'd-a' }] }] }];
  const { allowedDoorsByUser, presentActiveIds } = parseAccessPolicies(users, {});
  assert.deepEqual([...allowedDoorsByUser.get('u1')], ['d-a'], 'access preserved when the status field is absent');
  assert.equal(presentActiveIds.has('u1'), true);
});

// ---- doorAccessVerdict ----------------------------------------------------

function access({ available = true, doors = { 'Door A': 'd-a', 'Door B': 'd-b' }, doorsById, allowed = {}, complete = {} } = {}) {
  return buildAccess({
    available,
    doorsByName: doors,
    doorsById: doorsById || Object.fromEntries(Object.entries(doors).map(([name, id]) => [id, name])),
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

test('doorAccessVerdict: a bare name string still resolves (back-compat)', () => {
  const a = access({ allowed: { u1: ['d-a'] }, complete: { u1: true } });
  assert.equal(doorAccessVerdict(a, 'u1', 'Door A'), 'allowed');
  assert.equal(doorAccessVerdict(a, 'u1', 'Door B'), 'denied');
});

test('doorAccessVerdict: a stored door id survives a rename the name lookup would miss', () => {
  // The controller renamed "Door A" to "Front Entrance", so doorsByName no
  // longer has the old name, but the id d-a is unchanged and still allowed.
  const a = access({
    doors: { 'Front Entrance': 'd-a' },
    allowed: { u1: ['d-a'] },
    complete: { u1: true },
  });
  assert.equal(doorAccessVerdict(a, 'u1', { id: 'd-a', name: 'Door A' }), 'allowed',
    'the id keeps gating working after a rename');
});

test('doorAccessVerdict: a configured id absent from the registry with no resolvable name is unknown', () => {
  const a = access({ doors: {}, doorsById: {}, allowed: { u1: ['d-a'] }, complete: { u1: true } });
  assert.equal(doorAccessVerdict(a, 'u1', { id: 'd-x', name: 'Ghost' }), 'unknown',
    'an unresolvable door never denies (fail open)');
});

test('doorAccessVerdict: a user ABSENT from the fetch (deleted in UniFi) is DENIED, not unknown', () => {
  // Pins the deleted-user contract: an absent user has no entry in either map,
  // so completeByUser.get() is undefined (NOT === false, so not 'unknown') and
  // the ternary falls through to 'denied'. A refactor that returns 'unknown'
  // when allowed is undefined would fail this and let deleted users keep codes.
  const a = access({ allowed: { alive: ['d-a'] }, complete: { alive: true } });
  assert.equal(doorAccessVerdict(a, 'ghost', 'Door A'), 'denied');
  assert.equal(REVOKE_VERDICTS.has(doorAccessVerdict(a, 'ghost', 'Door A')), true,
    'a deleted user is confirmed-denied so the reconcile revokes their code');
});

test('doorAccessVerdict: a disabled user (via parseAccessPolicies) resolves to DENIED end to end', () => {
  const parsed = parseAccessPolicies(
    [{ id: 'u1', status: 'DEACTIVATED', access_policies: [{ resources: [{ type: 'door', id: 'd-a' }] }] }], {});
  const a = buildAccess({
    available: true,
    doorsByName: { 'Door A': 'd-a' },
    doorsById: { 'd-a': 'Door A' },
    allowedDoorsByUser: parsed.allowedDoorsByUser,
    completeByUser: parsed.completeByUser,
    presentActiveIds: parsed.presentActiveIds,
  });
  assert.equal(doorAccessVerdict(a, 'u1', 'Door A'), 'denied',
    'a disabled user is denied even though their raw policy still listed the door');
});

// ---- doorAccessVerdictUnion (the multi-door collapse) -----------------------

test('union: no gating doors -> ungated (a lock with no triggers serves everyone)', () => {
  assert.equal(doorAccessVerdictUnion(access(), 'u1', []), 'ungated');
  assert.equal(doorAccessVerdictUnion(access(), 'u1', null), 'ungated');
});

test('union: allowed on ANY triggering door wins', () => {
  const a = access({ allowed: { u1: ['d-b'] }, complete: { u1: true } });
  assert.equal(doorAccessVerdictUnion(a, 'u1', [
    { id: 'd-a', name: 'Door A' }, // denied here
    { id: 'd-b', name: 'Door B' }, // allowed here
  ]), 'allowed');
});

test('union: denied ONLY when denied on every known gating door', () => {
  const a = access({ allowed: { u1: [] }, complete: { u1: true } });
  assert.equal(doorAccessVerdictUnion(a, 'u1', [
    { id: 'd-a', name: 'Door A' },
    { id: 'd-b', name: 'Door B' },
  ]), 'denied');
});

test('union: any unknown among non-allowed doors fails OPEN (never denied)', () => {
  // Denied on Door A; Door X is undiscovered -> unknown -> the union must be
  // unknown, because the user might be allowed through Door X.
  const a = access({ allowed: { u1: [] }, complete: { u1: true } });
  assert.equal(doorAccessVerdictUnion(a, 'u1', [
    { id: 'd-a', name: 'Door A' },
    { id: null, name: 'Ghost Door X' },
  ]), 'unknown');
});

test('union: single door equals doorAccessVerdict exactly', () => {
  const a = access({ allowed: { u1: ['d-a'] }, complete: { u1: true } });
  for (const [doors, single] of [
    [[{ id: 'd-a', name: 'Door A' }], doorAccessVerdict(a, 'u1', { id: 'd-a', name: 'Door A' })],
    [[{ id: 'd-b', name: 'Door B' }], doorAccessVerdict(a, 'u1', { id: 'd-b', name: 'Door B' })],
  ]) {
    assert.equal(doorAccessVerdictUnion(a, 'u1', doors), single);
  }
});

// ---- classifyLocksForUser (over door_flows) --------------------------------

test('classifyLocksForUser: per-lock union verdict off each lock\'s gating doors', () => {
  const flows = {
    'Door A': { door_id: 'd-a', retract: [{ lock_id: 'lockA' }], cascade: null },
    'Door B': { door_id: 'd-b', retract: [{ lock_id: 'lockB' }], cascade: null },
  };
  const a = access({ allowed: { u1: ['d-a'] }, complete: { u1: true } });
  const out = classifyLocksForUser('u1', [{ lock_id: 'lockA' }, { lock_id: 'lockB' }, { lock_id: 'lockManual' }], flows, a);
  assert.deepEqual(out, [
    { lock_id: 'lockA', verdict: 'allowed', doors: ['Door A'] },
    { lock_id: 'lockB', verdict: 'denied', doors: ['Door B'] },
    { lock_id: 'lockManual', verdict: 'ungated', doors: [] },
  ]);
});

test('classifyLocksForUser: two locks on ONE door gate identically', () => {
  const flows = { 'Door A': { door_id: 'd-a', retract: [{ lock_id: 'lock1' }, { lock_id: 'lock2' }], cascade: null } };
  const a = access({ allowed: { u1: ['d-a'] }, complete: { u1: true } });
  const out = classifyLocksForUser('u1', [{ lock_id: 'lock1' }, { lock_id: 'lock2' }], flows, a);
  assert.ok(out.every((r) => r.verdict === 'allowed'), 'many locks -> one door, same verdict');
});

test('classifyLocksForUser: THE RECONCILE CASE - allowed via a second door is NOT denied', () => {
  // lock1 is triggered by Door A AND Door B. The user is denied on A but
  // allowed on B. The collapsed verdict MUST be allowed - if a per-door
  // 'denied' ever reached the reconcile revoke planner, the periodic sync
  // would silently wipe this user's code.
  const flows = {
    'Door A': { door_id: 'd-a', retract: [{ lock_id: 'lock1' }], cascade: null },
    'Door B': { door_id: 'd-b', retract: [{ lock_id: 'lock1' }], cascade: null },
  };
  const a = access({ allowed: { u1: ['d-b'] }, complete: { u1: true } });
  const out = classifyLocksForUser('u1', [{ lock_id: 'lock1' }], flows, a);
  assert.equal(out[0].verdict, 'allowed');
  assert.ok(!REVOKE_VERDICTS.has(out[0].verdict), 'the reconciler never sees a revocable verdict');
  assert.deepEqual(out[0].doors.sort(), ['Door A', 'Door B']);
});

test('classifyLocksForUser: uses the flow door_id and keeps names for display', () => {
  // The flow stored id d-a under the old display name; the door was renamed.
  const flows = { 'Door A': { door_id: 'd-a', retract: [{ lock_id: 'lockA' }], cascade: null } };
  const a = access({ doors: { 'Front Entrance': 'd-a' }, allowed: { u1: ['d-a'] }, complete: { u1: true } });
  const out = classifyLocksForUser('u1', [{ lock_id: 'lockA' }], flows, a);
  assert.equal(out[0].verdict, 'allowed', 'the id keeps the verdict correct after a rename');
  assert.deepEqual(out[0].doors, ['Door A'], 'the stored name is kept for display');
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
