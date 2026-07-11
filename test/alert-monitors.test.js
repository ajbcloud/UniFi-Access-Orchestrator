'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { SustainedFlagMonitor } = require('../src/alert-monitors');

// Drive _tick() by hand with an injected clock; no real timers.
function makeMonitor(overrides = {}) {
  let clock = 0;
  const fired = { down: [], up: [] };
  let flag = true;
  const monitor = new SustainedFlagMonitor(Object.assign({
    name: 'test',
    logger: { warn() {} },
    graceSeconds: 60,
    check: () => flag,
    onDown: (s) => fired.down.push(s),
    onUp: (s) => fired.up.push(s),
    now: () => clock,
  }, overrides));
  return {
    monitor, fired,
    setFlag: (v) => { flag = v; },
    advance: (seconds) => { clock += seconds * 1000; },
  };
}

test('a brief blip inside the grace window never alerts', () => {
  const { monitor, fired, setFlag, advance } = makeMonitor();
  monitor._tick();                 // up
  setFlag(false); advance(15); monitor._tick(); // down 0s..15s
  advance(15); monitor._tick();    // down 30s (< 60 grace)
  setFlag(true); advance(15); monitor._tick();  // recovered before grace
  assert.deepStrictEqual(fired.down, []);
  assert.deepStrictEqual(fired.up, []); // no down alert -> no recovery alert
});

test('a sustained outage alerts once, then fires one recovery', () => {
  const { monitor, fired, setFlag, advance } = makeMonitor();
  setFlag(false);
  monitor._tick();                 // down starts at t=0
  advance(61); monitor._tick();    // past grace -> onDown
  advance(30); monitor._tick();    // still down -> NO second alert
  assert.strictEqual(fired.down.length, 1);
  assert.ok(fired.down[0] >= 60);
  setFlag(true); advance(9); monitor._tick(); // recovery -> onUp once
  assert.strictEqual(fired.up.length, 1);
  // next outage alerts again (state fully reset)
  setFlag(false); monitor._tick(); advance(61); monitor._tick();
  assert.strictEqual(fired.down.length, 2);
});

test('a null check (not applicable) resets silently', () => {
  const { monitor, fired, setFlag, advance } = makeMonitor();
  setFlag(false);
  monitor._tick(); advance(30); monitor._tick(); // down 30s
  setFlag(null); monitor._tick();                // becomes not-applicable
  setFlag(false); monitor._tick(); advance(59); monitor._tick(); // down 59s again
  assert.deepStrictEqual(fired.down, []);        // grace restarted from the reset
  advance(2); monitor._tick();
  assert.strictEqual(fired.down.length, 1);
});

test('a throwing check is treated as not applicable, never as an outage', () => {
  const { monitor, fired, advance } = makeMonitor({ check: () => { throw new Error('boom'); } });
  monitor._tick(); advance(120); monitor._tick();
  assert.deepStrictEqual(fired.down, []);
});

test('a callback error is contained', () => {
  const warnings = [];
  const { monitor, setFlag, advance } = makeMonitor({
    logger: { warn: (m) => warnings.push(m) },
    onDown: () => { throw new Error('webhook exploded'); },
  });
  setFlag(false); monitor._tick(); advance(61);
  monitor._tick(); // must not throw
  assert.ok(warnings.some((w) => w.includes('webhook exploded')));
});
