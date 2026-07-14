'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const {
  ZwavePairing,
  INCLUSION_STRATEGY_DEFAULT,
  INCLUSION_STRATEGY_SECURITY_S0,
  INCLUSION_STRATEGY_SECURITY_S2,
} = require('../src/drivers/zwave-pairing');

// Controller mock: captures beginInclusion options so tests can drive the
// userCallbacks, and lets tests emit 'inclusion started' / 'node added' etc.
class MockController extends EventEmitter {
  constructor() {
    super();
    this.inclusionOpts = null;
    this.stopInclusionCalls = 0;
    this.stopExclusionCalls = 0;
    this.beginInclusionResult = true;
    this.beginExclusionResult = true;
  }
  async beginInclusion(opts) { this.inclusionOpts = opts; return this.beginInclusionResult; }
  async stopInclusion() { this.stopInclusionCalls++; return true; }
  async beginExclusion() { return this.beginExclusionResult; }
  async stopExclusion() { this.stopExclusionCalls++; return true; }
}

// Manager mock compatible with what ZwavePairing uses.
class MockManager extends EventEmitter {
  constructor() {
    super();
    this.mockController = new MockController();
    this.running = false;
    this.stopCalls = 0;
    this.failStart = false;
  }
  get controller() { return this.running ? this.mockController : null; }
  isRunning() { return this.running; }
  async ensureStarted(opts) {
    if (this.failStart) throw new Error('port open failed');
    this.running = true;
    this.serialPath = (opts && opts.serial_path) || this.serialPath || null;
    return {};
  }
  async stop() { this.stopCalls++; this.running = false; this.serialPath = null; }
}

function makePairing(overrides = {}) {
  const manager = overrides.manager || new MockManager();
  const calls = { keysPersisted: 0, includeDone: [], excludeDone: [] };
  const pairing = new ZwavePairing(Object.assign({
    manager,
    logger: { warn() {}, info() {} },
    getZwaveConfig: () => ({ serial_path: 'COM3' }),
    ensureKeysPersisted: async () => { calls.keysPersisted++; return { generated: true }; },
    onIncludeDone: async (r) => { calls.includeDone.push(r); },
    onExcludeDone: async (r) => { calls.excludeDone.push(r); },
    isLockBound: () => false,
    timeouts: { starting: 500, waiting: 500, dsk: 500, provisioning: 500 },
  }, overrides));
  return { pairing, manager, calls };
}

test('happy path: start -> waiting -> dsk -> pin -> provisioning -> done', async () => {
  const { pairing, manager, calls } = makePairing();
  await pairing.startInclusion();
  assert.strictEqual(pairing.state, 'starting');
  assert.strictEqual(calls.keysPersisted, 1);
  const ctl = manager.mockController;
  // Default mode is auto: zwave-js Default strategy with security forced, so
  // a lock joins S2 when it can and S0 when that is all it has.
  assert.strictEqual(ctl.inclusionOpts.strategy, INCLUSION_STRATEGY_DEFAULT);
  assert.strictEqual(ctl.inclusionOpts.forceSecurity, true);

  ctl.emit('inclusion started');
  assert.strictEqual(pairing.state, 'waiting_for_device');

  // grantSecurityClasses echoes the requested classes
  const requested = { securityClasses: [2], clientSideAuth: false };
  assert.deepStrictEqual(await ctl.inclusionOpts.userCallbacks.grantSecurityClasses(requested), requested);

  // DSK arrives: state flips and the partial DSK is exposed
  const pinPromise = ctl.inclusionOpts.userCallbacks.validateDSKAndEnterPIN('-11111-22222-33333');
  assert.strictEqual(pairing.state, 'dsk_pending');
  assert.strictEqual(pairing.status().dsk, '-11111-22222-33333');

  pairing.submitPin('54321');
  assert.strictEqual(pairing.state, 'provisioning');
  assert.strictEqual(await pinPromise, '54321');

  ctl.emit('node added', { id: 17 }, { lowSecurity: false });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(pairing.state, 'done');
  assert.strictEqual(pairing.status().node_id, 17);
  assert.deepStrictEqual(calls.includeDone, [{ nodeId: 17, securityClass: 'S2 Access Control' }]);
  assert.strictEqual(pairing.isActive(), false);
});

test('keys are persisted before beginInclusion (ordering)', async () => {
  const order = [];
  const manager = new MockManager();
  const origBegin = manager.mockController.beginInclusion.bind(manager.mockController);
  manager.mockController.beginInclusion = async (opts) => { order.push('begin'); return origBegin(opts); };
  const { pairing } = makePairing({
    manager,
    ensureKeysPersisted: async () => { order.push('keys'); return { generated: false }; },
  });
  await pairing.startInclusion();
  assert.deepStrictEqual(order, ['keys', 'begin']);
});

test('an unencrypted join fails loud with the recovery message', async () => {
  const { pairing, manager, calls } = makePairing();
  await pairing.startInclusion();
  const ctl = manager.mockController;
  ctl.emit('inclusion started');
  // lowSecurity and no encrypted class resolvable: a deadbolt must never
  // operate unencrypted, so this is a hard failure.
  ctl.emit('node added', { id: 9, getHighestSecurityClass: () => -1 }, { lowSecurity: true });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(pairing.state, 'failed');
  assert.match(pairing.status().error, /WITHOUT encryption/);
  assert.strictEqual(calls.includeDone.length, 0);
});

test('a None-class join with lowSecurity=false fails closed (not fabricated as S2)', async () => {
  const { pairing, manager, calls } = makePairing();
  await pairing.startInclusion({ security: 's2' });
  const ctl = manager.mockController;
  ctl.emit('inclusion started');
  // The fail-open case: a lock lacking the Security-2 CC joins at None (-1)
  // while zwave-js reports lowSecurity:false. The class, not the flag, must
  // decide; this must be rejected, never relabelled 'S2 Access Control'.
  ctl.emit('node added', { id: 8, getHighestSecurityClass: () => -1 }, { lowSecurity: false });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(pairing.state, 'failed');
  assert.match(pairing.status().error, /WITHOUT encryption/);
  assert.strictEqual(calls.includeDone.length, 0);
});

test('an S0 join is ACCEPTED and recorded as S0 Legacy (the Yale case)', async () => {
  const { pairing, manager, calls } = makePairing();
  await pairing.startInclusion({ security: 'auto' });
  const ctl = manager.mockController;
  ctl.emit('inclusion started');
  // zwave-js flags an S0 join under the Default strategy as lowSecurity
  // (S0Downgrade) even though it IS encrypted; the class decides, not the flag.
  ctl.emit('node added', { id: 12, getHighestSecurityClass: () => 7 }, { lowSecurity: true });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(pairing.state, 'done');
  assert.strictEqual(pairing.status().security, 'S0 Legacy');
  assert.deepStrictEqual(calls.includeDone, [{ nodeId: 12, securityClass: 'S0 Legacy' }]);
});

test('security mode s2 and s0 map to the matching zwave-js strategies', async () => {
  for (const [mode, strategy, wantForce] of [
    ['s2', INCLUSION_STRATEGY_SECURITY_S2, undefined],
    ['s0', INCLUSION_STRATEGY_SECURITY_S0, undefined],
  ]) {
    const { pairing, manager } = makePairing();
    await pairing.startInclusion({ security: mode });
    assert.strictEqual(manager.mockController.inclusionOpts.strategy, strategy, mode);
    assert.strictEqual(manager.mockController.inclusionOpts.forceSecurity, wantForce, mode);
    assert.strictEqual(pairing.status().security_mode, mode);
    await pairing.cancel();
  }
  // an unknown mode falls back to auto rather than failing the session
  const { pairing, manager } = makePairing();
  await pairing.startInclusion({ security: 'bogus' });
  assert.strictEqual(manager.mockController.inclusionOpts.strategy, INCLUSION_STRATEGY_DEFAULT);
  await pairing.cancel();
});

test('an S0-only lock never blocks on the PIN step (no dsk stage armed)', async () => {
  const { pairing, manager } = makePairing();
  await pairing.startInclusion({ security: 's0' });
  const ctl = manager.mockController;
  ctl.emit('inclusion started');
  assert.strictEqual(pairing.state, 'waiting_for_device');
  // No validateDSKAndEnterPIN callback fires for S0; the node just lands.
  ctl.emit('node added', { id: 4, getHighestSecurityClass: () => 7 }, { lowSecurity: false });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(pairing.state, 'done');
  assert.strictEqual(pairing.status().security, 'S0 Legacy');
});

test('bad PIN format and wrong-state submissions are rejected', async () => {
  const { pairing, manager } = makePairing();
  assert.throws(() => pairing.submitPin('12345'), /Not waiting for a PIN/);
  await pairing.startInclusion();
  const ctl = manager.mockController;
  ctl.emit('inclusion started');
  ctl.inclusionOpts.userCallbacks.validateDSKAndEnterPIN('-x');
  assert.throws(() => pairing.submitPin('12a45'), /5 digits/);
  assert.throws(() => pairing.submitPin('1234'), /5 digits/);
  assert.strictEqual(pairing.state, 'dsk_pending'); // still waiting
});

test('waiting timeout fails closed and stops inclusion', async () => {
  const { pairing, manager } = makePairing({ timeouts: { starting: 500, waiting: 20, dsk: 500, provisioning: 500 } });
  await pairing.startInclusion();
  const ctl = manager.mockController;
  ctl.emit('inclusion started');
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(pairing.state, 'failed');
  assert.ok(ctl.stopInclusionCalls >= 1);
});

test('dsk timeout resolves the pending PIN promise false', async () => {
  const { pairing, manager } = makePairing({ timeouts: { starting: 500, waiting: 500, dsk: 20, provisioning: 500 } });
  await pairing.startInclusion();
  const ctl = manager.mockController;
  ctl.emit('inclusion started');
  const pinPromise = ctl.inclusionOpts.userCallbacks.validateDSKAndEnterPIN('-x');
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(pairing.state, 'failed');
  assert.strictEqual(await pinPromise, false);
});

test('cancel stops inclusion and resolves a pending PIN false', async () => {
  const { pairing, manager } = makePairing();
  await pairing.startInclusion();
  const ctl = manager.mockController;
  ctl.emit('inclusion started');
  const pinPromise = ctl.inclusionOpts.userCallbacks.validateDSKAndEnterPIN('-x');
  await pairing.cancel();
  assert.strictEqual(pairing.state, 'cancelled');
  assert.strictEqual(await pinPromise, false);
  assert.ok(ctl.stopInclusionCalls >= 1);
});

test('the driver stays running after any session outcome (log continuity)', async () => {
  // Stopping the driver between attempts created gaps in the zwave-js debug
  // log and made quick retries race Windows' slow serial-port release, so a
  // terminal session leaves the driver up regardless of who started it.
  const a = makePairing();
  await a.pairing.startInclusion();
  await a.pairing.cancel();
  assert.strictEqual(a.manager.stopCalls, 0);
  assert.strictEqual(a.manager.isRunning(), true);

  const runningManager = new MockManager();
  runningManager.running = true;
  const b = makePairing({ manager: runningManager });
  await b.pairing.startInclusion();
  await b.pairing.cancel();
  assert.strictEqual(runningManager.stopCalls, 0);
});

test('a changed serial port restarts the driver before inclusion', async () => {
  const manager = new MockManager();
  manager.running = true;
  manager.serialPath = 'COM3';
  const { pairing } = makePairing({
    manager,
    getZwaveConfig: () => ({ serial_path: 'COM4' }),
  });
  await pairing.startInclusion();
  assert.strictEqual(manager.stopCalls, 1, 'old driver stopped for the port switch');
  assert.strictEqual(manager.isRunning(), true, 'restarted on the new port');
});

test('successful include keeps the manager running for activation', async () => {
  const { pairing, manager } = makePairing();
  await pairing.startInclusion();
  const ctl = manager.mockController;
  ctl.emit('inclusion started');
  ctl.emit('node added', { id: 5 }, {});
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(pairing.state, 'done');
  assert.strictEqual(manager.stopCalls, 0); // left running for bringDeadboltOnline
});

test('second start while active throws ACTIVE; restart allowed after terminal', async () => {
  const { pairing, manager } = makePairing();
  await pairing.startInclusion();
  await assert.rejects(() => pairing.startInclusion(), /already active/);
  await pairing.cancel();
  await pairing.startInclusion(); // fresh session OK
  assert.strictEqual(pairing.state, 'starting');
  await pairing.cancel();
});

test('no serial port configured rejects with NO_PORT before any radio work', async () => {
  const { pairing, calls } = makePairing({ getZwaveConfig: () => ({}) });
  await assert.rejects(() => pairing.startInclusion(), /serial port/);
  assert.strictEqual(calls.keysPersisted, 0);
});

test('a failed manager start fails the session cleanly', async () => {
  const manager = new MockManager();
  manager.failStart = true;
  const { pairing } = makePairing({ manager });
  await assert.rejects(() => pairing.startInclusion(), /port open failed/);
  assert.strictEqual(pairing.state, 'failed');
  assert.strictEqual(pairing.isActive(), false);
});

test('exclusion: happy path reports the removed node', async () => {
  const { pairing, manager, calls } = makePairing();
  await pairing.startExclusion();
  const ctl = manager.mockController;
  ctl.emit('exclusion started');
  assert.strictEqual(pairing.state, 'waiting_for_device');
  ctl.emit('node removed', { id: 17 });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(pairing.state, 'done');
  assert.deepStrictEqual(calls.excludeDone, [{ nodeId: 17 }]);
});

test('exclusion timeout fails closed and stops exclusion', async () => {
  const { pairing, manager } = makePairing({ timeouts: { starting: 500, waiting: 20, dsk: 500, provisioning: 500 } });
  await pairing.startExclusion();
  const ctl = manager.mockController;
  ctl.emit('exclusion started');
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(pairing.state, 'failed');
  assert.ok(ctl.stopExclusionCalls >= 1);
});

test('controller listeners do not accumulate across sessions', async () => {
  const { pairing, manager } = makePairing();
  const ctl = manager.mockController;
  for (let i = 0; i < 3; i++) {
    await pairing.startInclusion();
    ctl.emit('inclusion started');
    await pairing.cancel();
  }
  assert.strictEqual(ctl.listenerCount('inclusion started'), 0);
  assert.strictEqual(ctl.listenerCount('node added'), 0);
});

test('activation failure after a radio-successful include surfaces as failed', async () => {
  const { pairing, manager } = makePairing({
    onIncludeDone: async () => { throw new Error('disk full'); },
  });
  await pairing.startInclusion();
  const ctl = manager.mockController;
  ctl.emit('inclusion started');
  ctl.emit('node added', { id: 3 }, {});
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(pairing.state, 'failed');
  assert.match(pairing.status().error, /paired as node 3 but activation failed: disk full/);
});

// ---------------------------------------------------------------------------
// Late-join adoption: the provisioning timer must not blindly fail when the
// lock actually joined (a slow S2 bootstrap after the timer caused the app to
// report failure while the lock ended up paired at the radio level).
// ---------------------------------------------------------------------------

async function driveToPin(pairing, ctl) {
  await pairing.startInclusion();
  ctl.emit('inclusion started');
  ctl.inclusionOpts.userCallbacks.validateDSKAndEnterPIN('-11111-22222');
  pairing.submitPin('12345');
}

test('provisioning timeout adopts a late S2 join instead of failing', async () => {
  const { pairing, manager, calls } = makePairing({
    timeouts: { starting: 500, waiting: 500, dsk: 500, provisioning: 20, provisioning_grace: 20 },
  });
  const ctl = manager.mockController;
  ctl.ownNodeId = 1;
  ctl.nodes = new Map([[1, { id: 1 }]]); // controller's own node pre-exists
  await driveToPin(pairing, ctl);

  // the lock joins with S2 Access Control but 'node added' never fires
  ctl.nodes.set(9, { id: 9, getHighestSecurityClass: () => 2 });
  await new Promise((r) => setTimeout(r, 120));

  assert.strictEqual(pairing.state, 'done');
  assert.strictEqual(pairing.status().node_id, 9);
  assert.deepStrictEqual(calls.includeDone, [{ nodeId: 9, securityClass: 'S2 Access Control' }]);
});

test('provisioning timeout grants one grace period while the join is mid-flight', async () => {
  const { pairing, manager } = makePairing({
    timeouts: { starting: 500, waiting: 500, dsk: 500, provisioning: 20, provisioning_grace: 200 },
  });
  const ctl = manager.mockController;
  ctl.ownNodeId = 1;
  ctl.nodes = new Map([[1, { id: 1 }]]);
  await driveToPin(pairing, ctl);

  // node exists but security class is not known yet (bootstrap mid-flight)
  ctl.nodes.set(9, { id: 9, getHighestSecurityClass: () => undefined });
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(pairing.state, 'provisioning', 'grace period keeps the session alive');

  // bootstrap finishes during the grace window
  ctl.nodes.get(9).getHighestSecurityClass = () => 2;
  await new Promise((r) => setTimeout(r, 250));
  assert.strictEqual(pairing.state, 'done');
  assert.strictEqual(pairing.status().node_id, 9);
});

test('a late join without ANY encrypted class fails with the unpair guidance', async () => {
  const { pairing, manager } = makePairing({
    timeouts: { starting: 500, waiting: 500, dsk: 500, provisioning: 20, provisioning_grace: 20 },
  });
  const ctl = manager.mockController;
  ctl.ownNodeId = 1;
  ctl.nodes = new Map([[1, { id: 1 }]]);
  await driveToPin(pairing, ctl);

  ctl.nodes.set(9, { id: 9, getHighestSecurityClass: () => -1 }); // SecurityClass.None
  await new Promise((r) => setTimeout(r, 120));

  assert.strictEqual(pairing.state, 'failed');
  assert.match(pairing.status().error, /without an encrypted class/);
  assert.match(pairing.status().error, /Unpair/);
  assert.strictEqual(pairing.status().node_id, 9);
});

test('a late join at S0 Legacy is adopted (the slow Yale case)', async () => {
  const { pairing, manager, calls } = makePairing({
    timeouts: { starting: 500, waiting: 500, dsk: 500, provisioning: 20, provisioning_grace: 20 },
  });
  const ctl = manager.mockController;
  ctl.ownNodeId = 1;
  ctl.nodes = new Map([[1, { id: 1 }]]);
  await driveToPin(pairing, ctl);

  ctl.nodes.set(11, { id: 11, getHighestSecurityClass: () => 7 }); // S0_Legacy
  await new Promise((r) => setTimeout(r, 120));

  assert.strictEqual(pairing.state, 'done');
  assert.strictEqual(pairing.status().security, 'S0 Legacy');
  assert.deepStrictEqual(calls.includeDone, [{ nodeId: 11, securityClass: 'S0 Legacy' }]);
});

test('provisioning timeout with no joined node still fails with guidance', async () => {
  const { pairing, manager } = makePairing({
    timeouts: { starting: 500, waiting: 500, dsk: 500, provisioning: 20, provisioning_grace: 20 },
  });
  const ctl = manager.mockController;
  ctl.ownNodeId = 1;
  ctl.nodes = new Map([[1, { id: 1 }]]);
  await driveToPin(pairing, ctl);

  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(pairing.state, 'failed');
  assert.match(pairing.status().error, /secure join timed out/);
  assert.match(pairing.status().error, /Unpair \(exclusion\)/);
});

// ---------------------------------------------------------------------------
// Pre-flight recovery: earlier aborted sessions leave ghost nodes on the stick
// and can leave the lock itself included without the app knowing. zwave-js
// silently aborts re-inclusion of an already-included device, so this must be
// caught before the radio work starts.
// ---------------------------------------------------------------------------

test('startInclusion removes dead ghost nodes before starting', async () => {
  const { pairing, manager } = makePairing();
  const ctl = manager.mockController;
  ctl.ownNodeId = 1;
  ctl.nodes = new Map([[1, { id: 1 }], [2, { id: 2 }], [3, { id: 3 }]]);
  const removed = [];
  ctl.isFailedNode = async (id) => id !== 1; // 2 and 3 are dead ghosts
  ctl.removeFailedNode = async (id) => { removed.push(id); ctl.nodes.delete(id); };

  await pairing.startInclusion();
  assert.deepStrictEqual(removed.sort(), [2, 3]);
  assert.ok(ctl.inclusionOpts, 'inclusion proceeds after cleanup');
  assert.strictEqual(pairing.state, 'starting');
});

test('startInclusion blocks when a live foreign node is already included', async () => {
  const { pairing, manager } = makePairing();
  const ctl = manager.mockController;
  ctl.ownNodeId = 1;
  ctl.nodes = new Map([[1, { id: 1 }], [6, { id: 6 }]]);
  ctl.isFailedNode = async () => false; // node 6 is alive
  ctl.removeFailedNode = async () => { throw new Error('must not be called'); };

  await assert.rejects(() => pairing.startInclusion(), /already paired to this stick as node 6/);
  assert.strictEqual(ctl.inclusionOpts, null, 'beginInclusion must not run');
  assert.strictEqual(pairing.state, 'failed');
  assert.match(pairing.status().error, /Unpair/);
});

test('the configured lock node is neither a ghost nor a foreign device', async () => {
  const { pairing, manager } = makePairing({
    getZwaveConfig: () => ({ serial_path: 'COM3', locks: { deadbolt: { node_id: 6 } } }),
  });
  const ctl = manager.mockController;
  ctl.ownNodeId = 1;
  ctl.nodes = new Map([[1, { id: 1 }], [6, { id: 6 }]]);
  const failedChecks = [];
  ctl.isFailedNode = async (id) => { failedChecks.push(id); return false; };
  ctl.removeFailedNode = async () => { throw new Error('must not be called'); };

  await pairing.startInclusion();
  assert.deepStrictEqual(failedChecks, [], 'configured node is never even checked');
  assert.ok(ctl.inclusionOpts, 'inclusion proceeds');
});

test('history records every session step but never the PIN digits', async () => {
  const { pairing, manager } = makePairing();
  const ctl = manager.mockController;
  await driveToPin(pairing, ctl); // submits PIN 12345
  ctl.emit('node added', { id: 7 }, { lowSecurity: false });
  await new Promise((r) => setImmediate(r));

  const hist = pairing.status().history;
  assert.ok(Array.isArray(hist) && hist.length > 0, 'history is populated');
  const joined = JSON.stringify(hist);
  assert.match(joined, /include session starting/);
  assert.match(joined, /DSK received/);
  assert.match(joined, /PIN submitted/);
  assert.match(joined, /node 7 added/);
  assert.ok(!joined.includes('12345'), 'the PIN digits must never be recorded');
  for (const entry of hist) {
    assert.ok(entry.t && entry.msg, 'each entry carries a timestamp and message');
  }
});

// ---------------------------------------------------------------------------
// Pre-flight timing and zombie-session guards (from the field diagnostics:
// five slow ghost removals once ate the whole starting window and the failed
// session then kept running as a zombie, mutating state after failure)
// ---------------------------------------------------------------------------

test('slow ghost cleanup does not trip the starting timeout', async () => {
  const { pairing, manager } = makePairing({
    timeouts: { starting: 40, waiting: 500, dsk: 500, provisioning: 500 },
  });
  const ctl = manager.mockController;
  ctl.ownNodeId = 1;
  ctl.nodes = new Map([[1, { id: 1 }], [2, { id: 2 }], [3, { id: 3 }]]);
  ctl.isFailedNode = async (id) => id !== 1;
  ctl.removeFailedNode = async (id) => {
    await new Promise((r) => setTimeout(r, 30)); // 2 removals x 30ms > 40ms window
    ctl.nodes.delete(id);
  };

  await pairing.startInclusion();
  assert.strictEqual(pairing.state, 'starting', 'session survives a cleanup longer than the starting window');
  assert.ok(ctl.inclusionOpts, 'inclusion proceeds after the slow cleanup');
});

test('a session failed during beginInclusion is not resurrected (zombie guard)', async () => {
  const { pairing, manager } = makePairing({
    timeouts: { starting: 500, waiting: 500, dsk: 500, provisioning: 500 },
  });
  const ctl = manager.mockController;
  // beginInclusion resolves only after the session has already been cancelled
  let releaseBegin;
  ctl.beginInclusion = async (opts) => {
    ctl.inclusionOpts = opts;
    await new Promise((r) => { releaseBegin = r; });
    return true;
  };

  const startPromise = pairing.startInclusion();
  await new Promise((r) => setImmediate(r));
  await pairing.cancel(); // session dies while beginInclusion is in flight
  assert.strictEqual(pairing.state, 'cancelled');

  const stopCallsBefore = ctl.stopInclusionCalls;
  releaseBegin();
  await startPromise;

  assert.strictEqual(pairing.state, 'cancelled', 'a dead session must stay dead');
  assert.ok(ctl.stopInclusionCalls > stopCallsBefore, 'the orphaned radio listen is stopped');

  // late events must not resurrect it either
  ctl.emit('inclusion started');
  assert.strictEqual(pairing.state, 'cancelled');
});
