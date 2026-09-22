'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

// Stub the ws module BEFORE unifi-client captures it at require time. Each test
// file runs in its own process under `node --test`, so this cannot leak.
class FakeWebSocket extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = FakeWebSocket.CONNECTING;
    this.terminated = false;
    FakeWebSocket.instances.push(this);
  }
  ping() {}
  terminate() { this.terminated = true; this.readyState = FakeWebSocket.CLOSED; }
}
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;
FakeWebSocket.instances = [];

const wsPath = require.resolve('ws');
require.cache[wsPath] = {
  id: wsPath,
  filename: wsPath,
  loaded: true,
  exports: FakeWebSocket,
};

const UniFiClient = require('../src/unifi-client');

function makeClient() {
  return new UniFiClient({
    unifi: { host: '10.0.0.5', port: 12445, token: 'test-token', verify_ssl: false },
  });
}

function rejectHandshake(ws, statusCode) {
  const req = new EventEmitter();
  req.destroy = () => {};
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.resume = () => {};
  ws.emit('unexpected-response', req, res);
}

test('a rejected handshake terminates the socket and schedules a reconnect', () => {
  // Registering an unexpected-response listener suppresses ws's own
  // abortHandshake, which is what would emit 'close' and drive the retry. If
  // this handler does not do it itself, one 401 wedges the socket in
  // CONNECTING and event ingestion stops for good.
  const client = makeClient();
  let scheduled = 0;
  client.scheduleReconnect = () => { scheduled++; };

  client.connectWebSocket(() => {}, 5);
  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws, 'a socket was created');

  rejectHandshake(ws, 401);

  assert.equal(scheduled, 1, 'the handler drives the retry itself');
  assert.ok(ws.terminated, 'the stuck CONNECTING socket is terminated');
  assert.equal(client.wsHandshakeStatus, 401);
  assert.ok(client.authRejectedAt, 'a 401 handshake latches the token state');
});

test('a 403 handshake also latches, since it refuses the whole connection', () => {
  const client = makeClient();
  client.scheduleReconnect = () => {};
  client.connectWebSocket(() => {}, 5);
  rejectHandshake(FakeWebSocket.instances.at(-1), 403);
  assert.equal(client.authRejectedStatus, 403);
});

test('a non-auth handshake rejection still reconnects without blaming the token', () => {
  const client = makeClient();
  let scheduled = 0;
  client.scheduleReconnect = () => { scheduled++; };
  client.connectWebSocket(() => {}, 5);
  rejectHandshake(FakeWebSocket.instances.at(-1), 502);
  assert.equal(scheduled, 1, 'a gateway error still retries');
  assert.equal(client.authRejectedAt, null, '502 is not a credentials problem');
  assert.equal(client.wsHandshakeStatus, 502);
});

test('a successful open records the handshake status', () => {
  const client = makeClient();
  client.connectWebSocket(() => {}, 5);
  const ws = FakeWebSocket.instances.at(-1);
  ws.emit('open');
  assert.equal(client.wsHandshakeStatus, 101);
  if (client.wsPingInterval) clearInterval(client.wsPingInterval);
});

test('unrecognized access.* events are counted, telemetry noise is not', () => {
  const client = makeClient();
  client.connectWebSocket(() => {}, 5);
  const ws = FakeWebSocket.instances.at(-1);
  ws.emit('open');

  ws.emit('message', Buffer.from(JSON.stringify({ event: 'access.doorbell.answered.v2' })));
  ws.emit('message', Buffer.from(JSON.stringify({ event: 'access.doorbell.answered.v2' })));
  ws.emit('message', Buffer.from(JSON.stringify({ event: 'data.v2.device.update' })));

  const seen = client.getStatus().ws_unhandled_access_types;
  assert.equal(seen['access.doorbell.answered.v2'], 2, 'the new name is counted');
  assert.ok(!('data.v2.device.update' in seen), 'telemetry noise is not flagged as a rename');
  if (client.wsPingInterval) clearInterval(client.wsPingInterval);
});
