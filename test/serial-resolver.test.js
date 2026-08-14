'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  resolve,
  isLikelyZwave,
  identityFromPort,
  identityMatchesPort,
  normalizePort,
} = require('../src/drivers/serial-resolver');

// A Zooz ZST39 (Silicon Labs CP210x) as serialport would enumerate it, already
// normalized to snake_case. Windows path by default; override per test.
function stick(over = {}) {
  return Object.assign({
    path: 'COM3',
    manufacturer: 'Silicon Labs',
    serial_number: 'ZST39ABCDEF',
    pnp_id: 'USB\\VID_10C4&PID_EA60\\ZST39ABCDEF',
    vendor_id: '10C4',
    product_id: 'EA60',
  }, over);
}

// A non-Z-Wave serial device (a USB printer/GPS), so "any port" rules can be
// shown NOT to fire.
function otherDevice(over = {}) {
  return Object.assign({
    path: 'COM9',
    manufacturer: 'FTDI',
    serial_number: 'FT12345',
    pnp_id: 'USB\\VID_0403&PID_6001\\FT12345',
    vendor_id: '0403',
    product_id: '6001',
  }, over);
}

const identityOf = (p) => identityFromPort(p, '2026-08-13T00:00:00.000Z');

test('exact saved path present: matched_by path, no rewrite', () => {
  const saved = { serial_path: 'COM3', serial_identity: identityOf(stick()) };
  const r = resolve(saved, [stick()]);
  assert.strictEqual(r.path, 'COM3');
  assert.strictEqual(r.matched_by, 'path');
  assert.strictEqual(r.changed, false);
});

test('saved path present with no captured identity: path still wins', () => {
  const saved = { serial_path: 'COM3' };
  const r = resolve(saved, [stick()]);
  assert.strictEqual(r.path, 'COM3');
  assert.strictEqual(r.matched_by, 'path');
  assert.strictEqual(r.changed, false);
});

test('COM renumber heals by serial number', () => {
  // Saved COM3, but the same stick now enumerates on COM5.
  const saved = { serial_path: 'COM3', serial_identity: identityOf(stick()) };
  const moved = stick({ path: 'COM5', pnp_id: 'USB\\VID_10C4&PID_EA60\\ZST39ABCDEF' });
  const r = resolve(saved, [moved]);
  assert.strictEqual(r.path, 'COM5');
  assert.strictEqual(r.matched_by, 'serial_number');
  assert.strictEqual(r.changed, true);
});

test('COM renumber heals by VID/PID when no identity is captured yet', () => {
  // Migration case: legacy install, no serial_identity, stick moved to COM5.
  const saved = { serial_path: 'COM3' };
  const moved = stick({ path: 'COM5' });
  const r = resolve(saved, [moved, otherDevice()]);
  assert.strictEqual(r.path, 'COM5');
  assert.strictEqual(r.matched_by, 'vid_pid');
  assert.strictEqual(r.changed, true);
});

test('two identical sticks: ambiguous, refuse to guess', () => {
  const saved = { serial_path: 'COM3' };
  const a = stick({ path: 'COM5', serial_number: '0001', pnp_id: 'USB\\VID_10C4&PID_EA60\\0001' });
  const b = stick({ path: 'COM6', serial_number: '0001', pnp_id: 'USB\\VID_10C4&PID_EA60\\0001' });
  const r = resolve(saved, [a, b]);
  assert.strictEqual(r.path, null);
  assert.strictEqual(r.matched_by, null);
  assert.strictEqual(r.candidates.length, 2);
});

test('duplicate clone serials: serial rule skips (>1 hit), no false single match', () => {
  // Both report "0001"; saved identity also "0001". Two serial hits -> null,
  // rather than opening an arbitrary one.
  const saved = { serial_path: 'COM3', serial_identity: identityOf(stick({ serial_number: '0001' })) };
  const a = stick({ path: 'COM5', serial_number: '0001' });
  const b = stick({ path: 'COM6', serial_number: '0001' });
  const r = resolve(saved, [a, b]);
  assert.strictEqual(r.path, null);
  assert.strictEqual(r.matched_by, null);
});

test('foreign device squatting on the saved path: heal to the real stick', () => {
  // Saved COM3 with the Zooz identity, but COM3 is now an FTDI device and the
  // real Zooz is on COM5. Rule 1 sees the identity contradiction and falls
  // through to the serial-number match.
  const saved = { serial_path: 'COM3', serial_identity: identityOf(stick()) };
  const squatter = otherDevice({ path: 'COM3' });
  const realStick = stick({ path: 'COM5' });
  const r = resolve(saved, [squatter, realStick]);
  assert.strictEqual(r.path, 'COM5');
  assert.strictEqual(r.matched_by, 'serial_number');
  assert.strictEqual(r.changed, true);
});

test('healthy Linux by-id save: matched_by path, changed false (never rewrite)', () => {
  // serialport lists /dev/ttyUSB0 with pnp_id = the by-id basename; the saved
  // stable path must match it and must NOT be rewritten to ttyUSB0.
  const byId = 'usb-Silicon_Labs_CP2102N_ZST39ABCDEF-if00-port0';
  const port = normalizePort({
    path: '/dev/ttyUSB0',
    manufacturer: 'Silicon Labs',
    serialNumber: 'ZST39ABCDEF',
    pnpId: byId,
    vendorId: '10c4',
    productId: 'ea60',
  });
  const saved = { serial_path: `/dev/serial/by-id/${byId}`, serial_identity: identityOf(port) };
  const r = resolve(saved, [port]);
  assert.strictEqual(r.matched_by, 'path');
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.path, `/dev/serial/by-id/${byId}`);
});

test('Linux heal lands on the stable by-id path, not the raw ttyUSB', () => {
  // Saved raw ttyUSB0, stick now on ttyUSB1. Heal should prefer the by-id form.
  const byId = 'usb-Silicon_Labs_CP2102N_ZST39ABCDEF-if00-port0';
  const moved = normalizePort({
    path: '/dev/ttyUSB1',
    manufacturer: 'Silicon Labs',
    serialNumber: 'ZST39ABCDEF',
    pnpId: byId,
    vendorId: '10c4',
    productId: 'ea60',
  });
  const saved = { serial_path: '/dev/ttyUSB0', serial_identity: identityOf(moved) };
  const r = resolve(saved, [moved]);
  assert.strictEqual(r.path, `/dev/serial/by-id/${byId}`);
  assert.strictEqual(r.matched_by, 'serial_number');
  assert.strictEqual(r.changed, true);
});

test('saved by-id matched via savedRealpath option', () => {
  // No pnp_id on the port (some drivers omit it); the by-id link resolves to
  // ttyUSB0 via realpath, passed in as an option.
  const port = normalizePort({
    path: '/dev/ttyUSB0', serialNumber: 'ZST39ABCDEF', vendorId: '10c4', productId: 'ea60',
  });
  const saved = { serial_path: '/dev/serial/by-id/usb-whatever', serial_identity: identityOf(port) };
  const r = resolve(saved, [port], { savedRealpath: '/dev/ttyUSB0' });
  assert.strictEqual(r.matched_by, 'path');
  assert.strictEqual(r.changed, false);
});

test('stick unplugged entirely: nothing conclusive', () => {
  const saved = { serial_path: 'COM3', serial_identity: identityOf(stick()) };
  const r = resolve(saved, [otherDevice()]);
  assert.strictEqual(r.path, null);
  assert.strictEqual(r.matched_by, null);
});

test('empty port list: null verdict, empty candidates', () => {
  const r = resolve({ serial_path: 'COM3' }, []);
  assert.strictEqual(r.path, null);
  assert.strictEqual(r.matched_by, null);
  assert.deepStrictEqual(r.candidates, []);
});

test('isLikelyZwave: VID 10c4 and CP210x text, not FTDI', () => {
  assert.strictEqual(isLikelyZwave(stick()), true);
  assert.strictEqual(isLikelyZwave(stick({ vendor_id: null, manufacturer: 'cp2102n' })), true);
  assert.strictEqual(isLikelyZwave(otherDevice()), false);
});

test('identityFromPort: null when the port has no USB descriptors', () => {
  assert.strictEqual(identityFromPort({ path: 'COM3' }), null);
  assert.ok(identityFromPort(stick()));
});

test('identityMatchesPort ignores updated_at churn', () => {
  const id = identityFromPort(stick(), '2020-01-01T00:00:00.000Z');
  assert.strictEqual(identityMatchesPort(id, stick()), true);
  assert.strictEqual(identityMatchesPort(id, stick({ serial_number: 'DIFFERENT' })), false);
});
