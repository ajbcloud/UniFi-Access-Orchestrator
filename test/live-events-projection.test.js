'use strict';

// Guards the Live Events feed fix: incoming access events must project into a
// display row via RulesEngine.describeForFeed (pure, no unlocks), and the
// handleWebSocketLog refactor that shares _unwrapWebSocketLog must keep routing
// and stats.last_event intact.

const test = require('node:test');
const assert = require('node:assert');

const RulesEngine = require('../src/rules-engine');

// Minimal engine: describeForFeed never touches the resolver or unifiClient,
// and the routing regression only exercises the no-group path (no unlocks).
function makeEngine() {
  return new RulesEngine(
    { unlock_rules: {}, doorbell_rules: {} },
    {},
    { resolve: () => ({ group: null, strategy: 'none', userName: null }) }
  );
}

// Mirrors test/deadbolt-controller.test.js entryGrant(): a WebSocket
// access.logs.add wrapper carrying the real event in data._source.
function wsGrant(door, o = {}) {
  return {
    event: 'access.logs.add',
    data: {
      _source: {
        target: [{ type: 'door', id: o.doorId || 'door-1', display_name: door }],
        actor: { display_name: 'actor' in o ? o.actor : 'Raphael' },
        event: { type: 'access.door.unlock', result: o.result || 'ACCESS' },
        authentication: { credential_provider: 'NFC' },
      },
    },
  };
}

test('WS access.logs.add grant projects a visible (actioned) row', () => {
  assert.deepEqual(makeEngine().describeForFeed(wsGrant('Front Door')), {
    type: 'access.door.unlock',
    actor: 'Raphael',
    location: 'Front Door',
    device: null,
    success: true,
  });
});

test('BLOCKED WS grant projects success:false (failed bucket)', () => {
  assert.equal(makeEngine().describeForFeed(wsGrant('Front Door', { result: 'BLOCKED' })).success, false);
});

test('webhook access.door.unlock projects location and actor', () => {
  const row = makeEngine().describeForFeed({
    event: 'access.door.unlock',
    data: { location: { name: 'Lobby' }, actor: { name: 'Kim' }, object: { result: 'ACCESS' } },
  });
  assert.deepEqual(
    [row.type, row.actor, row.location, row.success],
    ['access.door.unlock', 'Kim', 'Lobby', true]
  );
});

test('missing actor still yields a row (actor null, location kept)', () => {
  const row = makeEngine().describeForFeed(wsGrant('Gate', { actor: '' }));
  assert.equal(row.actor, null);
  assert.equal(row.location, 'Gate');
  assert.equal(row.success, true);
});

test('doorbell completion is not marked failed', () => {
  const row = makeEngine().describeForFeed({
    event: 'access.doorbell.completed',
    data: { location: { name: 'Front Door' }, actor: { name: 'Concierge' }, object: { reason_code: 106 } },
  });
  assert.equal(row.type, 'access.doorbell.completed');
  assert.equal(row.success, true);
});

test('unrecognized payload projects null (no ghost row)', () => {
  assert.equal(makeEngine().describeForFeed({}), null);
  assert.equal(makeEngine().describeForFeed({ event: 'access.logs.add', data: { _source: {} } }), null);
});

// Regression: extracting _unwrapWebSocketLog must not break live routing.
test('handleWebSocketLog still unwraps and records last_event', async () => {
  const e = makeEngine();
  await e.handleEvent(wsGrant('Front Door'));
  assert.equal(e.stats.last_event.type, 'access.door.unlock');
  assert.equal(e.stats.last_event.location, 'Front Door');
  assert.equal(e.stats.last_event.actor, 'Raphael');
});
