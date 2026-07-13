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
