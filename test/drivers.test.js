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
    // Identity surface (zwave-js: MaybeNotKnown until interviewed).
    if (opts.identity) {
      const idn = opts.identity;
      if (idn.manufacturerId != null) this.manufacturerId = idn.manufacturerId;
      if (idn.productType != null) this.productType = idn.productType;
      if (idn.productId != null) this.productId = idn.productId;
      if (idn.deviceConfig) this.deviceConfig = idn.deviceConfig;
      if (idn.label) this.label = idn.label;
      if (idn.manufacturer) this.manufacturer = idn.manufacturer;
      if (idn.securityClass != null) this.getHighestSecurityClass = () => idn.securityClass;
    }
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
    // retry_backoff_ms is tiny here so retry tests stay fast; backoff timing
    // itself has a dedicated test below.
    Object.assign({ node_id: 2, verify_timeout_ms: 40, verify_retries: 1, retry_backoff_ms: 5 }, cfg),
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

test('ZwaveLock: a jam yields failure with JAMMED state and a jam-specific error', async () => {
  const { lock } = await makeZwave({ current: 0x00, jam: true }, { verify_retries: 0 });
  const r = await lock.lock('lockup');
  assert.equal(r.success, false);
  assert.equal(r.boltState, LockState.JAMMED);
  assert.match(r.error, /jammed/i, 'error explains the jam instead of "not verified"');
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

// ---------------------------------------------------------------------------
// Verification hardening: retry backoff, periodic polling, and device-origin
// alerts (low battery, jam).
// ---------------------------------------------------------------------------

test('ZwaveLock: retries back off between attempts', async () => {
  const times = [];
  const node = new MockNode({ current: 0x00, confirm: false });
  const origSet = node.commandClasses['Door Lock'].set;
  node.commandClasses['Door Lock'].set = async (mode) => { times.push(Date.now()); return origSet(mode); };
  const lock = new ZwaveLock(
    { node_id: 2, verify_timeout_ms: 10, verify_retries: 1, retry_backoff_ms: 60 },
    { node, logger: { warn() {} } }
  );
  await lock.init();
  const r = await lock.lock('test');
  assert.equal(r.success, false);
  assert.equal(times.length, 2, 'two attempts');
  assert.ok(times[1] - times[0] >= 50, `expected a backoff pause, got ${times[1] - times[0]}ms`);
  await lock.shutdown();
});

test('ZwaveLock: periodic poll notices silent bolt and battery drift', async () => {
  const node = new MockNode({ status: 2 /* Awake */, values: {}, current: 0xff, battery: 77 });
  node.ready = true;
  const lock = new ZwaveLock(
    { node_id: 2, poll_minutes: 0.001 }, // 60ms for the test
    { node, logger: { warn() {} } }
  );
  await lock.init();
  assert.equal((await lock.getState()).boltState, LockState.LOCKED);
  // Drift with NO value-updated event: only the poll can notice this.
  node.current = 0x00;
  node.batteryLevel = 55;
  await tick(200);
  const s = await lock.getState();
  assert.equal(s.boltState, LockState.UNLOCKED, 'poll picked up the silent bolt change');
  assert.equal(s.battery, 55, 'poll refreshed battery');
  await lock.shutdown();
});

test('ZwaveLock: poll_minutes 0 disables polling', async () => {
  const { lock } = await makeZwave({ status: 2, values: {} }, { poll_minutes: 0 });
  assert.equal(lock._pollTimer, null);
  await lock.shutdown();
});

test('ZwaveLock: low battery alert is edge triggered and re-arms on recovery', async () => {
  const { node, lock } = await makeZwave({ current: 0xff }, { low_battery_pct: 25 });
  const alerts = [];
  lock.on('alert', (a) => alerts.push(a));
  const report = (level) => node.emit('value updated', node, { commandClassName: 'Battery', property: 'level', newValue: level });
  report(24); // crossing: alert
  report(23); // still low: no repeat
  report(80); // recovered: re-arms
  report(20); // crossing again: alert
  const low = alerts.filter((a) => a.type === 'deadbolt_low_battery');
  assert.equal(low.length, 2);
  assert.match(low[0].detail, /24%/);
  await lock.shutdown();
});

test('ZwaveLock: spontaneous jam emits deadbolt_jammed once per transition', async () => {
  const { node, lock } = await makeZwave({ current: 0xff });
  const alerts = [];
  lock.on('alert', (a) => alerts.push(a));
  node.emit('notification', node, 0x71, { type: 6, event: 0x0b });
  node.emit('notification', node, 0x71, { type: 6, event: 0x0b }); // unchanged state: no repeat
  assert.equal(alerts.filter((a) => a.type === 'deadbolt_jammed').length, 1);
  await lock.shutdown();
});

// ---------------------------------------------------------------------------
// Self-healing: fail-fast preflight, dead-node revival ladder, pre-command
// ping, and the measured health check (unattended-rack requirement).
// ---------------------------------------------------------------------------

test('ZwaveLock: commands fail fast when the driver never started', async () => {
  const lock = new ZwaveLock({ node_id: 2 }, { node: new MockNode() });
  // init() never called, so _node is null (the boot-failure zombie case)
  const r = await lock.unlock('test');
  assert.equal(r.success, false);
  assert.match(r.error, /driver is not running/i);
});

test('ZwaveLock: revival ladder pings a dead node until it answers', async () => {
  const node = new MockNode({ status: ST.DEAD, values: {} });
  node.ready = true;
  let pings = 0;
  node.ping = async () => {
    pings++;
    if (pings < 3) return false;
    node.status = ST.ALIVE;
    return true;
  };
  const lock = new ZwaveLock(
    { node_id: 2, revive_base_ms: 5, revive_max_ms: 10 },
    { node, logger: { warn() {}, info() {} } }
  );
  await lock.init();
  await tick(150);
  assert.ok(pings >= 3, `expected the ladder to keep pinging, saw ${pings}`);
  const s = await lock.getState();
  assert.equal(s.online, true, 'revived node is back online');
  assert.equal(s.linkState, 'online');
  await lock.shutdown();
});

test('ZwaveLock: revived node that never interviewed gets an automatic re-interview', async () => {
  const node = new MockNode({ status: ST.DEAD, values: {} });
  node.ready = false;
  let refreshed = 0;
  node.refreshInfo = async () => { refreshed++; };
  node.ping = async () => { node.status = ST.ALIVE; return true; };
  const lock = new ZwaveLock(
    { node_id: 2, revive_base_ms: 5, revive_max_ms: 10 },
    { node, logger: { warn() {}, info() {} } }
  );
  await lock.init();
  await tick(60);
  assert.equal(refreshed, 1, 'exactly one auto re-interview (rate limited)');
  await lock.shutdown();
});

test('ZwaveLock: a dead node gets one ping before a command (revival chance)', async () => {
  const node = new MockNode({ status: ST.DEAD, values: {}, current: 0x00 });
  node.ready = true;
  let pinged = 0;
  node.ping = async () => { pinged++; node.status = ST.ALIVE; return true; };
  const lock = new ZwaveLock(
    { node_id: 2, verify_timeout_ms: 60, revive_base_ms: 60000 },
    { node, logger: { warn() {}, info() {} } }
  );
  await lock.init();
  const r = await lock.lock('test');
  assert.ok(pinged >= 1, 'pinged before commanding');
  assert.equal(r.success, true, 'command succeeded after the revival ping');
  await lock.shutdown();
});

test('ZwaveLock: healthCheck returns ping, stats, and lifeline numbers', async () => {
  const node = new MockNode({ status: ST.ALIVE, values: {} });
  node.ready = true;
  node.ping = async () => true;
  node.statistics = { rtt: 55.5, rssi: -61, lwr: { repeaters: [] }, commandsDroppedTX: 0, timeoutResponse: 1 };
  node.lastSeen = new Date('2026-07-14T00:00:00Z');
  node.checkLifelineHealth = async () => ({
    rating: 9,
    results: [{ latency: 40, numNeighbors: 2, failedPingsNode: 0, routeChanges: 0, snrMargin: 17 }],
  });
  const lock = new ZwaveLock({ node_id: 2 }, { node, logger: { warn() {}, info() {} } });
  await lock.init();
  const h = await lock.healthCheck();
  assert.equal(h.ping_ok, true);
  assert.equal(h.statistics.rtt_ms, 55.5);
  assert.equal(h.statistics.rssi_dbm, -61);
  assert.deepEqual(h.statistics.route_repeaters, []);
  assert.equal(h.lifeline.rating, 9);
  assert.equal(h.lifeline.snr_margin_db, 17);
  await lock.shutdown();
  const bare = new ZwaveLock({ node_id: 2 }, { node: new MockNode() });
  await assert.rejects(() => bare.healthCheck(), /driver is not running/);
});

// ---------------------------------------------------------------------------
// Lock identity: model auto-detect, security class, friendly name. The model
// must never be a bare "unknown" once identity is readable.
// ---------------------------------------------------------------------------

test('ZwaveLock: known Schlage ids resolve to the clean profile name', async () => {
  const { lock } = await makeZwave({
    identity: {
      manufacturerId: 0x003b, productType: 0x0001, productId: 0x0469,
      deviceConfig: { manufacturer: 'Allegion', label: 'BE469ZP', description: 'Touchscreen Deadbolt Z-Wave Plus' },
      securityClass: 2,
    },
  });
  const s = await lock.getState();
  assert.equal(s.model, 'Schlage BE469ZP Touchscreen Deadbolt');
  assert.equal(s.manufacturer, 'Allegion');
  assert.equal(s.securityClass, 'S2 Access Control');
});

test('ZwaveLock: known Yale ZW2 ids resolve to the Yale profile, S0 class', async () => {
  const { lock } = await makeZwave({
    identity: {
      manufacturerId: 0x0129, productType: 0x8002, productId: 0x1600,
      deviceConfig: { manufacturer: 'Yale', label: 'YRD226 / YRC226 / YRC246 / YRD256 / YRC256 / YRD446' },
      securityClass: 7,
    },
  });
  const s = await lock.getState();
  assert.equal(s.model, 'Yale Assure Deadbolt (ZW2)');
  assert.equal(s.securityClass, 'S0 Legacy');
});

test('ZwaveLock: unmapped device falls back to the device-db label, then raw ids', async () => {
  const { lock } = await makeZwave({
    identity: {
      manufacturerId: 0x0266, productType: 0x0001, productId: 0x0001,
      deviceConfig: { manufacturer: 'Kwikset', label: 'SmartCode 916' },
    },
  });
  assert.equal((await lock.getState()).model, 'SmartCode 916');

  const { lock: rawLock } = await makeZwave({
    identity: { manufacturerId: 0x0abc, productType: 0x0002, productId: 0x0def },
  });
  assert.equal((await rawLock.getState()).model, 'manufacturer 0x0abc product 0x0def');
});

test('ZwaveLock: config name and persisted security_class seed the snapshot', async () => {
  const { lock } = await makeZwave({}, { name: 'Front Door Deadbolt', security_class: 'S0 Legacy' });
  const s = await lock.getState();
  assert.equal(s.name, 'Front Door Deadbolt');
  assert.equal(s.securityClass, 'S0 Legacy', 'config value holds until the node can confirm');
});

test('ZwaveLock: identity arrives late via interview completed (was not known at init)', async () => {
  const node = new MockNode({ status: 1 /* Asleep */, values: {} });
  const lock = new ZwaveLock({ node_id: 2 }, { node, logger: { warn() {} } });
  await lock.init();
  assert.equal((await lock.getState()).model, null, 'nothing to show yet');
  node.manufacturerId = 0x003b;
  node.productType = 0x0001;
  node.productId = 0x0469;
  node.getHighestSecurityClass = () => 2;
  node.emit('interview completed', node);
  const s = await lock.getState();
  assert.equal(s.model, 'Schlage BE469ZP Touchscreen Deadbolt');
  assert.equal(s.securityClass, 'S2 Access Control');
  await lock.shutdown();
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
