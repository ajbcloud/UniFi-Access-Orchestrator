'use strict';

// Guards the Settings > Alerts panel: the pure form helpers extracted from
// public/index.html, plus a drift check that the panel can reach every alert
// type the notifier can send.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { SEVERITY } = require('../src/notifier');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extractFn(name) {
  const start = html.indexOf('function ' + name);
  assert.ok(start >= 0, 'function not found: ' + name);
  let depth = 0;
  const open = html.indexOf('{', start);
  for (let j = open; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) return html.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}

function extractConst(name) {
  const start = html.indexOf('const ' + name);
  assert.ok(start >= 0, 'const not found: ' + name);
  const end = html.indexOf(';\n', start);
  return html.slice(start, end + 1);
}

const src = [
  extractConst('ALERT_TYPE_OPTIONS'),
  extractConst('ALERT_DEFAULT_LOW_BATTERY_PCT'),
  extractFn('escapeHtml'),
  extractFn('parseAlertRecipients'),
  extractFn('buildAlertTypeChecks'),
  extractFn('validateAlertsForm'),
  extractFn('buildAlertsConfigBody'),
  extractFn('lockLowBatteryPct'),
  extractFn('buildLowBatteryDevicesPatch'),
].join('\n');
const h = new Function(src + '; return { ALERT_TYPE_OPTIONS, parseAlertRecipients, buildAlertTypeChecks, validateAlertsForm, buildAlertsConfigBody, lockLowBatteryPct, buildLowBatteryDevicesPatch };')();

const goodForm = () => ({
  enabled: true, to: ['a@example.com'], host: 'smtp.example.com', port: '587', secure: false,
  user: 'alerts@example.com', password: 'pw', from: 'alerts@example.com', lowBatteryPct: '15',
  selectedTypes: h.ALERT_TYPE_OPTIONS.map((o) => o.type),
});

test('the panel lists exactly the alert types the notifier knows', () => {
  assert.deepEqual(h.ALERT_TYPE_OPTIONS.map((o) => o.type).sort(), Object.keys(SEVERITY).sort());
  for (const o of h.ALERT_TYPE_OPTIONS) assert.equal(o.severity, SEVERITY[o.type], o.type);
});

test('recipients split on commas, semicolons, and spaces', () => {
  assert.deepEqual(h.parseAlertRecipients('a@x.com, b@x.com;c@x.com  d@x.com,'), ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']);
  assert.deepEqual(h.parseAlertRecipients(''), []);
});

test('an empty stored allowlist shows every type ticked; a stored list ticks only those', () => {
  const all = h.buildAlertTypeChecks([]);
  assert.equal((all.match(/ checked>/g) || []).length, h.ALERT_TYPE_OPTIONS.length);
  const some = h.buildAlertTypeChecks(['deadbolt_low_battery']);
  assert.equal((some.match(/ checked>/g) || []).length, 1);
  assert.match(some, /value="deadbolt_low_battery" checked/);
});

test('validateAlertsForm accepts a complete form and an email-free one', () => {
  assert.equal(h.validateAlertsForm(goodForm()), null);
  assert.equal(h.validateAlertsForm({ enabled: true, to: [], host: '', from: '', port: '', selectedTypes: h.ALERT_TYPE_OPTIONS.map((o) => o.type) }), null);
});

test('validateAlertsForm names the first problem', () => {
  assert.match(h.validateAlertsForm(Object.assign(goodForm(), { host: '' })), /SMTP host/);
  assert.match(h.validateAlertsForm(Object.assign(goodForm(), { from: '' })), /from address/);
  assert.match(h.validateAlertsForm(Object.assign(goodForm(), { to: [] })), /at least one address/);
  assert.match(h.validateAlertsForm(Object.assign(goodForm(), { to: ['a@example.com', 'oops'] })), /oops/);
  assert.match(h.validateAlertsForm(Object.assign(goodForm(), { port: '99999' })), /port/);
  assert.match(h.validateAlertsForm(Object.assign(goodForm(), { lowBatteryPct: '0' })), /low battery/);
  assert.match(h.validateAlertsForm(Object.assign(goodForm(), { lowBatteryPct: '12.5' })), /low battery/);
});

test('unticking every alert type is refused (an empty list would mean send all)', () => {
  assert.match(h.validateAlertsForm(Object.assign(goodForm(), { selectedTypes: [] })), /at least one alert type/);
});

test('buildAlertsConfigBody shapes the PUT body and keeps a blank password out', () => {
  const body = h.buildAlertsConfigBody(Object.assign(goodForm(), { password: '', to: ['a@example.com', 'b@example.com'] }));
  assert.equal(body.enabled, true);
  assert.deepEqual(body.email.to, ['a@example.com', 'b@example.com']);
  assert.equal(body.email.smtp_host, 'smtp.example.com');
  assert.equal(body.email.smtp_port, 587);
  assert.equal('smtp_password' in body.email, false);
  assert.deepEqual(body.on, []); // everything ticked = send all
  assert.equal(h.buildAlertsConfigBody(goodForm()).email.smtp_password, 'pw');
});

test('buildAlertsConfigBody stores an explicit allowlist when only some types are ticked', () => {
  const body = h.buildAlertsConfigBody(Object.assign(goodForm(), { selectedTypes: ['deadbolt_low_battery'] }));
  assert.deepEqual(body.on, ['deadbolt_low_battery']);
});

test('the low battery level is read from the first lock and written to every lock', () => {
  const cfg = { devices: { zwave: { locks: { front_door: { node_id: 18, low_battery_pct: 20 }, back_door: { node_id: 19 } } } } };
  assert.equal(h.lockLowBatteryPct(cfg), 20);
  assert.equal(h.lockLowBatteryPct({}), 25);
  assert.deepEqual(h.buildLowBatteryDevicesPatch(cfg, 15), { zwave: { locks: { front_door: { low_battery_pct: 15 }, back_door: { low_battery_pct: 15 } } } });
  assert.equal(h.buildLowBatteryDevicesPatch({}, 15), null);
});
