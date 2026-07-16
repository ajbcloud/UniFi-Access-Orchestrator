'use strict';

const test = require('node:test');
const assert = require('node:assert');

const DeadboltController = require('../src/deadbolt-controller');
const FakeLock = require('../src/drivers/fake-lock');
const { LockState } = require('../src/drivers/lock-driver');

// ---- fixtures (shapes grounded in the captured research) ------------------

function entryGrant(door, opts = {}) {
  const { actor = 'Raphael', provider = 'NFC', result = 'ACCESS', direction, doorId = 'door-1' } = opts;
  const target = [];
  if (direction) target.push({ type: 'device_config', id: 'door_entry_method', display_name: direction });
  target.push({ type: 'door', id: doorId, display_name: door });
  return {
    event: 'access.logs.add',
    data: {
      _source: {
        target,
        actor: { display_name: actor },
        event: { type: 'access.door.unlock', result },
        authentication: { credential_provider: provider },
      },
    },
  };
}

function locationUpdate(door, lock) {
  return {
    event: 'access.data.v2.location.update',
    data: { id: 'loc-1', location_type: 'door', name: door, state: { lock } },
  };
}

function makeUnifi() {
  const calls = [];
  return {
    calls,
    async unlockDoorByName(name, reason) {
      calls.push({ name, reason });
      return { success: true, door: name };
    },
  };
}

function makeController(overrides = {}) {
  const lock = new FakeLock({ initial: overrides.initial || LockState.LOCKED });
  const unifi = makeUnifi();
  const alerts = [];
  let clock = { t: 0 };
  const ctl = new DeadboltController(
    {
      deadbolt_rules: Object.assign(
        { trigger_door: 'Front Door', require_result: 'ACCESS' },
        overrides.deadbolt_rules
      ),
      cascade_rules: overrides.cascade_rules || {
        rules: [{ trigger_door: 'Front Door', unlock: ['Interior Door'], debounce_seconds: 8 }],
      },
    },
    {
      lockDriver: lock,
      unifiClient: unifi,
      onAlert: (a) => alerts.push(a),
      now: () => clock.t,
      logger: { debug() {} },
    }
  );
  return { ctl, lock, unifi, alerts, clock };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

// ---- tests ----------------------------------------------------------------

test('entry at front door retracts the deadbolt and fires the cascade', async () => {
  const { ctl, lock, unifi } = makeController();
  await lock.init();
  ctl.observe(entryGrant('Front Door'));
  await flush();
  assert.equal(lock._state, LockState.UNLOCKED, 'deadbolt retracted');
  assert.equal(lock.calls.filter((c) => c.action === 'unlock').length, 1);
  assert.equal(unifi.calls.length, 1);
  assert.equal(unifi.calls[0].name, 'Interior Door');
});

test('a denied (BLOCKED) event does nothing', async () => {
  const { ctl, lock, unifi } = makeController();
  await lock.init();
  ctl.observe(entryGrant('Front Door', { result: 'BLOCKED' }));
  await flush();
  assert.equal(lock.calls.length, 0);
  assert.equal(unifi.calls.length, 0);
});

test('an event at a different door does nothing', async () => {
  const { ctl, lock, unifi } = makeController();
  await lock.init();
  ctl.observe(entryGrant('Back Door'));
  await flush();
  assert.equal(lock.calls.length, 0);
  assert.equal(unifi.calls.length, 0);
});

test('matches the trigger door by id even when the door was renamed', async () => {
  // The rule stored id door-1 with the old display name; the door is now
  // "Front Door" in UniFi. Name match would miss; the id keeps it working.
  const { ctl, lock } = makeController({
    deadbolt_rules: { trigger_door: 'Old Name', trigger_door_id: 'door-1' },
    cascade_rules: { rules: [] },
  });
  await lock.init();
  ctl.observe(entryGrant('Front Door', { doorId: 'door-1' }));
  await flush();
  assert.ok(lock.calls.some((c) => c.action === 'unlock'), 'the id match retracts the deadbolt after a rename');
});

test('falls back to the name match when the rule carries no door id', async () => {
  // No trigger_door_id on the rule, and the event id differs; the name still
  // matches, so behavior is unchanged from before id keying.
  const { ctl, lock } = makeController({
    deadbolt_rules: { trigger_door: 'Front Door' },
    cascade_rules: { rules: [] },
  });
  await lock.init();
  ctl.observe(entryGrant('Front Door', { doorId: 'some-other-id' }));
  await flush();
  assert.ok(lock.calls.some((c) => c.action === 'unlock'), 'name match still fires without an id');
});

test('self-triggered events are ignored (orchestrator actor and remote unlock)', async () => {
  const { ctl, lock, unifi } = makeController();
  await lock.init();
  ctl.observe(entryGrant('Front Door', { actor: 'Access Orchestrator' }));
  ctl.observe(entryGrant('Front Door', { provider: 'REMOTE_THROUGH_UAH' }));
  await flush();
  assert.equal(lock.calls.length, 0);
  assert.equal(unifi.calls.length, 0);
});

test('an exit-direction grant does not retract or cascade', async () => {
  const { ctl, lock, unifi } = makeController();
  await lock.init();
  ctl.observe(entryGrant('Front Door', { direction: 'exit' }));
  await flush();
  assert.equal(lock.calls.length, 0);
  assert.equal(unifi.calls.length, 0);
});

test('cascade is debounced then fires again after the window', async () => {
  const { ctl, unifi, clock } = makeController();
  clock.t = 0;
  ctl.observe(entryGrant('Front Door'));
  clock.t = 5000; // within 8s window
  ctl.observe(entryGrant('Front Door'));
  clock.t = 9000; // past the window
  ctl.observe(entryGrant('Front Door'));
  await flush();
  assert.equal(unifi.calls.length, 2, 'cascade fired twice, not three times');
});

test('front-door secured transition throws the deadbolt', async () => {
  const { ctl, lock } = makeController({ initial: LockState.UNLOCKED });
  await lock.init();
  ctl.observe(locationUpdate('Front Door', 'unlocked')); // seed prior state
  await flush();
  ctl.observe(locationUpdate('Front Door', 'locked'));
  await flush();
  assert.equal(lock._state, LockState.LOCKED);
  assert.equal(lock.calls.filter((c) => c.action === 'lock').length, 1);
});

test('first telemetry does not fire (seeds state), only an observed transition acts', async () => {
  const { ctl, lock } = makeController({ initial: LockState.UNLOCKED });
  await lock.init();
  ctl.observe(locationUpdate('Front Door', 'locked')); // first observation: seed only
  await flush();
  assert.equal(lock.calls.filter((c) => c.action === 'lock').length, 0);
});

test('a repeated locked state does not re-lock', async () => {
  const { ctl, lock } = makeController({ initial: LockState.UNLOCKED });
  await lock.init();
  ctl.observe(locationUpdate('Front Door', 'unlocked')); // seed
  await flush();
  ctl.observe(locationUpdate('Front Door', 'locked')); // transition -> fires
  await flush();
  ctl.observe(locationUpdate('Front Door', 'locked')); // no re-lock
  await flush();
  assert.equal(lock.calls.filter((c) => c.action === 'lock').length, 1);
});

test('lock-on-secured is suppressed within the re-lock cooldown after a retract', async () => {
  const { ctl, lock, clock } = makeController();
  await lock.init();
  clock.t = 1000;
  ctl.observe(entryGrant('Front Door')); // retract, starts the cooldown at t=1000
  await flush();
  ctl.observe(locationUpdate('Front Door', 'unlocked')); // seed prior state
  await flush();
  clock.t = 3000; // 2s later, within the default 10s cooldown
  ctl.observe(locationUpdate('Front Door', 'locked'));
  await flush();
  assert.equal(lock.calls.filter((c) => c.action === 'lock').length, 0, 'no re-lock within cooldown');
});

test('two cascade rules on the same trigger door both fire on one entry', async () => {
  const { ctl, unifi } = makeController({ cascade_rules: { rules: [
    { trigger_door: 'Front Door', unlock: ['Interior Door'], debounce_seconds: 8 },
    { trigger_door: 'Front Door', unlock: ['Garage Door'], debounce_seconds: 8 },
  ] } });
  ctl.observe(entryGrant('Front Door'));
  await flush();
  assert.deepEqual(unifi.calls.map((c) => c.name).sort(), ['Garage Door', 'Interior Door']);
});

test('mirror_unlock retracts on an unsecured transition when enabled', async () => {
  const { ctl, lock } = makeController({
    initial: LockState.LOCKED,
    deadbolt_rules: { trigger_door: 'Front Door', require_result: 'ACCESS', mirror_unlock: true },
  });
  await lock.init();
  // seed last state to locked, then transition to unlocked
  ctl.observe(locationUpdate('Front Door', 'locked'));
  await flush();
  ctl.observe(locationUpdate('Front Door', 'unlocked'));
  await flush();
  assert.equal(lock._state, LockState.UNLOCKED);
  assert.ok(lock.calls.some((c) => c.action === 'unlock'));
});

test('a failed retract raises a high-severity alert', async () => {
  const { ctl, lock, alerts } = makeController();
  await lock.init();
  lock.behavior.failNext = true;
  ctl.observe(entryGrant('Front Door'));
  await flush();
  assert.ok(alerts.some((a) => a.type === 'deadbolt_retract_failed'));
});

test('getStatus reports stats and lock snapshot', async () => {
  const { ctl, lock } = makeController();
  await lock.init();
  ctl.observe(entryGrant('Front Door'));
  await flush();
  const s = ctl.getStatus();
  assert.equal(s.enabled, true);
  assert.equal(s.trigger_door, 'Front Door');
  assert.equal(s.stats.retracts, 1);
  assert.ok(s.lock);
});

// ---------------------------------------------------------------------------
// Multi-lock isolation: one controller per automated lock, fed the SAME raw
// event stream (exactly how index.js taps events), must never cross-talk.
// ---------------------------------------------------------------------------

function makeIsolated(triggerDoor) {
  const lock = new FakeLock({ initial: LockState.LOCKED });
  const ctl = new DeadboltController(
    {
      deadbolt_rules: { trigger_door: triggerDoor, require_result: 'ACCESS' },
      cascade_rules: { rules: [] }, // per-lock controllers carry NO cascades
      self_trigger_actor_name: 'Access Orchestrator',
    },
    { lockDriver: lock, unifiClient: makeUnifi(), logger: { debug() {}, info() {}, warn() {} }, onAlert() {} }
  );
  return { lock, ctl };
}

test('two controllers on two doors: an entry retracts only the matching lock', async () => {
  const front = makeIsolated('Front Door');
  const side = makeIsolated('Side Door');
  const feed = (raw) => { front.ctl.observe(raw); side.ctl.observe(raw); };

  feed(entryGrant('Front Door'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(front.lock.calls.map((c) => c.action), ['unlock'], 'front lock retracted');
  assert.deepEqual(side.lock.calls, [], 'side lock untouched by the front entry');

  feed(entryGrant('Side Door'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(side.lock.calls.map((c) => c.action), ['unlock'], 'side lock retracted for its own door');
  assert.equal(front.lock.calls.length, 1, 'front lock saw no second command');
});

test('two controllers on two doors: a secured transition locks only the matching lock', async () => {
  const front = makeIsolated('Front Door');
  const side = makeIsolated('Side Door');
  const feed = (raw) => { front.ctl.observe(raw); side.ctl.observe(raw); };

  // Seed both doors' lock state (first telemetry never fires an action).
  feed(locationUpdate('Front Door', 'unlocked'));
  feed(locationUpdate('Side Door', 'unlocked'));
  // Only the SIDE door secures.
  feed(locationUpdate('Side Door', 'locked'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(side.lock.calls.map((c) => c.action), ['lock'], 'side lock thrown on its own secured transition');
  assert.deepEqual(front.lock.calls, [], 'front lock untouched');
});

test('a dedicated cascade controller fires cascades exactly once alongside per-lock controllers', async () => {
  const front = makeIsolated('Front Door');
  const side = makeIsolated('Side Door');
  const unifi = makeUnifi();
  const cascadeCtl = new DeadboltController(
    {
      cascade_rules: { rules: [{ trigger_door: 'Front Door', unlock: ['Interior Door'], debounce_seconds: 8 }] },
      self_trigger_actor_name: 'Access Orchestrator',
    },
    { lockDriver: null, unifiClient: unifi, logger: { debug() {}, info() {}, warn() {} }, onAlert() {} }
  );
  const observers = [front.ctl, side.ctl, cascadeCtl];
  const feed = (raw) => observers.forEach((c) => c.observe(raw));

  feed(entryGrant('Front Door'));
  await new Promise((r) => setImmediate(r));
  assert.equal(unifi.calls.length, 1, 'cascade fired exactly once');
  assert.equal(unifi.calls[0].name, 'Interior Door');
  assert.equal(front.lock.calls.length, 1, 'front lock still retracted');
  assert.deepEqual(side.lock.calls, [], 'side lock untouched');
});

// ---------------------------------------------------------------------------
// Door-centric edge mode: config.edges from door_flows (edgesForLock shape).
// Per-edge after-unlock orchestration, multi-door matching, destroy lifecycle.
// ---------------------------------------------------------------------------

function makeEdgeController(edges, opts = {}) {
  const lock = new FakeLock({ initial: opts.initial || LockState.LOCKED });
  const unifi = makeUnifi();
  const alerts = [];
  let clock = { t: 0 };
  const ctl = new DeadboltController(
    { edges, cascade_rules: opts.cascade_rules || { rules: [] } },
    {
      lockDriver: lock,
      unifiClient: unifi,
      onAlert: (a) => alerts.push(a),
      now: () => clock.t,
      logger: { debug() {} },
    }
  );
  return { ctl, lock, unifi, alerts, clock };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('edge mode: one edge behaves like the legacy single block', async () => {
  const { ctl, lock } = makeEdgeController([
    { trigger_door: 'Front Door', after_unlock: 'lock_default', require_result: 'ACCESS' },
  ]);
  await lock.init();
  ctl.observe(entryGrant('Front Door'));
  await flush();
  assert.equal(lock._state, LockState.UNLOCKED, 'retracted');
  ctl.observe(entryGrant('Back Door'));
  await flush();
  assert.equal(lock.calls.filter((c) => c.action === 'unlock').length, 1, 'other doors ignored');
  assert.deepEqual(ctl.getStatus().trigger_doors, ['Front Door']);
});

test('edge mode: lock_default and stay_unlocked schedule NO app relock', async () => {
  for (const mode of ['lock_default', 'stay_unlocked']) {
    const { ctl, lock } = makeEdgeController([
      { trigger_door: 'Front Door', after_unlock: mode, relock_seconds: 0.03 },
    ]);
    await lock.init();
    ctl.observe(entryGrant('Front Door'));
    await flush();
    assert.equal(ctl.getStatus().relock_pending, false, `${mode}: nothing pending`);
    await wait(60);
    assert.equal(lock.calls.filter((c) => c.action === 'lock').length, 0, `${mode}: no app lock ever fires`);
    ctl.destroy();
  }
});

test('edge mode: relock_after fires ONE lock command after N seconds', async () => {
  const { ctl, lock } = makeEdgeController([
    { trigger_door: 'Front Door', after_unlock: 'relock_after', relock_seconds: 0.05 },
  ]);
  await lock.init();
  ctl.observe(entryGrant('Front Door'));
  await flush();
  assert.equal(ctl.getStatus().relock_pending, true, 'timer armed');
  assert.equal(lock._state, LockState.UNLOCKED);
  await wait(90);
  assert.equal(lock.calls.filter((c) => c.action === 'lock').length, 1, 'exactly one relock');
  assert.equal(lock._state, LockState.LOCKED);
  assert.equal(ctl.getStatus().relock_pending, false);
  ctl.destroy();
});

test('edge mode: a manual/hardware lock cancels the pending relock via state-change', async () => {
  const { ctl, lock } = makeEdgeController([
    { trigger_door: 'Front Door', after_unlock: 'relock_after', relock_seconds: 0.06 },
  ]);
  await lock.init();
  ctl.observe(entryGrant('Front Door'));
  await flush();
  assert.equal(ctl.getStatus().relock_pending, true);
  await lock.lock('manual thumbturn'); // emits state-change boltState locked
  assert.equal(ctl.getStatus().relock_pending, false, 'listener cancelled the timer, not the fire-time guard');
  const locksBefore = lock.calls.filter((c) => c.action === 'lock').length;
  await wait(100);
  assert.equal(lock.calls.filter((c) => c.action === 'lock').length, locksBefore, 'timer never fired');
  ctl.destroy();
});

test('edge mode: an observed door-secured transition cancels the pending relock', async () => {
  const { ctl, lock, clock } = makeEdgeController([
    { trigger_door: 'Front Door', after_unlock: 'relock_after', relock_seconds: 0.06, relock_cooldown_seconds: 10 },
  ]);
  await lock.init();
  clock.t = 1000; // a retract at t=0 would read as "never retracted" (falsy)
  ctl.observe(locationUpdate('Front Door', 'unlocked')); // seed
  ctl.observe(entryGrant('Front Door'));
  await flush();
  assert.equal(ctl.getStatus().relock_pending, true);
  ctl.observe(locationUpdate('Front Door', 'locked')); // secured within cooldown
  assert.equal(ctl.getStatus().relock_pending, false, 'pending relock cancelled on secured');
  await wait(100);
  assert.equal(lock.calls.filter((c) => c.action === 'lock').length, 0,
    'no app lock: timer cancelled AND secured-lock suppressed by the cooldown');
  ctl.destroy();
});

test('edge mode: LAST WRITER WINS when two doors retract the same lock', async () => {
  const { ctl, lock } = makeEdgeController([
    { trigger_door: 'Door A', after_unlock: 'relock_after', relock_seconds: 0.05 },
    { trigger_door: 'Door B', after_unlock: 'stay_unlocked' },
  ]);
  await lock.init();
  ctl.observe(entryGrant('Door A', { doorId: 'd-a' }));
  await flush();
  assert.equal(ctl.getStatus().relock_pending, true, 'Door A armed a relock');
  ctl.observe(entryGrant('Door B', { doorId: 'd-b' }));
  await flush();
  assert.equal(ctl.getStatus().relock_pending, false, 'Door B (stay_unlocked) cancelled it');
  await wait(90);
  assert.equal(lock.calls.filter((c) => c.action === 'lock').length, 0, 'no relock fired');
  // And the reverse order arms the newest edge's timer.
  ctl.observe(entryGrant('Door A', { doorId: 'd-a' }));
  await flush();
  assert.equal(ctl.getStatus().relock_pending, true, 'A after B re-arms');
  ctl.destroy();
});

test('edge mode: multi-door lock-on-secured tracks state PER DOOR', async () => {
  const { ctl, lock, clock } = makeEdgeController([
    { trigger_door: 'Door A', after_unlock: 'lock_default' },
    { trigger_door: 'Door B', after_unlock: 'lock_default' },
  ]);
  await lock.init();
  await lock.unlock('start retracted');
  // Seed only Door A; Door B's first telemetry must seed, not fire.
  ctl.observe(locationUpdate('Door A', 'unlocked'));
  ctl.observe(locationUpdate('Door B', 'locked'));
  await flush();
  assert.equal(lock.calls.filter((c) => c.action === 'lock').length, 0, 'first B telemetry only seeds');
  // A locked transition on Door A throws the lock (no retract happened; no cooldown).
  clock.t = 60000;
  ctl.observe(locationUpdate('Door A', 'locked'));
  await flush();
  assert.equal(lock.calls.filter((c) => c.action === 'lock').length, 1, 'Door A secured throws');
  // Door B: unlocked then locked -> a second throw, independent of A's state.
  await lock.unlock('again');
  ctl.observe(locationUpdate('Door B', 'unlocked'));
  ctl.observe(locationUpdate('Door B', 'locked'));
  await flush();
  assert.equal(lock.calls.filter((c) => c.action === 'lock').length, 2, 'Door B tracked separately');
  ctl.destroy();
});

test('edge mode: per-edge mirror_unlock and require_result', async () => {
  const { ctl, lock } = makeEdgeController([
    { trigger_door: 'Door A', mirror_unlock: true },
    { trigger_door: 'Door B', mirror_unlock: false },
  ]);
  await lock.init();
  ctl.observe(locationUpdate('Door A', 'locked'));
  ctl.observe(locationUpdate('Door B', 'locked'));
  ctl.observe(locationUpdate('Door A', 'unlocked'));
  await flush();
  assert.equal(lock.calls.filter((c) => c.action === 'unlock').length, 1, 'A mirrors unsecure');
  ctl.observe(locationUpdate('Door B', 'unlocked'));
  await flush();
  assert.equal(lock.calls.filter((c) => c.action === 'unlock').length, 1, 'B does not mirror');
  ctl.destroy();
});

test('edge mode: destroy() clears the timer and the driver listener', async () => {
  const { ctl, lock } = makeEdgeController([
    { trigger_door: 'Front Door', after_unlock: 'relock_after', relock_seconds: 0.05 },
  ]);
  await lock.init();
  const listenersBefore = lock.listenerCount('state-change');
  assert.ok(listenersBefore >= 1, 'controller subscribed to state-change');
  ctl.observe(entryGrant('Front Door'));
  await flush();
  assert.equal(ctl.getStatus().relock_pending, true);
  ctl.destroy();
  assert.equal(ctl.getStatus().relock_pending, false, 'timer cleared');
  assert.equal(lock.listenerCount('state-change'), listenersBefore - 1, 'listener removed');
  await wait(90);
  assert.equal(lock.calls.filter((c) => c.action === 'lock').length, 0, 'nothing fires after destroy');
});
