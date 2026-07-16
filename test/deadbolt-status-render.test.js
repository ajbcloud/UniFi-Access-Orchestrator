'use strict';

// Guards the deadbolt status readouts and the pairing-freeze fix in
// public/index.html:
//  - describeLockLink / describeLockBattery: an asleep battery lock must not
//    paint as a red "offline", and a low battery must be flagged.
//  - renderDeadboltDevices: while a pairing session is live (_pairPollTimer
//    set), the function must NOT rewrite #configZwave. A background
//    system.auto_reload used to call loadConfig() -> the section renderer and
//    destroy the focused PIN input mid-typing (field report: "it froze").
//    The focus guard must skip for SELECT/INPUT/TEXTAREA but NEVER for
//    BUTTON (a focused Save button deferring its own repaint was the
//    vanishing-section bug), and a forced repaint must always land.
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

function loadRenderDevices() {
  // The REAL shared focus predicate compiles alongside the renderer, closing
  // over the same fake document, so the guard contract is tested end to end.
  const src = extractFn('sectionHoldsFocus') + ';' + extractFn('renderDeadboltDevices');
  // Parameters stand in for the SPA globals the function touches. The retry
  // gate stubs record skip/run so the focus-guard contract stays covered.
  return new Function(
    '_pairPollTimer', 'document', 'configData', 'armDirtySave', 'wireSectionFocusRetry',
    '_devicesGate', 'loadSerialPorts', 'refreshZwaveDeadbolt',
    src + '; return renderDeadboltDevices;'
  );
}
function gateStub() {
  return {
    skips: 0, runs: 0,
    skipped() { this.skips++; },
    ran() { this.runs++; },
    kick() {},
  };
}
function counters() {
  const c = { ports: 0, refresh: 0 };
  return { c, ports: () => { c.ports++; }, refresh: () => { c.refresh++; } };
}

test('renderDeadboltDevices: leaves the DOM alone while a pairing session is live', () => {
  let touched = 0;
  const doc = { getElementById: () => { touched++; return null; } };
  const { ports, refresh } = counters();
  loadRenderDevices()(123 /* timer running */, doc, {}, () => {}, () => {}, gateStub(), ports, refresh)();
  assert.equal(touched, 0, 'must return before any DOM access while pairing');
});

test('renderDeadboltDevices: renders the shell and refills its dynamic parts', () => {
  const el = { innerHTML: '' };
  let armed = 0;
  const gate = gateStub();
  const doc = { getElementById: (id) => (id === 'configZwave' ? el : null) };
  const { c, ports, refresh } = counters();
  loadRenderDevices()(null, doc, { devices: { zwave: { enabled: true } } }, () => { armed++; }, () => {}, gate, ports, refresh)();
  assert.match(el.innerHTML, /zwavePairPanel/, 'panel container rendered');
  assert.match(el.innerHTML, /checked/, 'enabled checkbox reflects config');
  assert.ok(!el.innerHTML.includes('zwaveKeypadUsers'), 'keypad users live on their own tab now');
  assert.ok(!el.innerHTML.includes('zwaveRulesBlock'), 'the vanishing automation block is gone; Door Flows owns that editor');
  assert.equal(armed, 1, 'dirty-save armed after render');
  assert.equal(gate.runs, 1, 'gate told the repaint ran');
  assert.equal(c.ports, 1, 'serial ports reloaded with the shell');
  assert.equal(c.refresh, 1, 'dynamic fill runs after every shell rebuild, including retries');
});

test('renderDeadboltDevices: a skipped focus-guard repaint is recorded for retry', () => {
  const el = {
    innerHTML: '',
    contains: (x) => x && x.inside === true,
  };
  const gate = gateStub();
  const doc = {
    getElementById: (id) => (id === 'configZwave' ? el : null),
    activeElement: { tagName: 'SELECT', inside: true },
  };
  const { c, ports, refresh } = counters();
  loadRenderDevices()(null, doc, { devices: { zwave: { enabled: true } } }, () => {}, () => {}, gate, ports, refresh)();
  assert.equal(el.innerHTML, '', 'no repaint under the cursor');
  assert.equal(gate.skips, 1, 'skip recorded so the retry gate can deliver it later');
  assert.equal(gate.runs, 0);
  assert.equal(c.refresh, 0, 'no partial fill either');
});

test('renderDeadboltDevices: a focused BUTTON never defers the repaint (regression)', () => {
  // The old guard included BUTTON, so clicking Save deferred the rebuild the
  // click itself had earned, and the deferred rebuild wiped the section.
  const el = {
    innerHTML: '',
    contains: (x) => x && x.inside === true,
  };
  const gate = gateStub();
  const doc = {
    getElementById: (id) => (id === 'configZwave' ? el : null),
    activeElement: { tagName: 'BUTTON', inside: true },
  };
  const { c, ports, refresh } = counters();
  loadRenderDevices()(null, doc, { devices: { zwave: { enabled: true } } }, () => {}, () => {}, gate, ports, refresh)();
  assert.match(el.innerHTML, /zwavePairPanel/, 'repaint lands with a button focused');
  assert.equal(gate.skips, 0);
  assert.equal(gate.runs, 1);
});

test('renderDeadboltDevices: force bypasses the focus guard (user-initiated repaint)', () => {
  const el = {
    innerHTML: '',
    contains: (x) => x && x.inside === true,
  };
  const gate = gateStub();
  const doc = {
    getElementById: (id) => (id === 'configZwave' ? el : null),
    activeElement: { tagName: 'SELECT', inside: true },
  };
  const { c, ports, refresh } = counters();
  loadRenderDevices()(null, doc, { devices: { zwave: { enabled: true } } }, () => {}, () => {}, gate, ports, refresh)(true);
  assert.match(el.innerHTML, /zwavePairPanel/, 'forced repaint lands even with focus held');
  assert.equal(gate.skips, 0);
  assert.equal(gate.runs, 1);
});
