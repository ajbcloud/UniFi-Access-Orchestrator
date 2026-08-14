'use strict';

// Guards describeSerialPorts in public/index.html: the pure view-model behind
// the Z-Wave serial-port dropdown. It must trust the SERVER's saved_path /
// driver_path (not the browser's configData) and produce honest status states
// instead of the old bare "saved, not detected". Extracts the REAL function
// from the HTML via the shared extractFn pattern.

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

const describeSerialPorts = new Function(extractFn('describeSerialPorts') + '; return describeSerialPorts;')();

const zst = (over = {}) => Object.assign({
  path: 'COM5', manufacturer: 'Silicon Labs', serial_number: 'ZST39ABCDEF',
  vendor_id: '10C4', product_id: 'EA60', likely_zwave: true,
  is_active: false, matches_saved_identity: false,
}, over);

test('unavailable build: flagged, no options', () => {
  const v = describeSerialPorts({ available: false });
  assert.strictEqual(v.unavailable, true);
  assert.match(v.status, /does not include Z-Wave/);
});

test('connected on the saved port: plain connected status', () => {
  const v = describeSerialPorts({
    available: true, saved_path: 'COM5', driver_running: true, driver_path: 'COM5',
    ports: [zst({ path: 'COM5', is_active: true })],
  });
  assert.match(v.status, /Connected on COM5/);
  assert.ok(v.options.find((o) => o.value === 'COM5' && o.selected), 'active port selected');
});

test('auto-updated: driver healed onto a new port', () => {
  const v = describeSerialPorts({
    available: true, saved_path: 'COM3', driver_running: true, driver_path: 'COM5',
    ports: [zst({ path: 'COM5', is_active: true })],
  });
  assert.match(v.status, /Auto-updated/);
  assert.match(v.status, /COM5/);
  assert.match(v.status, /moved from COM3/);
  assert.ok(v.options.find((o) => o.value === 'COM5' && o.selected));
});

test('driver down, stick found on a different port by identity: prompt to select', () => {
  const v = describeSerialPorts({
    available: true, saved_path: 'COM3', driver_running: false, driver_path: null,
    ports: [zst({ path: 'COM5', matches_saved_identity: true })],
    resolution: { resolved_path: 'COM5', matched_by: 'serial_number', changed: true },
  });
  assert.match(v.status, /appears to be on COM5/);
  const opt = v.options.find((o) => o.value === 'COM5');
  assert.match(opt.label, /your saved stick/);
});

test('stick genuinely missing: troubleshooting guidance, saved stays selectable', () => {
  const v = describeSerialPorts({
    available: true, saved_path: 'COM3', driver_running: false, driver_path: null,
    ports: [{ path: 'COM9', manufacturer: 'FTDI', likely_zwave: false, is_active: false, matches_saved_identity: false }],
    resolution: { resolved_path: null, matched_by: null, changed: false, candidate_count: 0 },
  });
  assert.match(v.status, /not found/);
  assert.match(v.status, /selective suspend/);
  const saved = v.options.find((o) => o.value === 'COM3');
  assert.ok(saved && saved.selected, 'saved port kept selectable');
  assert.match(saved.label, /stick not found/);
  assert.doesNotMatch(v.status, /saved, not detected/, 'no more of the old ambiguous label');
});

test('no ports at all and nothing saved: empty option set', () => {
  const v = describeSerialPorts({ available: true, saved_path: '', driver_running: false, driver_path: null, ports: [] });
  assert.strictEqual(v.options.length, 0);
});

test('port labels carry connected/identity/likely tags and manufacturer', () => {
  const v = describeSerialPorts({
    available: true, saved_path: 'COM5', driver_running: true, driver_path: 'COM5',
    ports: [zst({ path: 'COM5', is_active: true })],
  });
  const opt = v.options.find((o) => o.value === 'COM5');
  assert.match(opt.label, /connected/);
  assert.match(opt.label, /Silicon Labs/);
});
