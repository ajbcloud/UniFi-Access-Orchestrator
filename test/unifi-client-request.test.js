'use strict';

const test = require('node:test');
const assert = require('node:assert');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const UniFiClient = require('../src/unifi-client');

// The client calls https.request(url, options, cb) at call time, so swapping the
// method on the shared module is enough to drive it without a TLS listener.
// `responder` returns { status, body } for each request it sees.
async function withHttps(responder, fn) {
  const orig = https.request;
  const seen = [];
  https.request = (url, options, cb) => {
    const req = new EventEmitter();
    let sent = '';
    req.write = (chunk) => { sent += chunk; };
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.end = () => {
      setImmediate(() => {
        seen.push({ url: String(url), method: options.method, headers: options.headers, body: sent });
        let out;
        try {
          out = responder({ url: String(url), method: options.method, body: sent });
        } catch (e) {
          req.emit('error', e);
          return;
        }
        const res = new EventEmitter();
        res.statusCode = out.status;
        cb(res);
        setImmediate(() => {
          if (out.body != null && out.body !== '') res.emit('data', out.body);
          res.emit('end');
        });
      });
    };
    return req;
  };
  try {
    return await fn(seen);
  } finally {
    https.request = orig;
  }
}

function makeClient() {
  return new UniFiClient({
    unifi: { host: '10.0.0.5', port: 12445, token: 'test-token', verify_ssl: false },
  });
}

const json = (status, obj) => ({ status, body: JSON.stringify(obj) });

test('request accepts a 2xx whose body carries no code envelope', async () => {
  await withHttps(() => json(200, { data: { id: 'door-1' } }), async () => {
    const out = await makeClient().request('GET', '/doors');
    assert.deepEqual(out.data, { id: 'door-1' }, 'a bare 2xx body is a success, not a failure');
  });
});

test('request accepts a 2xx with an empty body', async () => {
  await withHttps(() => ({ status: 204, body: '' }), async () => {
    const out = await makeClient().request('PUT', '/doors/door-1/unlock', { extra: {} });
    assert.equal(out.code, 'SUCCESS');
  });
});

test('request still honors the classic SUCCESS envelope', async () => {
  await withHttps(() => json(200, { code: 'SUCCESS', data: [1, 2] }), async () => {
    const out = await makeClient().request('GET', '/doors');
    assert.deepEqual(out.data, [1, 2]);
  });
});

test('request still rejects an explicit error code inside a 200', async () => {
  await withHttps(() => json(200, { code: 'CODE_DOOR_NOT_FOUND', msg: 'no such door' }), async () => {
    await assert.rejects(
      () => makeClient().request('GET', '/doors'),
      /CODE_DOOR_NOT_FOUND/,
      'an explicit refusal is an error even with a 200'
    );
  });
});

test('request rejects a non-2xx that carries no parseable body', async () => {
  await withHttps(() => ({ status: 502, body: '' }), async () => {
    await assert.rejects(() => makeClient().request('GET', '/doors'), /HTTP 502/);
  });
});

test('a 401 latches the token-rejected flag and clears on recovery', async () => {
  let reject = true;
  await withHttps(
    () => (reject ? json(401, { code: 'CODE_AUTH_FAILED', msg: 'bad token' }) : json(200, { code: 'SUCCESS', data: [] })),
    async () => {
      const client = makeClient();
      await assert.rejects(() => client.request('GET', '/doors'));
      assert.ok(client.authRejectedAt, 'a 401 is latched for the UI');
      assert.equal(client.authRejectedStatus, 401);
      assert.equal(client.getStatus().auth_rejected_status, 401);

      reject = false;
      await client.request('GET', '/doors');
      assert.equal(client.authRejectedAt, null, 'a later success clears the latch');
      assert.equal(client.getStatus().auth_rejected_at, null);
    }
  );
});

test('unlockDoor counts successes and failures for the dashboard', async () => {
  let ok = true;
  await withHttps(
    () => (ok ? json(200, { code: 'SUCCESS' }) : json(500, { code: 'CODE_INTERNAL', msg: 'boom' })),
    async () => {
      const client = makeClient();
      client.doorsById.set('door-1', 'Main Entrance');

      const good = await client.unlockDoor('door-1', 'test');
      assert.equal(good.success, true);
      assert.equal(client.unlockStats.succeeded, 1);
      assert.equal(client.unlockStats.consecutive_failures, 0);
      assert.ok(client.unlockStats.last_success_at);

      ok = false;
      await client.unlockDoor('door-1', 'test');
      const bad = await client.unlockDoor('door-1', 'test');
      assert.equal(bad.success, false);
      assert.equal(client.unlockStats.failed, 2);
      assert.equal(client.unlockStats.consecutive_failures, 2, 'consecutive failures are tracked');
      assert.equal(client.unlockStats.last_error.door, 'Main Entrance');
      assert.equal(client.getStatus().unlocks.failed, 2);

      ok = true;
      await client.unlockDoor('door-1', 'test');
      assert.equal(client.unlockStats.consecutive_failures, 0, 'a success resets the streak');
    }
  );
});

test('unlockDoor still stamps the orchestrator as the actor', async () => {
  await withHttps(() => json(200, { code: 'SUCCESS' }), async (seen) => {
    const client = makeClient();
    client.doorsById.set('door-1', 'Main Entrance');
    await client.unlockDoor('door-1', 'cascade from Main Entrance');
    const body = JSON.parse(seen[0].body);
    assert.equal(body.actor_name, 'Access Orchestrator', 'UniFi must attribute the unlock to this app');
    assert.equal(body.extra.reason, 'cascade from Main Entrance');
    assert.match(seen[0].url, /\/doors\/door-1\/unlock$/);
    assert.equal(seen[0].method, 'PUT');
  });
});

test('a 403 does not latch the token-rejected state', async () => {
  // A door/webhook-only token (the documented minimum) gets a 403 from
  // assignUserPin while unlocks stay authorized. Latching there would tell the
  // operator to regenerate a working token.
  await withHttps(() => json(403, { code: 'CODE_FORBIDDEN', msg: 'no scope' }), async () => {
    const client = makeClient();
    await assert.rejects(() => client.request('PUT', '/users/u-1/pin_codes', { pin_code: '1234' }));
    assert.equal(client.authRejectedAt, null, 'a scope-limited 403 is not a rejected token');
    assert.equal(client.getStatus().auth_rejected_status, null);
  });
});

test('a 403 on the WebSocket handshake does latch, since it refuses the connection', () => {
  const client = makeClient();
  client._noteAuthStatus(403, { connectionScoped: true });
  assert.ok(client.authRejectedAt);
  assert.equal(client.authRejectedStatus, 403);
});

test('assignUserPin still reports a 403 as permission_denied without latching', async () => {
  await withHttps(() => json(403, { code: 'CODE_FORBIDDEN', msg: 'no scope' }), async () => {
    const client = makeClient();
    client.userNames.set('u-1', 'Divino');
    const out = await client.assignUserPin('u-1', '1234');
    assert.equal(out.success, false);
    assert.equal(out.permission_denied, true, 'the caller still learns it is a scope problem');
    assert.equal(client.authRejectedAt, null);
  });
});
