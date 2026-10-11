'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { findMissedTriggers, triggerDoorsFromFlows, normalizeHit } = require('../src/missed-triggers');

const T0 = Date.parse('2026-10-09T07:42:16Z'); // socket dropped
const T1 = Date.parse('2026-10-11T04:33:08Z'); // socket back

function hit({ at, door = 'Main Entrance', actor = 'Nicole Linn', actorType = 'user', provider = 'PIN_CODE', type = 'access.door.unlock', result = 'ACCESS' }) {
  return {
    '@timestamp': new Date(at).toISOString(),
    _id: String(at),
    _source: {
      actor: { id: 'a1', display_name: actor, type: actorType },
      authentication: provider ? { credential_provider: provider } : null,
      event: { type, result, published: at, display_message: '' },
      target: [{ type: 'door', id: 'd1', display_name: door }, { type: 'reason_code', id: '107', display_name: '107' }],
    },
  };
}

const opts = { triggerDoors: ['Main Entrance'], from: T0, until: T1 };

test('a granted entry at a trigger door during the gap is reported', () => {
  const at = Date.parse('2026-10-09T14:50:25Z');
  const missed = findMissedTriggers([hit({ at })], opts);
  assert.equal(missed.length, 1);
  assert.equal(missed[0].actor, 'Nicole Linn');
  assert.equal(missed[0].door, 'Main Entrance');
  assert.equal(missed[0].at, at);
  assert.equal(missed[0].how, 'pin code');
});

test('denials, devices, other doors and entries outside the gap are not', () => {
  const at = Date.parse('2026-10-09T14:50:19Z');
  const missed = findMissedTriggers([
    hit({ at, result: 'BLOCKED' }),                                       // invalid PIN
    hit({ at, actor: 'Main Entrance', actorType: 'device', provider: null }), // motion sensor
    hit({ at, door: 'Double Doors-Tenant Space' }),                       // not a trigger door
    hit({ at: T0 - 60000 }),                                              // before the drop
    hit({ at: T1 + 60000 }),                                              // after reconnect
  ], opts);
  assert.deepStrictEqual(missed, []);
});

test('an entry the app answered right after (gap edge) is not reported', () => {
  const at = T0 + 1000;
  const missed = findMissedTriggers([
    hit({ at }),
    hit({ at: at + 2000, actor: 'Access Orchestrator', provider: 'REMOTE_THROUGH_UAH', door: 'Main Entrance' }),
  ], opts);
  assert.deepStrictEqual(missed, []);
});

test('the orchestrator\'s own unlocks are never reported, remote tenant unlocks are labeled', () => {
  const at = Date.parse('2026-10-10T15:00:00Z');
  const missed = findMissedTriggers([
    hit({ at, actor: 'Access Orchestrator', provider: 'REMOTE_THROUGH_UAH' }),
    hit({ at: at + 120000, actor: 'Front Desk', provider: 'REMOTE_THROUGH_UAH' }),
  ], opts);
  assert.equal(missed.length, 1);
  assert.equal(missed[0].actor, 'Front Desk');
  assert.match(missed[0].how, /doorbell answer/);
});

test('results come back oldest first and door names match case-insensitively', () => {
  const a = Date.parse('2026-10-10T16:00:00Z');
  const b = Date.parse('2026-10-09T16:00:00Z');
  const missed = findMissedTriggers([hit({ at: a, door: 'main entrance ' }), hit({ at: b })], opts);
  assert.deepStrictEqual(missed.map((m) => m.at), [b, a]);
});

test('normalizeHit falls back to @timestamp and tolerates missing parts', () => {
  const n = normalizeHit({ '@timestamp': '2026-10-09T14:50:25Z', _source: { event: {} } });
  assert.equal(n.at, Date.parse('2026-10-09T14:50:25Z'));
  assert.equal(n.door, '');
  assert.equal(normalizeHit(null).at, null);
});

test('triggerDoorsFromFlows lists doors with triggers, legacy flat flows included', () => {
  const doors = triggerDoorsFromFlows({
    'Main Entrance': { triggers: [{ type: 'entry' }] },
    'Empty Door': { triggers: [] },
    'Legacy Door': { cascade: { doors: ['X'] } },
    'Null Door': null,
  });
  assert.deepStrictEqual(doors, ['Main Entrance', 'Legacy Door']);
});
