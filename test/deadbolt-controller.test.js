'use strict';

const test = require('node:test');
const assert = require('node:assert');

const DeadboltController = require('../src/deadbolt-controller');
const FakeLock = require('../src/drivers/fake-lock');
const { LockState } = require('../src/drivers/lock-driver');

// ---- fixtures (shapes grounded in the captured research) ------------------

function entryGrant(door, opts = {}) {
  const { actor = 'Raphael', provider = 'NFC', result = 'ACCESS', direction } = opts;
  const target = [];
  if (direction) target.push({ type: 'device_config', id: 'door_entry_method', display_name: direction });
  target.push({ type: 'door', id: 'door-1', display_name: door });
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
