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

test('a total delivery failure does NOT suppress the next identical alert', async () => {
  // The de-dupe window must not be opened by a send that all channels failed:
  // otherwise a lockout alert is both lost AND the retry is silenced.
  const clock = { t: 0 };
  let attempts = 0;
  const n = new Notifier(
    { enabled: true, webhook_url: 'http://x/hook', min_interval_seconds: 60 },
    { logger: { warn() {} }, now: () => clock.t, sender: async () => { attempts++; throw new Error('down'); } }
  );
  n.notify({ type: 'deadbolt_retract_failed' });
  await flush();
  clock.t = 30000; // within the 60s window, but the first send FAILED
  n.notify({ type: 'deadbolt_retract_failed' });
  await flush();
  assert.equal(attempts, 2, 'the second alert is retried, not de-duped away');
  assert.equal(n.getStatus().stats.suppressed, 0);
  assert.equal(n.getStatus().stats.failed, 2);
});

test('a successful send still de-dupes a rapid repeat', async () => {
  // Guard the other direction: the rollback must not defeat normal de-dupe.
  const clock = { t: 0 };
  const { n, calls } = makeNotifier({ min_interval_seconds: 60 }, clock);
  n.notify({ type: 'jam' });
  await flush();
  clock.t = 30000;
  n.notify({ type: 'jam' });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(n.getStatus().stats.suppressed, 1);
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

// ---------------------------------------------------------------------------
// sendTestEmail: the Settings "Send Test Email" button
// ---------------------------------------------------------------------------

const GOOD_EMAIL = {
  smtp_host: 'smtp.example.com', smtp_port: 587, smtp_secure: false,
  smtp_user: 'alerts@example.com', smtp_password: 'pw',
  from: 'alerts@example.com', to: ['a@example.com', 'b@example.com'],
};

test('sendTestEmail sends one message to every recipient and reports ok', async () => {
  const sent = [];
  const r = await Notifier.sendTestEmail(GOOD_EMAIL, { mailer: { sendMail: async (m) => { sent.push(m); } } });
  assert.deepEqual(r, { ok: true, to: ['a@example.com', 'b@example.com'] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'a@example.com, b@example.com');
  assert.equal(sent[0].from, 'alerts@example.com');
  assert.match(sent[0].subject, /test/i);
});

test('sendTestEmail refuses incomplete settings without touching the network', async () => {
  let called = false;
  const mailer = { sendMail: async () => { called = true; } };
  for (const bad of [{}, Object.assign({}, GOOD_EMAIL, { smtp_host: '' }), Object.assign({}, GOOD_EMAIL, { from: '' }), Object.assign({}, GOOD_EMAIL, { to: [] })]) {
    const r = await Notifier.sendTestEmail(bad, { mailer });
    assert.equal(r.ok, false);
    assert.match(r.error, /SMTP host|recipient/i);
  }
  assert.equal(called, false);
});

test('sendTestEmail returns the SMTP error instead of throwing', async () => {
  const r = await Notifier.sendTestEmail(GOOD_EMAIL, { mailer: { sendMail: async () => { throw new Error('Invalid login: 535 5.7.3 Authentication unsuccessful'); } } });
  assert.equal(r.ok, false);
  assert.match(r.error, /535/);
});

test('sendTestEmail ignores the master switch and the de-dupe window', async () => {
  // A real notifier that is disabled and has a long de-dupe window must not
  // matter: the test is a deliberate operator action.
  const sent = [];
  const mailer = { sendMail: async (m) => { sent.push(m); } };
  await Notifier.sendTestEmail(GOOD_EMAIL, { mailer });
  await Notifier.sendTestEmail(GOOD_EMAIL, { mailer });
  assert.equal(sent.length, 2);
});

test('normalizeEmail needs host, from, and a recipient', () => {
  assert.equal(Notifier.normalizeEmail(undefined), null);
  assert.equal(Notifier.normalizeEmail(Object.assign({}, GOOD_EMAIL, { to: [] })), null);
  const ok = Notifier.normalizeEmail(Object.assign({}, GOOD_EMAIL, { smtp_port: 0 }));
  assert.equal(ok.port, 587);
  assert.equal(ok.secure, false);
});

test('a low battery alert reaches the email channel through notify()', async () => {
  const sent = [];
  const n = new Notifier(
    { enabled: true, email: GOOD_EMAIL, on: ['deadbolt_low_battery'] },
    { logger: { warn() {} }, mailer: { sendMail: async (m) => { sent.push(m); } } }
  );
  n.notify({ type: 'deadbolt_low_battery', detail: 'lock battery at 15% (threshold 15%); replace the batteries soon' });
  n.notify({ type: 'deadbolt_lock_online' }); // not on the allowlist
  await flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /deadbolt_low_battery/);
  assert.match(sent[0].text, /15%/);
});
