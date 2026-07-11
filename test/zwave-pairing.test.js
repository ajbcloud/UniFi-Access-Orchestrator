'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { ZwavePairing, INCLUSION_STRATEGY_SECURITY_S2 } = require('../src/drivers/zwave-pairing');

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
  async ensureStarted() {
    if (this.failStart) throw new Error('port open failed');
    this.running = true;
    return {};
  }
  async stop() { this.stopCalls++; this.running = false; }
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
  assert.strictEqual(ctl.inclusionOpts.strategy, INCLUSION_STRATEGY_SECURITY_S2);

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

test('lowSecurity join fails loud with the recovery message', async () => {
  const { pairing, manager, calls } = makePairing();
  await pairing.startInclusion();
  const ctl = manager.mockController;
  ctl.emit('inclusion started');
  ctl.emit('node added', { id: 9 }, { lowSecurity: true });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(pairing.state, 'failed');
  assert.match(pairing.status().error, /WITHOUT S2/);
  assert.strictEqual(calls.includeDone.length, 0);
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

test('manager stopped on failure only when pairing started it and no lock is bound', async () => {
  // pairing started the manager, no lock -> stop
  const a = makePairing();
  await a.pairing.startInclusion();
  await a.pairing.cancel();
  assert.strictEqual(a.manager.stopCalls, 1);

  // manager already running (lock started it) -> never stopped
  const runningManager = new MockManager();
  runningManager.running = true;
  const b = makePairing({ manager: runningManager });
  await b.pairing.startInclusion();
  await b.pairing.cancel();
  assert.strictEqual(runningManager.stopCalls, 0);

  // pairing started it but a lock is bound -> never stopped
  const c = makePairing({ isLockBound: () => true });
  await c.pairing.startInclusion();
  await c.pairing.cancel();
  assert.strictEqual(c.manager.stopCalls, 0);
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
