'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { LockState } = require('../src/drivers/lock-driver');
const { ZwaveLock } = require('../src/drivers/zwave-lock');
const FakeLock = require('../src/drivers/fake-lock');

/**
 * Minimal stand-in for a zwave-js ZWaveNode. Drives the Door Lock CC and
 * emits the events the adapter listens for, so the adapter's verify/retry/jam
 * logic can be tested with no native package and no hardware.
 *
 * opts: { current, confirm, jam, failSetOnce,
 *         status, ready,        // NodeStatus number / interview-ready flag
 *         values,               // cache map '<cc>:<property>' -> value for getValue()
 *         battery }             // Battery CC live level
 */
class MockNode extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.current = opts.current == null ? 0xff : opts.current; // default: locked
    this.confirm = opts.confirm !== false;
    this.jam = !!opts.jam;
    this.failSetOnce = !!opts.failSetOnce;
    this.setCalls = [];
    this.getCalls = 0;
    if (opts.status != null) this.status = opts.status;
    if (opts.ready != null) this.ready = opts.ready;
    const self = this;
    // A real node exposes a value cache; only mock it when the test provides
    // one, so the legacy tests keep exercising the no-cache live-read path.
    if (opts.values) {
      this.values = opts.values;
      this.getValue = (vid) => self.values[`${vid.commandClass}:${vid.property}`];
    }
    this.commandClasses = {
      'Door Lock': {
        set: async (mode) => {
          self.setCalls.push(mode);
          if (self.failSetOnce) {
            self.failSetOnce = false;
            throw new Error('set failed');
          }
          if (self.jam) {
            setImmediate(() => self.emit('notification', self, 0x71, { type: 6, event: 0x0b }));
            return;
          }
          if (!self.confirm) return;
          setImmediate(() => {
            self.current = mode;
            self.emit('value updated', self, {
              commandClassName: 'Door Lock',
              property: 'currentMode',
              newValue: mode,
            });
          });
        },
        get: async () => {
          self.getCalls++;
          return { currentMode: self.current };
        },
      },
    };
    if (opts.battery != null) {
      this.batteryLevel = opts.battery;
      this.commandClasses.Battery = {
        get: async () => ({ level: self.batteryLevel }),
      };
    }
  }
}

async function makeZwave(nodeOpts = {}, cfg = {}) {
  const node = new MockNode(nodeOpts);
  const lock = new ZwaveLock(
    Object.assign({ node_id: 2, verify_timeout_ms: 40, verify_retries: 1 }, cfg),
    { node, logger: { warn() {} } }
  );
  await lock.init();
  return { node, lock };
}

test('ZwaveLock: init seeds state from the device', async () => {
  const { lock } = await makeZwave({ current: 0xff });
  const s = await lock.getState();
  assert.equal(s.boltState, LockState.LOCKED);
  assert.equal(s.online, true);
});

test('ZwaveLock: lock() sets SECURED and verifies', async () => {
  const { node, lock } = await makeZwave({ current: 0x00 });
  const r = await lock.lock('test');
  assert.equal(r.success, true);
  assert.equal(r.boltState, LockState.LOCKED);
  assert.deepEqual(node.setCalls, [0xff]);
});

test('ZwaveLock: unlock() sets UNSECURED and verifies', async () => {
  const { node, lock } = await makeZwave({ current: 0xff });
  const r = await lock.unlock('entry');
  assert.equal(r.success, true);
  assert.equal(r.boltState, LockState.UNLOCKED);
  assert.deepEqual(node.setCalls, [0x00]);
});

test('ZwaveLock: a jam yields failure with JAMMED state', async () => {
  const { lock } = await makeZwave({ current: 0x00, jam: true }, { verify_retries: 0 });
  const r = await lock.lock('lockup');
  assert.equal(r.success, false);
  assert.equal(r.boltState, LockState.JAMMED);
});

test('ZwaveLock: no confirmation times out and retries, then fails', async () => {
  const { node, lock } = await makeZwave(
    { current: 0xff, confirm: false },
    { verify_retries: 1, verify_timeout_ms: 25 }
  );
  const r = await lock.unlock('entry');
  assert.equal(r.success, false);
  assert.equal(node.setCalls.length, 2); // initial attempt + one retry
});

test('ZwaveLock: a transient set error is retried and can succeed', async () => {
  const { node, lock } = await makeZwave({ current: 0x00, failSetOnce: true }, { verify_retries: 1 });
  const r = await lock.lock('lockup');
  assert.equal(r.success, true);
  assert.equal(r.boltState, LockState.LOCKED);
  assert.equal(node.setCalls.length, 2);
});

test('ZwaveLock: unsolicited unlock notification updates state', async () => {
  const { node, lock } = await makeZwave({ current: 0xff });
  node.emit('notification', node, 0x71, { type: 6, event: 0x02 }); // manual unlock
  const s = await lock.getState();
  assert.equal(s.boltState, LockState.UNLOCKED);
});

test('ZwaveLock: unsolicited jam notification updates state', async () => {
  const { node, lock } = await makeZwave({ current: 0xff });
  node.emit('notification', node, 0x71, { type: 6, event: 0x0b });
  const s = await lock.getState();
  assert.equal(s.boltState, LockState.JAMMED);
});

test('ZwaveLock: ignores a notification whose type is not Access Control', async () => {
  const { node, lock } = await makeZwave({ current: 0xff }); // seeded locked
  // A non-Access-Control (type != 6) notification that reuses event number 2
  // must NOT be interpreted as an unlock.
  node.emit('notification', node, 0x71, { type: 5, event: 0x02 });
  const s = await lock.getState();
  assert.equal(s.boltState, LockState.LOCKED, 'state unchanged for non-AC notification');
});

// ---------------------------------------------------------------------------
// State recovery for a sleeping/interviewing lock (field report: bolt unknown,
// battery n/a, link offline forever after a pair whose interview died).
// ---------------------------------------------------------------------------

const ST = { UNKNOWN: 0, ASLEEP: 1, AWAKE: 2, DEAD: 3, ALIVE: 4 };
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test('ZwaveLock: asleep node seeds from the value cache with NO live read', async () => {
  const { node, lock } = await makeZwave({
    status: ST.ASLEEP,
    values: { '98:currentMode': 0xff, '128:level': 88 }, // 0x62 / 0x80
  });
  const s = await lock.getState();
  assert.equal(s.boltState, LockState.LOCKED);
  assert.equal(s.battery, 88);
  assert.equal(s.batteryLow, false);
  assert.equal(s.linkState, 'asleep');
  assert.equal(s.online, true, 'a sleeping battery lock is NOT offline');
  assert.equal(node.getCalls, 0, 'no wire read while the node sleeps');
});

test('ZwaveLock: interview completed re-seeds bolt and battery from the cache', async () => {
  const values = {}; // interview not done: cache empty at init
  const { node, lock } = await makeZwave({ status: ST.ASLEEP, values });
  assert.equal((await lock.getState()).boltState, LockState.UNKNOWN);
  values['98:currentMode'] = 0x00;
  values['128:level'] = 61;
  node.emit('interview completed', node);
  const s = await lock.getState();
  assert.equal(s.boltState, LockState.UNLOCKED);
  assert.equal(s.battery, 61);
});

test('ZwaveLock: dead node reads offline, alive recovers link and state live', async () => {
  const { node, lock } = await makeZwave({ status: ST.DEAD, values: {}, current: 0xff, battery: 42 });
  let s = await lock.getState();
  assert.equal(s.linkState, 'offline');
  assert.equal(s.online, false);
  assert.equal(s.boltState, LockState.UNKNOWN, 'no live read attempted on a dead node');
  node.status = ST.ALIVE;
  node.emit('alive', node, ST.DEAD);
  await tick(); // fire-and-forget live refresh
  s = await lock.getState();
  assert.equal(s.linkState, 'online');
  assert.equal(s.online, true);
  assert.equal(s.boltState, LockState.LOCKED, 'live refresh re-read the bolt');
  assert.equal(s.battery, 42, 'live refresh read the Battery CC');
});

test('ZwaveLock: battery at/under the threshold flags batteryLow', async () => {
  const { lock } = await makeZwave(
    { status: ST.AWAKE, values: { '128:level': 20 } },
    { low_battery_pct: 25 }
  );
  const s = await lock.getState();
  assert.equal(s.battery, 20);
  assert.equal(s.batteryLow, true);
});

test('ZwaveLock: failed command on a dead node explains itself', async () => {
  const { lock } = await makeZwave(
    { status: ST.DEAD, values: {}, current: 0x00, confirm: false },
    { verify_retries: 0, verify_timeout_ms: 25 }
  );
  const r = await lock.lock('test');
  assert.equal(r.success, false);
  assert.match(r.error, /node dead/i);
  assert.match(r.error, /keypad/i);
});

test('ZwaveLock: failed command on an asleep node says to wake it', async () => {
  const { lock } = await makeZwave(
    { status: ST.ASLEEP, values: {}, confirm: false },
    { verify_retries: 0, verify_timeout_ms: 25 }
  );
  const r = await lock.unlock('test');
  assert.equal(r.success, false);
  assert.match(r.error, /asleep/i);
});

test('ZwaveLock: reinterview calls node.refreshInfo, throws when unavailable', async () => {
  const { node, lock } = await makeZwave({ status: ST.AWAKE, values: {} });
  let called = 0;
  node.refreshInfo = async () => { called++; };
  await lock.reinterview();
  assert.equal(called, 1);
  const bare = new ZwaveLock({ node_id: 2 }, { node: new MockNode() });
  assert.throws(() => bare.reinterview(), /re-interview unavailable/);
});

test('ZwaveLock: capabilities include lock/unlock/state', () => {
  const lock = new ZwaveLock({ node_id: 2 }, { node: new MockNode() });
  for (const c of ['lock', 'unlock', 'state', 'battery']) assert.ok(lock.capabilities.has(c));
});

test('FakeLock: records calls and toggles state', async () => {
  const f = new FakeLock({ initial: LockState.LOCKED });
  await f.init();
  const r = await f.unlock('entry');
  assert.equal(r.success, true);
  assert.equal(r.boltState, LockState.UNLOCKED);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].action, 'unlock');
});

test('FakeLock: jamOnLock fails with JAMMED', async () => {
  const f = new FakeLock({ initial: LockState.UNLOCKED, behavior: { jamOnLock: true } });
  await f.init();
  const r = await f.lock('lockup');
  assert.equal(r.success, false);
  assert.equal(r.boltState, LockState.JAMMED);
});

test('FakeLock: offline fails cleanly', async () => {
  const f = new FakeLock({ behavior: { offline: true } });
  await f.init();
  const r = await f.unlock();
  assert.equal(r.success, false);
  assert.equal(r.error, 'offline');
});
