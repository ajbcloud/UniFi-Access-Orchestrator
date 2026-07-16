'use strict';

// Source-level guards for the keypad-code revoke path in src/index.js and the
// Z-Wave wake hook in src/drivers/zwave-lock.js. These functions touch the
// live UniFi client and Z-Wave drivers, so they cannot be unit-tested without
// the optional zwave-js dependency. Following the pattern in
// access-gating.test.js and desktop-ux.test.js, we read the source as text and
// assert the safety-critical wiring is present. The behavior these encode:
//   - a code is reported revoked only when the physical clear confirms,
//   - an unconfirmed clear arms a pending_clears marker (no PIN stored),
//   - pending clears retry and are cleared only on a confirmed clear,
//   - a battery lock waking retries its pending clears,
//   - health-restore retries pending clears,
//   - a blocked lock counts as a handled (not failed) Save outcome.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
const zwaveLockSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'drivers', 'zwave-lock.js'), 'utf8');

// Extract a named top-level function body by brace matching, so an assertion
// can be scoped to one function rather than the whole 3.7k-line file. The
// parameter list is skipped by paren matching first, because a destructured
// argument (for example { lockId, driver, label }) would otherwise be mistaken
// for the body's opening brace.
function fnBody(src, name) {
  const decl = src.indexOf('function ' + name);
  assert.ok(decl >= 0, 'function not found: ' + name);
  const parenOpen = src.indexOf('(', decl);
  let pd = 0;
  let i = parenOpen;
  for (; i < src.length; i++) {
    if (src[i] === '(') pd++;
    else if (src[i] === ')') { pd--; if (pd === 0) { i++; break; } }
  }
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(decl, j + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}

test('revokeHeldCode marks revoked only on a confirmed clear', () => {
  const body = fnBody(indexSrc, 'revokeHeldCode');
  assert.match(body, /const revoked = confirmed === true;/,
    'revoked must be gated on confirmed === true, never set unconditionally');
});

test('an unconfirmed clear arms a pending_clears marker that stores no PIN', () => {
  const body = fnBody(indexSrc, 'revokeHeldCode');
  assert.match(body, /pending_clears\[String\(slot\)\] = \{ user_id: userId, requested_at: requestedAt, reason \}/,
    'the marker records only user_id, requested_at, and reason');
  // The marker branch must not capture a PIN. The whole function should never
  // reference a pin field, since a physical clear needs only the slot number.
  assert.ok(!/pin/i.test(body), 'revokeHeldCode must not touch any PIN');
});

test('revokeHeldCode deletes the user_codes entry so a re-interview cannot resurrect it', () => {
  const body = fnBody(indexSrc, 'revokeHeldCode');
  assert.match(body, /delete lock\.user_codes\[String\(slot\)\]/,
    'the config entry is removed on revoke, confirmed or not, to block restoreUserCodes');
});

test('retryPendingClears clears a marker only on a confirmed clear', () => {
  const body = fnBody(indexSrc, 'retryPendingClears');
  assert.match(body, /if \(confirmed === true\)/, 'the marker is deleted only when the clear confirms');
  assert.match(body, /delete pc\[slotKey\]/, 'the confirmed slot marker is removed');
});

test('a waking Z-Wave node retries that lock\'s pending clears', () => {
  assert.match(zwaveLockSrc, /this\.emit\('node-awake'/, 'the driver announces a wake so a queued clear can retry');
  assert.match(indexSrc, /driver\.on\('node-awake'/, 'index wires the wake event to retryPendingClears');
  assert.match(indexSrc, /retryPendingClears\(lockId\)/, 'the wake retry is scoped to the lock that woke');
});

test('health-restore retries pending clears', () => {
  assert.match(indexSrc, /function onUnifiStateChange/, 'a health-restore handler exists');
  assert.match(indexSrc, /startHealthMonitor\(onUnifiStateChange\)/,
    'the health monitor is started with the retry handler');
});

test('keypad ops are serialized through withKeypadLock', () => {
  assert.match(indexSrc, /function withKeypadLock/, 'a single-flight serializer exists for keypad driver ops');
});

test('a blocked lock counts as handled, not a failed Save', () => {
  assert.match(indexSrc, /results\.every\(\(r\) => r\.slot != null \|\| r\.blocked\)/,
    'the Save success flag treats a blocked (revoked or pending) lock as a legitimate outcome');
});

test('the manual remove endpoint routes through the shared revoke executor', () => {
  // Both the gated POST revoke and the manual DELETE go through revokeHeldCode,
  // so a sleeping lock queues a retry instead of a false "removed" report.
  const calls = (indexSrc.match(/await revokeHeldCode\(/g) || []).length;
  assert.ok(calls >= 2, 'revokeHeldCode is used by both the POST and DELETE handlers, saw ' + calls);
});
