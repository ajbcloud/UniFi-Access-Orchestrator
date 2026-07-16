'use strict';

// Guards the shared connection-persist builder and the relocated Event Source
// editor (both now single-homed after the IA consolidation). Extracts the real
// functions from public/index.html via the shared extract-and-run harness.

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

function load(name) {
  return new Function(extractFn(name) + '; return ' + name + ';')();
}

test('buildConnectionConfigBody: keeps the passed server host (no 0.0.0.0 hardcode)', () => {
  const build = load('buildConnectionConfigBody');
  const body = build({ serverPort: '3000', serverHost: '10.0.0.5', host: '192.168.1.9', port: '12445', token: 'abc' });
  assert.equal(body.server.host, '10.0.0.5', 'the stored/passed server host is preserved');
  assert.equal(body.server.port, 3000);
  assert.equal(body.unifi.host, '192.168.1.9');
  assert.equal(body.unifi.port, 12445);
  assert.equal(body.unifi.token, 'abc');
});

test('buildConnectionConfigBody: omits a blank host, token, and server host', () => {
  const build = load('buildConnectionConfigBody');
  const body = build({ serverPort: '3000', port: '12445' }); // wizard: no server host, no host/token yet
  assert.ok(!('host' in body.server), 'server host omitted so the deep merge preserves the stored one');
  assert.ok(!('host' in body.unifi), 'a blank controller host is never written');
  assert.ok(!('token' in body.unifi), 'a blank token never clobbers a stored one');
});

test('buildConnectionConfigBody: applies sensible port defaults', () => {
  const build = load('buildConnectionConfigBody');
  const body = build({ serverPort: 'not-a-number', port: '' });
  assert.equal(body.server.port, 3000, 'server port falls back to 3000');
  assert.ok(!('port' in body.unifi), 'a blank controller port is omitted (merge preserves stored)');
});

test('buildEventSourceEditor: preselects the configured mode and shows its fields', () => {
  const build = load('buildEventSourceEditor');
  const ws = build({ mode: 'websocket', websocket: { reconnect_interval_seconds: 9 } });
  assert.match(ws, /value="websocket" selected/);
  assert.match(ws, /id="websocketFields" style="display:block/);
  assert.match(ws, /value="9"/, 'the stored reconnect interval is shown');

  const webhook = build({ mode: 'api_webhook' });
  assert.match(webhook, /value="api_webhook" selected/);
  assert.match(webhook, /id="webhookFields" style="display:block/);
});

test('buildEventSourceEditor: defaults to websocket when unset', () => {
  const build = load('buildEventSourceEditor');
  assert.match(build({}), /value="websocket" selected/);
  assert.match(build(undefined), /value="websocket" selected/);
});

test('IA: event source has exactly one editable home (Settings), not the old config tab', () => {
  assert.ok(html.includes('id="settingsEventSource"'), 'event source lives in Settings');
  assert.ok(!html.includes('id="configEventSource"'), 'the duplicate Automations-tab editor is gone');
  // The mode select is produced only by the single builder, not hand-written twice.
  const selects = (html.match(/id="eventSourceMode"/g) || []).length;
  assert.equal(selects, 1, 'the event source mode picker is defined once');
});
