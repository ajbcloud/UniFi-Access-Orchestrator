'use strict';

// Guards the dashboard deadbolt card: it renders /health data correctly and,
// critically, escapes controller-derived strings (the last-action detail
// carries event actor names). Extracts the ACTUAL renderDeadbolt + escapeHtml
// from public/index.html and runs them against a mock DOM, so this test tracks
// the shipped code with no browser dependency.

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

function loadRenderer() {
  const src = extractFn('escapeHtml') + '\n' + extractFn('describeLockLink')
    + '\n' + extractFn('describeLockBattery') + '\n' + extractFn('describeLockModel')
    + '\n' + extractFn('describeLockSecurity') + '\n' + extractFn('describeLockBolt')
    + '\n' + extractFn('renderDeadbolt');
  const els = {};
  for (const id of ['deadboltCard', 'deadboltState', 'deadboltModel', 'deadboltSecurity', 'deadboltBattery', 'deadboltLink', 'deadboltDoor', 'deadboltLastAction', 'deadboltStats']) {
    els[id] = { textContent: '', innerHTML: '', className: '', style: {} };
  }
  const document = { getElementById: (id) => els[id] || null };
  const factory = new Function('document', src + '; return renderDeadbolt;');
  return { renderDeadbolt: factory(document), els };
}

test('deadbolt card shows the detected model and security class, never unknown', () => {
  const { renderDeadbolt, els } = loadRenderer();
  renderDeadbolt({ deadbolt: { enabled: true, trigger_door: 'Front Door',
    lock: { boltState: 'unknown', battery: 90, online: true, linkState: 'online',
      name: 'Front Door Deadbolt', model: 'Yale Assure Deadbolt (ZW2)', securityClass: 'S0 Legacy' },
    stats: {} } });
  assert.strictEqual(els.deadboltModel.textContent, 'Front Door Deadbolt (Yale Assure Deadbolt (ZW2))');
  assert.strictEqual(els.deadboltSecurity.textContent, 'S0 Legacy');
  assert.strictEqual(els.deadboltState.textContent, 'reading...', 'link up + unread bolt is transient, not unknown');
});

test('deadbolt card renders /health data', () => {
  const { renderDeadbolt, els } = loadRenderer();
  renderDeadbolt({ deadbolt: { enabled: true, trigger_door: 'Front Door',
    lock: { boltState: 'unlocked', battery: 87, online: true },
    stats: { retracts: 2, retracts_failed: 0, locks: 1, locks_failed: 0, cascades: 1, cascades_failed: 1,
      last_action: { action: 'retract', success: true, detail: 'entry: Alice at Front Door', time: '2026-07-09T08:00:00Z' } } } });
  assert.strictEqual(els.deadboltCard.style.display, '');
  assert.strictEqual(els.deadboltState.textContent, 'unlocked');
  assert.ok(els.deadboltState.className.includes('warning'));
  assert.strictEqual(els.deadboltBattery.textContent, '87%');
  assert.strictEqual(els.deadboltLink.textContent, 'online');
  assert.strictEqual(els.deadboltDoor.textContent, 'Front Door');
  assert.ok(els.deadboltLastAction.innerHTML.includes('retract ok'));
  assert.ok(els.deadboltStats.textContent.includes('retracts 2'));
  assert.ok(els.deadboltStats.textContent.includes('cascades 1 (1 failed)'));
});

test('deadbolt card escapes controller-derived last-action detail (XSS)', () => {
  const { renderDeadbolt, els } = loadRenderer();
  renderDeadbolt({ deadbolt: { enabled: true, trigger_door: 'Front Door',
    lock: { boltState: 'jammed' },
    stats: { last_action: { action: 'lock', success: false, detail: '<img src=x onerror=alert(1)>', time: '2026-07-09T08:00:00Z' } } } });
  assert.ok(!els.deadboltLastAction.innerHTML.includes('<img'), 'raw <img must not appear');
  assert.ok(els.deadboltLastAction.innerHTML.includes('&lt;img'), 'must be escaped');
  assert.ok(els.deadboltState.className.includes('error'), 'jammed -> error pill');
});

test('deadbolt card hides when the add-on is disabled', () => {
  const { renderDeadbolt, els } = loadRenderer();
  renderDeadbolt({ deadbolt: { enabled: false } });
  assert.strictEqual(els.deadboltCard.style.display, 'none');
});

// ---------------------------------------------------------------------------
// Pairing panel renderer (pure function: status -> innerHTML)
// ---------------------------------------------------------------------------

function loadPairPanel() {
  const src = extractFn('escapeHtml') + '\n' + extractFn('renderZwavePairPanel');
  const factory = new Function(src + '; return renderZwavePairPanel;');
  return factory();
}

test('pair panel renders every state', () => {
  const render = loadPairPanel();
  assert.strictEqual(render(null), '');
  assert.strictEqual(render({ mode: null, state: 'idle' }), '');
  assert.ok(render({ mode: 'include', state: 'starting', seconds_in_state: 3 }).includes('starting the Z-Wave controller'));
  assert.ok(render({ mode: 'include', state: 'waiting_for_device', seconds_in_state: 9 }).includes('Schlage button'));
  const dsk = render({ mode: 'include', state: 'dsk_pending', dsk: '-11111-22222' });
  assert.ok(dsk.includes('-11111-22222'));
  assert.ok(dsk.includes('zwavePinInput'));
  assert.ok(render({ mode: 'include', state: 'provisioning', seconds_in_state: 2 }).includes('Securely joining'));
  const done = render({ mode: 'include', state: 'done', node_id: 17, security: 'S2 Access Control' });
  assert.ok(done.includes('Paired!') && done.includes('17'));
  const undone = render({ mode: 'exclude', state: 'done', node_id: 17 });
  assert.ok(undone.includes('Unpaired'));
  const failed = render({ mode: 'include', state: 'failed', error: 'no device' });
  assert.ok(failed.includes('failed') && failed.includes('no device') && failed.includes('startPairing()'));
  assert.ok(render({ mode: 'exclude', state: 'failed', error: 'x' }).includes('startUnpair()'));
  assert.ok(render({ mode: 'include', state: 'cancelled' }).includes('cancelled'));
});

test('pair panel escapes device-derived dsk and error strings (XSS)', () => {
  const render = loadPairPanel();
  const hostileDsk = render({ mode: 'include', state: 'dsk_pending', dsk: '"><img src=x onerror=alert(1)>' });
  assert.ok(!hostileDsk.includes('<img'), 'raw <img must not appear in dsk');
  assert.ok(hostileDsk.includes('&lt;img'));
  const hostileErr = render({ mode: 'include', state: 'failed', error: '<script>alert(1)</script>' });
  assert.ok(!hostileErr.includes('<script>'), 'raw script must not appear in error');
  assert.ok(hostileErr.includes('&lt;script&gt;'));
});
