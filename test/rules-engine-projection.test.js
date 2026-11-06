'use strict';

// The Test Tools preflight and simulator read rulesEngine.accessRules and
// rulesEngine.visitorRules. Those come from unlock_rules / doorbell_rules,
// which no longer exist on disk: they are a projection of door_flows built by
// rulesEngineConfig() in src/index.js. A rebuild that skipped the projection
// left the engine with zero rules, so preflight reported
// `No access rule for group "suite_100" at trigger "Main Entrance"` for a
// flow the same tab listed as configured.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const doorFlows = require('../src/door-flows');
const RulesEngine = require('../src/rules-engine');

const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function unlock(doors) {
  return { doors, debounce_seconds: 0, delay_seconds: 0 };
}

// Mirrors the wiki setup: three tenant groups, one door each, all triggered
// from Main Entrance, plus a group-scoped doorbell trigger.
const config = {
  door_flows: {
    'Main Entrance': {
      triggers: [
        { type: 'entry', scope: { groups: ['suite_100'] }, actions: { unlock: unlock(['Lobby Elevator']), retract: [] } },
        { type: 'entry', scope: { groups: ['suite_200'] }, actions: { unlock: unlock(['Suite 200 Door']), retract: [] } },
        { type: 'entry', scope: { groups: ['suite_300'] }, actions: { unlock: unlock(['Suite 300 Door']), retract: [] } },
        { type: 'doorbell', scope: { groups: ['suite_100'] }, doorbell: { reason_code: 107, viewer_to_group: { 'Suite 100 Viewer': 'suite_100' } }, actions: { unlock: unlock(['Lobby Elevator']), retract: [] } },
      ],
    },
  },
};

// Same projection as rulesEngineConfig() in src/index.js.
function projected(cfg) {
  const proj = doorFlows.legacyProjection(cfg.door_flows || {});
  return Object.assign({}, cfg, { unlock_rules: proj.unlock_rules, doorbell_rules: proj.doorbell_rules });
}

// Same filter the /test/preflight "Matching rule" check runs.
function preflightMatches(engine, ruleSet, group, doorName) {
  return engine[ruleSet].filter((r) => r.group === group && engine.locationMatches(doorName, r.trigger));
}

test('projected engine: preflight finds the group-scoped access rule', () => {
  const engine = new RulesEngine(projected(config), {}, {});
  const m = preflightMatches(engine, 'accessRules', 'suite_100', 'Main Entrance');
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].unlock, ['Lobby Elevator']);
  assert.equal(preflightMatches(engine, 'accessRules', 'suite_300', 'Main Entrance')[0].unlock[0], 'Suite 300 Door');
  // Door names match case-insensitively, as the simulator relies on.
  assert.equal(preflightMatches(engine, 'accessRules', 'suite_200', 'main entrance').length, 1);
});

test('projected engine: preflight finds the group-scoped doorbell rule and viewer map', () => {
  const engine = new RulesEngine(projected(config), {}, {});
  assert.equal(preflightMatches(engine, 'visitorRules', 'suite_100', 'Main Entrance').length, 1);
  assert.equal(engine._viewerToGroupCI['suite 100 viewer'], 'suite_100');
});

test('unprojected engine has no rules (the regression the projection prevents)', () => {
  const engine = new RulesEngine(config, {}, {});
  assert.equal(engine.accessRules.length, 0);
  assert.equal(engine.visitorRules.length, 0);
});

test('every RulesEngine built in src/index.js goes through rulesEngineConfig', () => {
  const calls = indexSrc.match(/new RulesEngine\([^)]*\)/g) || [];
  assert.ok(calls.length >= 3, 'expected startup, full reload and rules-only reload constructions');
  for (const call of calls) {
    assert.match(call, /^new RulesEngine\(rulesEngineConfig\(/, `unprojected construction: ${call}`);
  }
});
