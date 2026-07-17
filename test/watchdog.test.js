'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { decideWatchdogAction } = require('../src/watchdog');

const MIN = 60 * 1000;
const NOW = 1_000_000_000_000; // fixed clock; no real timers

// Defaults mirror the shipped example: 60 min hard, 5 min soft.
function state(overrides = {}) {
  return Object.assign({
    mode: 'websocket',
    now: NOW,
    hasHost: true,
    timeoutMs: 60 * MIN,
    reconnectAfterMs: 5 * MIN,
    lastWsInboundAt: NOW,          // fresh by default
    watchdogStartedAt: NOW - MIN,
    connectionState: 'connected',
    lastEventTime: NOW,
    reconnectAlreadyTried: false,
  }, overrides);
}

test('websocket: quiet-but-connected controller never restarts (regression guard)', () => {
  // No door events for hours, but the socket got a frame 10s ago (heartbeat).
  const d = decideWatchdogAction(state({
    lastWsInboundAt: NOW - 10 * 1000,
    lastEventTime: NOW - 5 * 60 * MIN,
  }));
  assert.strictEqual(d.action, 'ok');
  assert.strictEqual(d.reason, 'ws-healthy');
});

test('websocket: first boot, never connected but inside grace -> ok', () => {
  const d = decideWatchdogAction(state({
    lastWsInboundAt: 0,
    watchdogStartedAt: NOW - 30 * 1000, // armed 30s ago
  }));
  assert.strictEqual(d.action, 'ok');
});

test('websocket: stale past reconnect threshold, latch open -> reconnect', () => {
  const d = decideWatchdogAction(state({
    lastWsInboundAt: NOW - 6 * MIN,
    reconnectAlreadyTried: false,
  }));
  assert.strictEqual(d.action, 'reconnect');
  assert.strictEqual(d.reason, 'ws-source-stale');
});

test('websocket: same staleness but latch already set -> ok (no repeat every tick)', () => {
  const d = decideWatchdogAction(state({
    lastWsInboundAt: NOW - 6 * MIN,
    reconnectAlreadyTried: true,
  }));
  assert.strictEqual(d.action, 'ok');
});

test('websocket: stale past hard threshold -> restart (even if reconnect tried)', () => {
  const d = decideWatchdogAction(state({
    lastWsInboundAt: NOW - 61 * MIN,
    reconnectAlreadyTried: true,
  }));
  assert.strictEqual(d.action, 'restart');
  assert.strictEqual(d.reason, 'ws-source-unhealthy');
});

test('websocket: first boot, unreachable past hard threshold -> restart', () => {
  const d = decideWatchdogAction(state({
    lastWsInboundAt: 0,
    watchdogStartedAt: NOW - 61 * MIN, // configured but never connected for 61 min
  }));
  assert.strictEqual(d.action, 'restart');
});

test('websocket: recovery returns small staleMs so the caller re-arms the latch', () => {
  const d = decideWatchdogAction(state({ lastWsInboundAt: NOW - 20 * 1000 }));
  assert.strictEqual(d.action, 'ok');
  assert.ok(d.staleMs < 5 * MIN, 'staleMs below reconnect threshold');
});

test('disabled: timeoutMs <= 0 -> ok regardless of staleness', () => {
  const d = decideWatchdogAction(state({ timeoutMs: 0, lastWsInboundAt: 0, watchdogStartedAt: NOW - 999 * MIN }));
  assert.strictEqual(d.action, 'ok');
  assert.strictEqual(d.reason, 'disabled');
});

test('no controller host -> ok/no-controller (fresh install waiting on setup)', () => {
  const d = decideWatchdogAction(state({ hasHost: false, lastWsInboundAt: 0, watchdogStartedAt: NOW - 999 * MIN }));
  assert.strictEqual(d.action, 'ok');
  assert.strictEqual(d.reason, 'no-controller');
});

test('api_webhook: silent past window -> reconnect; past 2x -> restart; fresh -> ok', () => {
  const base = { mode: 'api_webhook' };
  const fresh = decideWatchdogAction(state(Object.assign({}, base, { lastEventTime: NOW - 1 * MIN })));
  assert.strictEqual(fresh.action, 'ok');

  const soft = decideWatchdogAction(state(Object.assign({}, base, { lastEventTime: NOW - 61 * MIN })));
  assert.strictEqual(soft.action, 'reconnect');
  assert.strictEqual(soft.reason, 'webhook-silent');

  const softLatched = decideWatchdogAction(state(Object.assign({}, base, {
    lastEventTime: NOW - 61 * MIN, reconnectAlreadyTried: true,
  })));
  assert.strictEqual(softLatched.action, 'ok');

  const hard = decideWatchdogAction(state(Object.assign({}, base, {
    lastEventTime: NOW - 121 * MIN, reconnectAlreadyTried: true,
  })));
  assert.strictEqual(hard.action, 'restart');
  assert.strictEqual(hard.reason, 'webhook-silent-long');
});

test('alarm_manager / unknown mode is inert (no source to watch)', () => {
  const am = decideWatchdogAction(state({ mode: 'alarm_manager', lastWsInboundAt: 0, watchdogStartedAt: NOW - 999 * MIN }));
  assert.strictEqual(am.action, 'ok');
  assert.strictEqual(am.reason, 'mode-has-no-source');

  const unknown = decideWatchdogAction(state({ mode: 'something-else', lastWsInboundAt: 0, watchdogStartedAt: NOW - 999 * MIN }));
  assert.strictEqual(unknown.action, 'ok');
});

test('clamp: reconnectAfterMs >= timeoutMs still restarts at the hard threshold', () => {
  // Misconfig where the soft window is not below the hard window.
  const d = decideWatchdogAction(state({
    timeoutMs: 5 * MIN,
    reconnectAfterMs: 5 * MIN,
    lastWsInboundAt: NOW - 6 * MIN,
  }));
  assert.strictEqual(d.action, 'restart');
});
