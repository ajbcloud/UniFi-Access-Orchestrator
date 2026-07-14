'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { ZwaveManager } = require('../src/drivers/zwave-manager');

// Driver-like mock: emits 'driver ready' on start() (or an error), tracks destroy.
class MockDriver extends EventEmitter {
  constructor({ failStart = false, slow = false } = {}) {
    super();
    this.failStart = failStart;
    this.slow = slow;
    this.destroyed = false;
    this.controller = { nodes: new Map() };
  }
  async start() {
    const fire = () => {
      if (this.failStart) this.emit('error', new Error('port open failed'));
      else this.emit('driver ready');
    };
    if (this.slow) setTimeout(fire, 10);
    else setImmediate(fire);
  }
  async destroy() { this.destroyed = true; }
}

function makeManager(opts = {}) {
  const made = [];
  const manager = new ZwaveManager({
    logger: { warn() {}, info() {} },
    driverFactory: (path, options) => {
      const d = new MockDriver(opts);
      d.path = path;
      d.options = options;
      made.push(d);
      return d;
    },
    loadKeys: () => ({ classic: { S2_AccessControl: Buffer.alloc(16) }, longRange: {} }),
  });
  return { manager, made };
}

test('ensureStarted is idempotent: one driver for repeated calls', async () => {
  const { manager, made } = makeManager();
  const d1 = await manager.ensureStarted({ serial_path: 'COM3' });
  const d2 = await manager.ensureStarted({ serial_path: 'COM3' });
  assert.strictEqual(d1, d2);
  assert.strictEqual(made.length, 1);
  assert.strictEqual(manager.isRunning(), true);
});

test('concurrent ensureStarted calls share one in-flight start', async () => {
  const { manager, made } = makeManager({ slow: true });
  const [d1, d2] = await Promise.all([
    manager.ensureStarted({ serial_path: 'COM3' }),
    manager.ensureStarted({ serial_path: 'COM3' }),
  ]);
  assert.strictEqual(d1, d2);
  assert.strictEqual(made.length, 1);
});

test('a failed start destroys the driver (no port leak) and stays retryable', async () => {
  const { manager, made } = makeManager({ failStart: true });
  await assert.rejects(() => manager.ensureStarted({ serial_path: 'COM3' }), /port open failed/);
  assert.strictEqual(made[0].destroyed, true);
  assert.strictEqual(manager.isRunning(), false);
  // retry works (mock keeps failing, but a NEW driver is attempted)
  await assert.rejects(() => manager.ensureStarted({ serial_path: 'COM3' }));
  assert.strictEqual(made.length, 2);
});

test('a different serial path while running throws', async () => {
  const { manager } = makeManager();
  await manager.ensureStarted({ serial_path: 'COM3' });
  await assert.rejects(() => manager.ensureStarted({ serial_path: 'COM4' }), /already running on COM3/);
});

test('stop destroys the driver and allows a fresh start', async () => {
  const { manager, made } = makeManager();
  await manager.ensureStarted({ serial_path: 'COM3' });
  await manager.stop();
  assert.strictEqual(made[0].destroyed, true);
  assert.strictEqual(manager.isRunning(), false);
  await manager.ensureStarted({ serial_path: 'COM4' }); // port switch allowed after stop
  assert.strictEqual(made.length, 2);
});

test('driver errors after start are re-emitted and tear the dead driver down', async () => {
  const { manager, made } = makeManager();
  await manager.ensureStarted({ serial_path: 'COM3' });
  let seen = null;
  manager.on('driver-error', (e) => { seen = e; });
  made[0].emit('error', new Error('mid-flight failure'));
  assert.strictEqual(seen.message, 'mid-flight failure');
  // Self-heal contract: a dead driver must never claim to be running (that
  // used to hand a stale driver to every caller until app restart).
  assert.strictEqual(manager.isRunning(), false);
  assert.strictEqual(manager.status().restart_pending, true);
  await manager.stop(); // cancel the pending self-heal for test isolation
});

// ---------------------------------------------------------------------------
// Self-healing restart loop (unattended-rack requirement)
// ---------------------------------------------------------------------------

test('a driver error auto-restarts the driver: down then restarted', async () => {
  const { manager, made } = makeManagerWith({ restartBaseMs: 10, restartMaxMs: 20 });
  await manager.ensureStarted({ serial_path: 'COM3' });
  const events = [];
  manager.on('driver-down', () => events.push('down'));
  manager.on('driver-restarted', () => events.push('restarted'));
  made[0].emit('error', new Error('serial gone'));
  assert.strictEqual(manager.isRunning(), false, 'dead driver torn down immediately');
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(made.length, 2, 'a fresh driver was started');
  assert.strictEqual(manager.isRunning(), true);
  assert.deepStrictEqual(events, ['down', 'restarted']);
  assert.strictEqual(made[0].destroyed, true, 'old driver destroyed (no port leak)');
  assert.strictEqual(manager.status().auto_restarts, 1);
  await manager.stop();
});

test('the restart loop keeps retrying with backoff until the port returns', async () => {
  let calls = 0;
  const made = [];
  const manager = new ZwaveManager({
    logger: { warn() {}, info() {} },
    restartBaseMs: 5,
    restartMaxMs: 10,
    driverFactory: () => {
      calls++;
      const d = new MockDriver({ failStart: calls === 2 || calls === 3 }); // stick "unplugged" for two attempts
      made.push(d);
      return d;
    },
    loadKeys: () => ({ classic: {}, longRange: {} }),
  });
  await manager.ensureStarted({ serial_path: 'COM3' });
  made[0].emit('error', new Error('unplugged'));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(calls >= 4, `expected retries until success, saw ${calls} starts`);
  assert.strictEqual(manager.isRunning(), true, 'healed once the port came back');
  await manager.stop();
});

test('stop() cancels a pending self-heal restart (operator decision wins)', async () => {
  const { manager, made } = makeManagerWith({ restartBaseMs: 20, restartMaxMs: 20 });
  await manager.ensureStarted({ serial_path: 'COM3' });
  made[0].emit('error', new Error('gone'));
  await manager.stop();
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(made.length, 1, 'no restart after an explicit stop');
  assert.strictEqual(manager.isRunning(), false);
});

test('ensureStarted requires a serial path', async () => {
  const { manager } = makeManager();
  await assert.rejects(() => manager.ensureStarted({}), /No Z-Wave serial path/);
});

test('driver options carry the Yale user-code interview guard', async () => {
  const { manager, made } = makeManager();
  await manager.ensureStarted({ serial_path: 'COM3' });
  // zwave-js issue 2725: querying all user codes can drain Yale batteries.
  // No PINs are used here, so the guard must be explicit in the options.
  assert.strictEqual(made[0].options.interview.queryAllUserCodes, false);
});

// ---------------------------------------------------------------------------
// zwave-js debug file logging (added to diagnose S2 "secure join" failures)
// ---------------------------------------------------------------------------

function makeManagerWith(deps) {
  const made = [];
  const manager = new ZwaveManager(Object.assign({
    logger: { warn() {}, info() {} },
    driverFactory: (path, options) => {
      const d = new MockDriver();
      d.path = path; d.options = options; made.push(d);
      return d;
    },
    loadKeys: () => ({ classic: {}, longRange: {} }),
  }, deps));
  return { manager, made };
}

test('logConfig is passed to the driver when a log dir is configured', async () => {
  const dir = require('os').tmpdir();
  const { manager, made } = makeManagerWith({ logDir: dir, logLevel: 'debug' });
  await manager.ensureStarted({ serial_path: 'COM3' });
  const lc = made[0].options.logConfig;
  assert.ok(lc, 'logConfig should be present');
  assert.strictEqual(lc.enabled, true);
  assert.strictEqual(lc.logToFile, true);
  assert.strictEqual(lc.level, 'debug');
  assert.ok(String(lc.filename).endsWith('zwave.log'), 'log filename under the log dir');
});

test('no logConfig when no log dir is configured (tests/headless stay quiet)', async () => {
  const { manager, made } = makeManagerWith({});
  await manager.ensureStarted({ serial_path: 'COM3' });
  assert.strictEqual(made[0].options.logConfig, undefined);
});

test('an invalid log level is clamped to debug', async () => {
  const dir = require('os').tmpdir();
  const { manager, made } = makeManagerWith({ logDir: dir, logLevel: 'bogus' });
  await manager.ensureStarted({ serial_path: 'COM3' });
  assert.strictEqual(made[0].options.logConfig.level, 'debug');
});
