'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const auditLog = require('../src/audit-log');

function tmpFile() {
  return path.join(os.tmpdir(), `uao-audit-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
}

test('appendEntry chains entries and readEntries returns them', () => {
  const f = tmpFile();
  try {
    auditLog.appendEntry(f, { actor: 'admin', action: 'pin_set', target: 'Alice' }, '2026-01-01T00:00:00Z');
    auditLog.appendEntry(f, { actor: 'user', action: 'pin_changed_by_user', target: 'Bob' }, '2026-01-01T00:01:00Z');
    const entries = auditLog.readEntries(f);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].seq, 1);
    assert.strictEqual(entries[1].seq, 2);
    assert.strictEqual(entries[0].prev, '', 'genesis has empty prev');
    assert.strictEqual(entries[1].prev, entries[0].hash, 'each entry links to the prior hash');
  } finally { fs.rmSync(f, { force: true }); }
});

test('the audit file is created owner-only (0600)', () => {
  const f = tmpFile();
  try {
    auditLog.appendEntry(f, { actor: 'admin', action: 'admin_pin_set' });
    const mode = fs.statSync(f).mode & 0o777;
    assert.strictEqual(mode, 0o600);
  } finally { fs.rmSync(f, { force: true }); }
});

test('verifyChain confirms an intact chain', () => {
  const f = tmpFile();
  try {
    for (let i = 0; i < 5; i++) auditLog.appendEntry(f, { actor: 'admin', action: 'pin_set', target: `u${i}` }, `2026-01-01T00:0${i}:00Z`);
    const res = auditLog.verifyChain(f);
    assert.deepStrictEqual(res, { ok: true, count: 5, brokenAt: null });
  } finally { fs.rmSync(f, { force: true }); }
});

test('verifyChain detects an edited entry', () => {
  const f = tmpFile();
  try {
    auditLog.appendEntry(f, { actor: 'admin', action: 'pin_set', target: 'Alice' }, '2026-01-01T00:00:00Z');
    auditLog.appendEntry(f, { actor: 'admin', action: 'pin_removed', target: 'Alice' }, '2026-01-01T00:01:00Z');
    auditLog.appendEntry(f, { actor: 'admin', action: 'pin_set', target: 'Carol' }, '2026-01-01T00:02:00Z');
    // tamper: rewrite the target on line 2 but keep its (now-stale) hash
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
    const e = JSON.parse(lines[1]);
    e.target = 'Mallory';
    lines[1] = JSON.stringify(e);
    fs.writeFileSync(f, lines.join('\n') + '\n');
    const res = auditLog.verifyChain(f);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.brokenAt, 2, 'the first broken entry is flagged');
  } finally { fs.rmSync(f, { force: true }); }
});

test('verifyChain detects a deleted entry (chain break)', () => {
  const f = tmpFile();
  try {
    auditLog.appendEntry(f, { actor: 'admin', action: 'a' }, '2026-01-01T00:00:00Z');
    auditLog.appendEntry(f, { actor: 'admin', action: 'b' }, '2026-01-01T00:01:00Z');
    auditLog.appendEntry(f, { actor: 'admin', action: 'c' }, '2026-01-01T00:02:00Z');
    // delete the middle line: entry 3 now links to entry 1's hash -> break at 2
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
    fs.writeFileSync(f, [lines[0], lines[2]].join('\n') + '\n');
    const res = auditLog.verifyChain(f);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.brokenAt, 2);
  } finally { fs.rmSync(f, { force: true }); }
});

test('readEntries respects the limit and an empty/missing file is safe', () => {
  const f = tmpFile();
  try {
    for (let i = 0; i < 10; i++) auditLog.appendEntry(f, { actor: 'admin', action: `n${i}` }, `2026-01-01T00:0${i}:00Z`);
    const last3 = auditLog.readEntries(f, 3);
    assert.strictEqual(last3.length, 3);
    assert.strictEqual(last3[2].action, 'n9', 'returns the most recent slice');
  } finally { fs.rmSync(f, { force: true }); }
  // missing file
  assert.deepStrictEqual(auditLog.readEntries(tmpFile()), []);
  assert.deepStrictEqual(auditLog.verifyChain(tmpFile()), { ok: true, count: 0, brokenAt: null });
});
