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
 * opts: { current, confirm, jam, failSetOnce }
 */
class MockNode extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.current = opts.current == null ? 0xff : opts.current; // default: locked
    this.confirm = opts.confirm !== false;
    this.jam = !!opts.jam;
    this.failSetOnce = !!opts.failSetOnce;
    this.setCalls = [];
    const self = this;
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
        get: async () => ({ currentMode: self.current }),
      },
    };
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
