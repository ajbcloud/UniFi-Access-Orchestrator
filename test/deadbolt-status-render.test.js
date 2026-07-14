'use strict';

// Guards the deadbolt status readouts and the pairing-freeze fix in
// public/index.html:
//  - describeLockLink / describeLockBattery: an asleep battery lock must not
//    paint as a red "offline", and a low battery must be flagged.
//  - renderZwaveSetup: while a pairing session is live (_pairPollTimer set),
//    the function must NOT rewrite #configZwave. A background
//    system.auto_reload used to call loadConfig() -> renderZwaveSetup() and
//    destroy the focused PIN input mid-typing (field report: "it froze").
// Extracts the REAL functions from public/index.html via the shared
// extractFn harness.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

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

function loadDescriptors() {
  const src = extractFn('describeLockLink') + ';' + extractFn('describeLockBattery');
  return new Function(src + '; return { describeLockLink, describeLockBattery };')();
}

test('describeLockLink: online/asleep/offline and legacy-boolean fallback', () => {
  const { describeLockLink } = loadDescriptors();
  assert.equal(describeLockLink({ linkState: 'online' }).label, 'online');
  assert.equal(describeLockLink({ linkState: 'online' }).color, 'var(--green)');
  const asleep = describeLockLink({ linkState: 'asleep' });
  assert.match(asleep.label, /asleep/);
  assert.notEqual(asleep.color, 'var(--red)', 'asleep is normal, never red');
  assert.equal(describeLockLink({ linkState: 'offline' }).color, 'var(--red)');
  // snapshots that predate linkState fall back to the boolean
  assert.equal(describeLockLink({ online: true }).label, 'online');
  assert.equal(describeLockLink({ online: false }).label, 'offline');
  assert.equal(describeLockLink(null).label, 'offline');
});

test('describeLockBattery: n/a, normal, and low', () => {
  const { describeLockBattery } = loadDescriptors();
  assert.equal(describeLockBattery({}).label, 'n/a');
  assert.equal(describeLockBattery({ battery: 88 }).label, '88%');
  const low = describeLockBattery({ battery: 12, batteryLow: true });
  assert.equal(low.label, '12% (low)');
  assert.equal(low.color, 'var(--red)');
});

function loadIdentityHelpers() {
  const src = extractFn('describeLockModel') + ';' + extractFn('describeLockSecurity')
    + ';' + extractFn('describeLockBolt');
  return new Function(src + '; return { describeLockModel, describeLockSecurity, describeLockBolt };')();
}

test('describeLockModel: name first, model second, never a bare unknown', () => {
  const { describeLockModel } = loadIdentityHelpers();
  assert.equal(describeLockModel({ name: 'Front Door', model: 'Yale Assure Deadbolt (ZW2)' }),
    'Front Door (Yale Assure Deadbolt (ZW2))');
  assert.equal(describeLockModel({ model: 'Schlage BE469ZP Touchscreen Deadbolt' }),
    'Schlage BE469ZP Touchscreen Deadbolt');
  assert.equal(describeLockModel({ name: 'Bench Lock' }), 'Bench Lock');
  assert.equal(describeLockModel({}), 'identifying...');
  assert.ok(!describeLockModel({}).includes('unknown'));
});

test('describeLockSecurity: snapshot and locks-route field names, pending floor', () => {
  const { describeLockSecurity } = loadIdentityHelpers();
  assert.equal(describeLockSecurity({ securityClass: 'S2 Access Control' }), 'S2 Access Control');
  assert.equal(describeLockSecurity({ security_class: 'S0 Legacy' }), 'S0 Legacy');
  assert.equal(describeLockSecurity({}), 'pending');
});

test('describeLockBolt: transient reading state while the link is up', () => {
  const { describeLockBolt } = loadIdentityHelpers();
  assert.equal(describeLockBolt({ boltState: 'locked' }), 'locked');
  assert.equal(describeLockBolt({ boltState: 'unknown', linkState: 'online' }), 'reading...');
  assert.equal(describeLockBolt({ boltState: 'unknown', linkState: 'asleep' }), 'reading...');
  assert.equal(describeLockBolt({ boltState: 'unknown', linkState: 'offline' }), 'unknown');
  assert.equal(describeLockBolt({ bolt: 'jammed', link_state: 'online' }), 'jammed');
});

function loadRenderZwaveSetup() {
  const src = extractFn('renderZwaveSetup');
  // Parameters stand in for the SPA globals the function touches.
  return new Function(
    '_pairPollTimer', 'document', 'configData', 'armDirtySave',
    src + '; return renderZwaveSetup;'
  );
}

test('renderZwaveSetup: leaves the DOM alone while a pairing session is live', () => {
  let touched = 0;
  const doc = { getElementById: () => { touched++; return null; } };
  loadRenderZwaveSetup()(123 /* timer running */, doc, {}, () => {})();
  assert.equal(touched, 0, 'must return before any DOM access while pairing');
});

test('renderZwaveSetup: renders normally when no pairing session is live', () => {
  const el = { innerHTML: '' };
  let armed = 0;
  const doc = { getElementById: (id) => (id === 'configZwave' ? el : null) };
  loadRenderZwaveSetup()(null, doc, { devices: { zwave: { enabled: true } } }, () => { armed++; })();
  assert.match(el.innerHTML, /zwavePairPanel/, 'panel container rendered');
  assert.match(el.innerHTML, /checked/, 'enabled checkbox reflects config');
  assert.equal(armed, 1, 'dirty-save armed after render');
});
