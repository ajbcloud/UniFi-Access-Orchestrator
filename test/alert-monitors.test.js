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

test('a resumed outage counts from the original start and alerts as resumed', () => {
  // The outage began at t=1s; this process starts two hours later.
  const since = 1000;
  const infos = [];
  const { monitor, fired, setFlag, advance } = makeMonitor({
    resumeDownSince: since,
    onDown: (s, info) => { fired.down.push(s); infos.push(info); },
  });
  assert.strictEqual(monitor.downSince, since);
  advance(2 * 3600);
  setFlag(false);
  monitor._tick();                 // first tick anchors this process's grace
  advance(30); monitor._tick();    // 30s into the new process: still in grace
  assert.deepStrictEqual(fired.down, []);
  advance(31); monitor._tick();    // past grace -> alert with full duration
  assert.strictEqual(fired.down.length, 1);
  assert.ok(fired.down[0] >= 2 * 3600 + 59, `duration ${fired.down[0]} counts from the original start`);
  assert.deepStrictEqual(infos[0], { resumed: true });
  setFlag(true); advance(15); monitor._tick();
  assert.strictEqual(fired.up.length, 1);
  assert.ok(fired.up[0] >= 2 * 3600 + 74);
  assert.strictEqual(monitor.downSince, null);
});

test('a resumed outage that recovers inside the grace window still reports recovery', () => {
  const { monitor, fired, setFlag, advance } = makeMonitor({ resumeDownSince: 1000 });
  advance(3600);
  setFlag(true);
  advance(5); monitor._tick();     // socket came back right after the restart
  assert.deepStrictEqual(fired.down, []);
  assert.strictEqual(fired.up.length, 1);
  assert.ok(fired.up[0] >= 3600);
  // the next outage is a fresh one with its own grace window
  setFlag(false); monitor._tick(); advance(30); monitor._tick();
  assert.deepStrictEqual(fired.down, []);
});

test('a fresh outage passes { resumed: false } to onDown', () => {
  const infos = [];
  const { monitor, setFlag, advance } = makeMonitor({ onDown: (s, info) => infos.push(info) });
  setFlag(false); monitor._tick(); advance(61); monitor._tick();
  assert.deepStrictEqual(infos, [{ resumed: false }]);
});
