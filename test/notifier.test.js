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

// ---------------------------------------------------------------------------
// Multi-channel: webhook + chat (Slack/Teams) + email, any subset, one
// de-dupe decision shared by all channels, severity in every payload.
// ---------------------------------------------------------------------------

test('every payload carries a plain-language severity', async () => {
  const { n, calls } = makeNotifier();
  n.notify({ type: 'deadbolt_retract_failed' });
  n.notify({ type: 'deadbolt_low_battery' });
  n.notify({ type: 'controller_reconnected' });
  await flush();
  assert.equal(calls[0].body.severity, 'critical');
  assert.equal(calls[1].body.severity, 'warning');
  assert.equal(calls[2].body.severity, 'info');
});

test('chat channel formats a Slack payload, not the raw alert shape', async () => {
  const { n, calls } = makeNotifier({
    webhook_url: '',
    chat: { type: 'slack', webhook_url: 'http://slack.local/hook' },
  });
  n.notify({ type: 'deadbolt_jammed', detail: 'bolt obstructed' });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://slack.local/hook');
  assert.ok(typeof calls[0].body.text === 'string', 'Slack wants { text }');
  assert.match(calls[0].body.text, /deadbolt_jammed/);
  assert.match(calls[0].body.text, /bolt obstructed/);
});

test('chat channel formats a Teams MessageCard when type is teams', async () => {
  const { n, calls } = makeNotifier({
    webhook_url: '',
    chat: { type: 'teams', webhook_url: 'http://teams.local/hook' },
  });
  n.notify({ type: 'deadbolt_lock_offline', detail: 'link down 60s' });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body['@type'], 'MessageCard');
  assert.match(calls[0].body.title, /deadbolt_lock_offline/);
  assert.match(calls[0].body.text, /link down 60s/);
});

test('email channel sends through the injected transport', async () => {
  const mails = [];
  const n = new Notifier(
    {
      enabled: true,
      email: { smtp_host: 'smtp.local', from: 'orc@site.local', to: ['ops@site.local'] },
    },
    { logger: { warn() {} }, mailer: { sendMail: async (m) => { mails.push(m); } } }
  );
  n.notify({ type: 'deadbolt_retract_failed', detail: 'no confirm' });
  await flush();
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'ops@site.local');
  assert.match(mails[0].subject, /critical/);
  assert.match(mails[0].subject, /deadbolt_retract_failed/);
  assert.match(mails[0].text, /no confirm/);
});

test('fan-out: one alert reaches every enabled channel, one de-dupe decision', async () => {
  const clock = { t: 0 };
  const mails = [];
  const calls = [];
  const n = new Notifier(
    {
      enabled: true,
      webhook_url: 'http://collector.local/hook',
      chat: { type: 'slack', webhook_url: 'http://slack.local/hook' },
      email: { smtp_host: 'smtp.local', from: 'orc@site.local', to: ['ops@site.local'] },
      min_interval_seconds: 60,
    },
    {
      logger: { warn() {} },
      now: () => clock.t,
      sender: async (url, body) => { calls.push({ url, body }); },
      mailer: { sendMail: async (m) => { mails.push(m); } },
    }
  );
  n.notify({ type: 'deadbolt_jammed' });
  clock.t = 30000;
  n.notify({ type: 'deadbolt_jammed' }); // suppressed for ALL channels
  await flush();
  assert.equal(calls.length, 2, 'webhook + slack');
  assert.equal(mails.length, 1, 'email');
  assert.equal(n.getStatus().stats.suppressed, 1);
  assert.equal(n.getStatus().stats.sent, 3);
});

test('a chat-only config still counts as enabled; a dead channel cannot silence others', async () => {
  const { n, calls } = makeNotifier({ webhook_url: '', chat: { type: 'slack', webhook_url: 'http://slack.local/hook' } });
  assert.equal(n.getStatus().enabled, true);
  assert.equal(n.getStatus().chat_configured, true);
  assert.equal(n.getStatus().url_configured, false);
  n.notify({ type: 'jam' });
  await flush();
  assert.equal(calls.length, 1);

  // webhook sender dies, email still delivers
  const mails = [];
  const n2 = new Notifier(
    {
      enabled: true,
      webhook_url: 'http://dead.local/hook',
      email: { smtp_host: 'smtp.local', from: 'a@b', to: ['c@d'] },
    },
    {
      logger: { warn() {} },
      sender: async () => { throw new Error('down'); },
      mailer: { sendMail: async (m) => { mails.push(m); } },
    }
  );
  n2.notify({ type: 'jam' });
  await flush();
  assert.equal(mails.length, 1);
  assert.equal(n2.getStatus().stats.failed, 1);
  assert.equal(n2.getStatus().stats.sent, 1);
});
