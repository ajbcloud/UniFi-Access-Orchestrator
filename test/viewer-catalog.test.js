'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ViewerCatalog, viewersFromDevices, callActorFromSource } = require('../src/viewer-catalog');

// The access.logs.add / system-log _source shape for an intercom answer, as
// the controller logs it: a door unlock with credential CALL, the viewer as
// the actor.
function callSource({ id = 'v1', name = 'AnswerMD Viewer', result = 'ACCESS', type = 'access.door.unlock', provider = 'CALL', published = 1 } = {}) {
  return {
    actor: { id, display_name: name, type: 'device' },
    authentication: { credential_provider: provider },
    event: { type, result, published },
    target: [{ type: 'door', id: 'd1', display_name: 'Main Entrance' }],
  };
}

test('an answered call (CALL unlock or remotecall.accepted) yields the viewer', () => {
  assert.deepEqual(callActorFromSource(callSource()), { id: 'v1', name: 'AnswerMD Viewer' });
  assert.deepEqual(callActorFromSource(callSource({ type: 'access.remotecall.accepted', provider: null, result: null })), { id: 'v1', name: 'AnswerMD Viewer' });
});

test('canceled calls, badge-ins and phone-forwarded answers are not viewers', () => {
  assert.equal(callActorFromSource(callSource({ result: 'SUCCESS' })), null, 'Call Canceled');
  assert.equal(callActorFromSource(callSource({ provider: 'NFC' })), null, 'a badge-in');
  assert.equal(callActorFromSource(callSource({ name: '+13059891040' })), null, 'a phone number');
});

test('the device list is flattened and filtered to viewers', () => {
  const data = [
    [{ id: 'hub1', name: 'Main Hub', type: 'UAH' }, { id: 'v1', alias: 'Rosemurgy Viewer', name: 'UA Viewer', type: 'UA-Intercom-Viewer' }],
    [{ id: 'g3', name: 'UA G3 Intercom bdd0', type: 'UA-G3-Intercom' }],
  ];
  assert.deepEqual(viewersFromDevices(data), [{ id: 'v1', name: 'Rosemurgy Viewer', type: 'UA-Intercom-Viewer' }]);
});

test('a rename on the controller updates the name under the same id', () => {
  const c = new ViewerCatalog();
  c.note({ id: 'v1', name: 'AnswerMD Viewer', source: 'devices' });
  c.note({ id: 'v1', name: 'AnswerMD Front Desk', source: 'event' });
  assert.equal(c.list().length, 1);
  assert.equal(c.byId('v1').name, 'AnswerMD Front Desk');
  assert.equal(c.byName('answermd front desk').id, 'v1');
  assert.equal(c.byName('AnswerMD Viewer'), null);
});

test('a name-only entry is upgraded once the viewer is seen with an id', () => {
  const c = new ViewerCatalog();
  c.note({ id: null, name: 'Rosemurgy Viewer' });
  c.note({ id: 'v9', name: 'Rosemurgy Viewer' });
  assert.deepEqual(c.list().map((e) => [e.id, e.name]), [['v9', 'Rosemurgy Viewer']]);
});

test('system-log hits are applied oldest first, so the newest name wins', () => {
  const c = new ViewerCatalog();
  c.noteLogHits([
    { _source: callSource({ name: 'New Name', published: 200 }) },
    { _source: callSource({ name: 'Old Name', published: 100 }) },
  ]);
  assert.equal(c.byId('v1').name, 'New Name');
});

test('live events are learned from the WebSocket wrapper', () => {
  const c = new ViewerCatalog();
  assert.equal(c.observe({ event: 'access.logs.add', data: { _source: callSource() } }), true);
  assert.equal(c.observe({ event: 'access.logs.add', data: { _source: callSource() } }), false, 'a repeat is not a change');
  assert.equal(c.byId('v1').name, 'AnswerMD Viewer');
});

test('the catalog persists and reloads', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'viewers-')), 'viewers.json');
  const a = new ViewerCatalog({ filePath: file });
  a.note({ id: 'v1', name: 'AnswerMD Viewer', source: 'event' });
  const b = new ViewerCatalog({ filePath: file });
  b.load();
  assert.equal(b.byId('v1').name, 'AnswerMD Viewer');
});

test('allByName returns every id a viewer has been reported under', () => {
  const c = new ViewerCatalog();
  c.note({ id: 'api-1', name: 'AnswerMD Viewer', source: 'devices' });
  c.note({ id: 'evt-1', name: 'answermd viewer', source: 'event' });
  assert.deepEqual(c.allByName('AnswerMD Viewer').map((e) => e.id).sort(), ['api-1', 'evt-1']);
});
