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
  const src = extractFn('escapeHtml') + '\n' + extractFn('renderDeadbolt');
  const els = {};
  for (const id of ['deadboltCard', 'deadboltState', 'deadboltBattery', 'deadboltLink', 'deadboltDoor', 'deadboltLastAction', 'deadboltStats']) {
    els[id] = { textContent: '', innerHTML: '', className: '', style: {} };
  }
  const document = { getElementById: (id) => els[id] || null };
  const factory = new Function('document', src + '; return renderDeadbolt;');
  return { renderDeadbolt: factory(document), els };
}

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
