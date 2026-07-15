'use strict';

// Guards UniFiClient.assignUserPin: the optional "overwrite the user's PIN in
// UniFi" push. The API can only WRITE PINs (GET exposes just a hash token),
// so this is the whole UniFi surface of the PIN feature. request() is stubbed
// directly (an instance method), so no HTTP or controller is involved.

const test = require('node:test');
const assert = require('node:assert');

const UniFiClient = require('../src/unifi-client');

function makeClient() {
  return new UniFiClient({
    unifi: { host: '192.0.2.1', port: 12445, token: 'tok', verify_ssl: false },
    resolver: {},
    self_trigger_prevention: {},
  });
}

test('assignUserPin PUTs the pin_codes endpoint and reports success', async () => {
  const client = makeClient();
  client.userNames.set('u-1', 'Alice');
  const calls = [];
  client.request = async (method, path, body) => {
    calls.push({ method, path, body });
    return { code: 'SUCCESS' };
  };
  const r = await client.assignUserPin('u-1', '246810');
  assert.deepEqual(r, { success: true, userId: 'u-1' });
  assert.deepEqual(calls, [{ method: 'PUT', path: '/users/u-1/pin_codes', body: { pin_code: '246810' } }]);
});

test('a 403 surfaces as permission_denied so the UI can explain the token scope', async () => {
  const client = makeClient();
  client.request = async () => {
    const err = new Error('API error: CODE_OPERATION_FORBIDDEN - forbidden');
    err.statusCode = 403;
    throw err;
  };
  const r = await client.assignUserPin('u-2', '1234');
  assert.equal(r.success, false);
  assert.equal(r.statusCode, 403);
  assert.equal(r.permission_denied, true);
  assert.match(r.error, /forbidden/i);
});

test('a non-permission failure is reported without the permission flag', async () => {
  const client = makeClient();
  client.request = async () => {
    const err = new Error('API error: CODE_PARAMS_INVALID - pin length');
    err.statusCode = 400;
    throw err;
  };
  const r = await client.assignUserPin('u-3', '99');
  assert.equal(r.success, false);
  assert.equal(r.permission_denied, false);
  assert.equal(r.statusCode, 400);
});
