'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  redactSecrets,
  stripRedactedPlaceholders,
  validateConfigUpdates,
  ReplayGuard,
  REDACTION_MARKER,
} = require('../src/security');

// ---------------------------------------------------------------------------
// redactSecrets
// ---------------------------------------------------------------------------

test('redactSecrets masks every secret-keyed field but leaves the rest', () => {
  const cfg = {
    server: { port: 3000, admin_api_key: 'abc123' },
    unifi: { host: '10.0.0.5', token: 'unifi-tok' },
    event_source: { mode: 'api_webhook', api_webhook: { secret: 'wh-secret' } },
    auto_lock: { shared_token: 'phone-tok', buttons: [{ id: 'a' }] },
    alerts: { webhook_url: 'http://x', signing_secret: 'sig' },
  };
  const out = redactSecrets(cfg);
  assert.strictEqual(out.server.admin_api_key, REDACTION_MARKER);
  assert.strictEqual(out.unifi.token, REDACTION_MARKER);
  assert.strictEqual(out.event_source.api_webhook.secret, REDACTION_MARKER);
  assert.strictEqual(out.auto_lock.shared_token, REDACTION_MARKER);
  assert.strictEqual(out.alerts.signing_secret, REDACTION_MARKER);
  // non-secret fields untouched
  assert.strictEqual(out.server.port, 3000);
  assert.strictEqual(out.unifi.host, '10.0.0.5');
  assert.strictEqual(out.alerts.webhook_url, 'http://x');
  assert.deepStrictEqual(out.auto_lock.buttons, [{ id: 'a' }]);
});

test('redactSecrets does not mutate the source and leaves empty secrets as-is', () => {
  const cfg = { unifi: { token: '' }, server: { admin_api_key: 'k' } };
  const out = redactSecrets(cfg);
  assert.strictEqual(out.unifi.token, ''); // unset stays visible as empty
  assert.strictEqual(out.server.admin_api_key, REDACTION_MARKER);
  assert.strictEqual(cfg.server.admin_api_key, 'k'); // source unchanged
});

// ---------------------------------------------------------------------------
// stripRedactedPlaceholders
// ---------------------------------------------------------------------------

test('stripRedactedPlaceholders drops only placeholder secrets, keeps real edits', () => {
  const updates = {
    unifi: { host: '10.0.0.9', token: REDACTION_MARKER },
    server: { admin_api_key: REDACTION_MARKER },
    event_source: { api_webhook: { secret: 'a-real-new-secret' } },
  };
  stripRedactedPlaceholders(updates);
  assert.strictEqual('token' in updates.unifi, false); // placeholder dropped
  assert.strictEqual('admin_api_key' in updates.server, false);
  assert.strictEqual(updates.unifi.host, '10.0.0.9'); // real edit kept
  assert.strictEqual(updates.event_source.api_webhook.secret, 'a-real-new-secret');
});

test('a redacted GET round-tripped through PUT cannot clobber a stored secret', () => {
  const stored = { unifi: { host: 'h', token: 'REAL' } };
  const fromUi = redactSecrets(stored);           // what GET returns
  stripRedactedPlaceholders(fromUi);              // what PUT strips
  assert.strictEqual('token' in fromUi.unifi, false);
});

// ---------------------------------------------------------------------------
// validateConfigUpdates
// ---------------------------------------------------------------------------

test('validateConfigUpdates accepts well-formed updates', () => {
  const ok = validateConfigUpdates({
    server: { port: 3000, host: '0.0.0.0' },
    unifi: { host: '10.0.0.5', port: 12445 },
    event_source: { mode: 'websocket' },
    unlock_rules: { rules: [] },
    doorbell_rules: { rules: [] },
    doors: {},
    resolver: { unifi_group_to_group: {} },
    auto_lock: { buttons: [] },
  });
  assert.strictEqual(ok.ok, true);
});

test('validateConfigUpdates rejects bad port, mode, and non-array rules', () => {
  assert.strictEqual(validateConfigUpdates({ server: { port: 0 } }).ok, false);
  assert.strictEqual(validateConfigUpdates({ server: { port: 70000 } }).ok, false);
  assert.strictEqual(validateConfigUpdates({ server: { port: 'nope' } }).ok, false);
  assert.strictEqual(validateConfigUpdates({ event_source: { mode: 'carrier-pigeon' } }).ok, false);
  assert.strictEqual(validateConfigUpdates({ unlock_rules: { rules: 'not-array' } }).ok, false);
  assert.strictEqual(validateConfigUpdates({ doors: [] }).ok, false);
  assert.strictEqual(validateConfigUpdates({ auto_lock: { buttons: {} } }).ok, false);
  assert.strictEqual(validateConfigUpdates(null).ok, false);
  assert.strictEqual(validateConfigUpdates('string').ok, false);
});

test('validateConfigUpdates allows an empty object and unknown-but-safe keys', () => {
  assert.strictEqual(validateConfigUpdates({}).ok, true);
  assert.strictEqual(validateConfigUpdates({ logging: { level: 'debug' } }).ok, true);
});

test('Z-Wave security keys redact fully and survive a PUT round trip', () => {
  const cfg = {
    devices: { zwave: { serial_path: 'COM3', security_keys: {
      s2_access_control: 'aa'.repeat(16), s2_authenticated: 'bb'.repeat(16),
      s2_unauthenticated: 'cc'.repeat(16), s0_legacy: 'dd'.repeat(16),
    } } },
  };
  const out = redactSecrets(cfg);
  for (const v of Object.values(out.devices.zwave.security_keys)) {
    assert.strictEqual(v, REDACTION_MARKER); // s0_legacy included (regex covers s0_)
  }
  assert.strictEqual(out.devices.zwave.serial_path, 'COM3');
  // the UI echoing the redacted GET back cannot clobber the stored keys
  stripRedactedPlaceholders(out);
  assert.deepStrictEqual(out.devices.zwave.security_keys, {});
});

test('validateConfigUpdates checks security_keys shape', () => {
  assert.strictEqual(validateConfigUpdates({ devices: { zwave: { security_keys: {} } } }).ok, true);
  assert.strictEqual(validateConfigUpdates({ devices: { zwave: { security_keys: { s0_legacy: 'aa'.repeat(16) } } } }).ok, true);
  assert.strictEqual(validateConfigUpdates({ devices: { zwave: { security_keys: [] } } }).ok, false);
  assert.strictEqual(validateConfigUpdates({ devices: { zwave: { security_keys: { s0_legacy: 42 } } } }).ok, false);
});

test('validateConfigUpdates checks the devices.zwave shape', () => {
  assert.strictEqual(validateConfigUpdates({
    devices: { zwave: { enabled: true, serial_path: 'COM3', locks: { front_deadbolt: { node_id: 2 } } } },
  }).ok, true);
  assert.strictEqual(validateConfigUpdates({ devices: [] }).ok, false);
  assert.strictEqual(validateConfigUpdates({ devices: { zwave: 'nope' } }).ok, false);
  assert.strictEqual(validateConfigUpdates({ devices: { zwave: { enabled: 'yes' } } }).ok, false);
  assert.strictEqual(validateConfigUpdates({ devices: { zwave: { serial_path: 3 } } }).ok, false);
  assert.strictEqual(validateConfigUpdates({ devices: { zwave: { locks: [] } } }).ok, false);
});

// ---------------------------------------------------------------------------
// ReplayGuard
// ---------------------------------------------------------------------------

test('ReplayGuard flags an identical body within the window and forgets it after', () => {
  let clock = 1000;
  const guard = new ReplayGuard({ windowMs: 5000, now: () => clock });

  assert.strictEqual(guard.isReplay('body-A'), false); // first time: not a replay
  assert.strictEqual(guard.isReplay('body-A'), true);  // immediate repeat: replay
  assert.strictEqual(guard.isReplay('body-B'), false); // different body: fine

  clock += 6000; // move past the window
  assert.strictEqual(guard.isReplay('body-A'), false); // expired, seen as new again
});

test('ReplayGuard evicts down to max and treats empty/undefined bodies consistently', () => {
  let clock = 0;
  const guard = new ReplayGuard({ windowMs: 100000, max: 3, now: () => clock });
  for (let i = 0; i < 10; i++) { clock += 1; guard.isReplay(`b${i}`); }
  assert.ok(guard.seen.size <= 3, `expected <=3 retained, got ${guard.seen.size}`);

  const g2 = new ReplayGuard({ windowMs: 1000, now: () => 42 });
  assert.strictEqual(g2.isReplay(''), false);
  assert.strictEqual(g2.isReplay(''), true);
  assert.strictEqual(g2.isReplay(undefined), true); // hashes the same as ''
});
