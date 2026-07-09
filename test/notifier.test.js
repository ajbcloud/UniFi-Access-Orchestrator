'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Notifier = require('../src/notifier');

function makeNotifier(cfg = {}, clock = { t: 0 }) {
  const calls = [];
  const n = new Notifier(
    Object.assign({ enabled: true, webhook_url: 'http://collector.local/hook' }, cfg),
    {
      logger: { warn() {} },
      now: () => clock.t,
      sender: async (url, body) => { calls.push({ url, body }); },
    }
  );
  return { n, calls, clock };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

test('sends an alert to the configured webhook', async () => {
  const { n, calls } = makeNotifier();
  n.notify({ type: 'deadbolt_retract_failed', reason: 'x' });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://collector.local/hook');
  assert.equal(calls[0].body.type, 'deadbolt_retract_failed');
  assert.equal(calls[0].body.source, 'unifi-access-orchestrator');
});

test('does nothing when disabled', async () => {
  const { n, calls } = makeNotifier({ enabled: false });
  n.notify({ type: 'deadbolt_retract_failed' });
  await flush();
  assert.equal(calls.length, 0);
});

test('does nothing when no webhook_url is set', async () => {
  const { n, calls } = makeNotifier({ webhook_url: '' });
  n.notify({ type: 'deadbolt_retract_failed' });
  await flush();
  assert.equal(calls.length, 0);
});

test('filters by the on[] allowlist', async () => {
  const { n, calls } = makeNotifier({ on: ['deadbolt_lock_failed'] });
  n.notify({ type: 'deadbolt_retract_failed' }); // not in list
  n.notify({ type: 'deadbolt_lock_failed' });    // in list
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.type, 'deadbolt_lock_failed');
});

test('de-dupes repeats of the same type within the window, then sends again after it', async () => {
  const clock = { t: 0 };
  const { n, calls } = makeNotifier({ min_interval_seconds: 60 }, clock);
  n.notify({ type: 'jam' });
  clock.t = 30000; // within 60s
  n.notify({ type: 'jam' });
  clock.t = 61000; // past the window
  n.notify({ type: 'jam' });
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(n.getStatus().stats.suppressed, 1);
});

test('a sender failure is counted, not thrown', async () => {
  const n = new Notifier(
    { enabled: true, webhook_url: 'http://x/hook' },
    { logger: { warn() {} }, sender: async () => { throw new Error('boom'); } }
  );
  n.notify({ type: 'jam' });
  await flush();
  assert.equal(n.getStatus().stats.failed, 1);
});
