'use strict';

// Guards the wizard connect-step inline validation: a plausible host/IP check
// and the field validator that gates the connection test. Pure functions
// extracted from public/index.html.

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

const isLikelyHostOrIp = new Function(extractFn('isLikelyHostOrIp') + '; return isLikelyHostOrIp;')();
const validateConnectInputs = new Function(
  extractFn('isLikelyHostOrIp') + '\n' + extractFn('validateConnectInputs') + '; return validateConnectInputs;'
)();

test('isLikelyHostOrIp: accepts real IPs and hostnames, rejects junk', () => {
  assert.ok(isLikelyHostOrIp('192.168.1.1'));
  assert.ok(isLikelyHostOrIp('10.1.10.5'));
  assert.ok(isLikelyHostOrIp('unifi.local'));
  assert.ok(!isLikelyHostOrIp('999.1.1.1'), 'octets over 255 are rejected');
  assert.ok(!isLikelyHostOrIp('not a host'));
  assert.ok(!isLikelyHostOrIp(''));
});

test('validateConnectInputs: flags a missing host and token', () => {
  const r = validateConnectInputs({ host: '', token: '' });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2, 'both the host and token are flagged');
});

test('validateConnectInputs: passes a valid IP and token', () => {
  const r = validateConnectInputs({ host: '192.168.1.1', token: 'abc', port: '12445' });
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

test('validateConnectInputs: rejects a malformed host and an out-of-range port', () => {
  assert.ok(validateConnectInputs({ host: '999.1.1.1', token: 'abc' }).errors.some((e) => /valid IP/.test(e)));
  assert.ok(validateConnectInputs({ host: '192.168.1.1', token: 'abc', port: '70000' }).errors.some((e) => /1 and 65535/.test(e)));
});

test('validateConnectInputs: a blank port is allowed (defaults apply later)', () => {
  assert.equal(validateConnectInputs({ host: '192.168.1.1', token: 'abc', port: '' }).ok, true);
});
