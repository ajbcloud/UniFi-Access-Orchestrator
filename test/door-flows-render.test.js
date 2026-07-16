'use strict';

// Guards the Door Flows section: buildDoorFlowsSection (pure) plus the
// source-level contracts on renderDoorFlows and the save path. The section
// is the ONE editor for door->deadbolt and door->door wiring, so it must be
// permanently present (the fix for "my saved trigger disappeared"), never
// lose unsaved edits to a background repaint, and always PUT the whole
// flows map (replace semantics, so removals stick). Extracts the REAL
// functions from public/index.html via the shared extractFn harness.

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

function loadSection() {
  const src = extractFn('escapeHtml') + '\n' + extractFn('cssId') + '\n' + extractFn('_dfGroups')
    + '\n' + extractFn('buildRetractEdgeRow') + '\n' + extractFn('buildUnlockAction')
    + '\n' + extractFn('buildTriggerBlock') + '\n' + extractFn('buildDoorFlowCard')
    + '\n' + extractFn('buildDoorFlowsSection');
  return new Function(src + '; return buildDoorFlowsSection;')();
}

const DATA = {
  doors: [
    { name: 'Front Door', id: 'd1', discovered: true },
    { name: 'Interior Door', id: 'd2', discovered: true },
  ],
  locks: [{ lock_id: 'front_deadbolt', name: 'Front Bolt', paired: true, bound: true }],
  flows: {
    'Front Door': {
      door_id: 'd1',
      triggers: [{ type: 'entry', scope: null, actions: { unlock: null, retract: [{ lock_id: 'front_deadbolt', after_unlock: 'stay_unlocked' }] } }],
    },
  },
  warnings: [],
};

test('the section renders a card per flow and an add picker for free doors only', () => {
  const out = loadSection()(DATA);
  assert.match(out, /Front Door/, 'existing flow gets its card');
  assert.match(out, /badges in/, 'the badge-in trigger renders');
  assert.match(out, /id="dfAddDoor"/, 'add-flow picker present');
  assert.match(out, /value="Interior Door"/, 'unconfigured door offered');
  const picker = out.match(/<select id="dfAddDoor"[\s\S]*?<\/select>/)[0];
  assert.ok(!picker.includes('value="Front Door"'), 'a door with a flow is not offered twice');
});

test('no doors at all -> a connect-the-controller empty state, no dead controls', () => {
  const out = loadSection()({ doors: [], locks: [], flows: {}, warnings: [] });
  assert.match(out, /No doors discovered yet/);
  assert.ok(!out.includes('dfAddDoor'), 'no picker with nothing to pick');
});

test('doors but no flows -> an inviting empty state plus the add picker', () => {
  const out = loadSection()({ doors: DATA.doors, locks: DATA.locks, flows: {}, warnings: [] });
  assert.match(out, /No door flows yet/);
  assert.match(out, /id="dfAddDoor"/);
});

test('server warnings surface at the top, escaped', () => {
  const out = loadSection()(Object.assign({}, DATA, {
    warnings: ['"Front Bolt" has its hardware auto-relock ON <script>'],
  }));
  assert.match(out, /notice-warn/);
  assert.ok(!out.includes('<script>'), 'warning text escaped');
});

test('the intro states the door-centric model', () => {
  const out = loadSection()(DATA);
  assert.match(out, /Everything starts at the door/);
});

// --- source-level contracts on the render + save path ----------------------

test('renderDoorFlows guards unsaved edits, not just focus', () => {
  const src = extractFn('renderDoorFlows');
  assert.match(src, /_dirtyDoorFlowCards\(\)/, 'dirty cards detected before any repaint');
  assert.match(src, /sectionHoldsFocus\(el\) \|\| dirtyDoors\.length/,
    'a background repaint skips while ANY card holds unsaved edits');
  assert.match(src, /collectDoorFlowCard\(door\)/,
    'a forced repaint snapshots dirty cards into the model first');
  assert.match(src, /fresh\.flows\[door\] = doorFlowsData\.flows\[door\]/,
    'carried-over edits survive the refetch');
});

test('saves PUT the WHOLE flows map so removals stick (replace, not merge)', () => {
  const put = extractFn('putDoorFlows');
  assert.match(put, /api\('PUT', '\/api\/door-flows', \{ flows: doorFlowsData\?\.flows \|\| \{\} \}\)/,
    'the full map is sent every time');
  const remove = extractFn('removeDoorFlow');
  assert.match(remove, /delete doorFlowsData\.flows\[door\]/, 'removal deletes locally then PUTs the rest');
  assert.match(remove, /await confirmInApp\(/, 'destructive removal confirms first via the in-app modal (native confirm broke Electron focus)');
});

test('add/remove edge are local edits that mark the card dirty (Save commits)', () => {
  const add = extractFn('addRetractEdge');
  assert.match(add, /collectDoorFlowCard\(door\)/, 'in-progress edits on other rows survive the add');
  assert.match(add, /after_unlock: 'stay_unlocked'/, 'a new edge starts at the app-owned stay-unlocked default');
  assert.ok(!add.includes('putDoorFlows'), 'add is not an implicit save');
  const rm = extractFn('removeRetractEdge');
  assert.match(rm, /splice\(eIdx, 1\)/);
  assert.ok(!rm.includes('putDoorFlows'), 'remove edge is not an implicit save');
  const repaint = extractFn('repaintDoorFlowCard');
  assert.match(repaint, /markSectionDirty\(/, 'structural edits arm the Save button');
});

test('saveDoorFlow refuses an empty flow instead of silently dropping it', () => {
  const save = extractFn('saveDoorFlow');
  assert.match(save, /_flowHasContent/, 'content check present');
  assert.match(save, /Remove Flow/, 'the empty-flow message points at the real removal path');
  assert.match(save, /refreshZwaveDeadbolt\(\)/, 'device cards refresh their Triggered-by lines after a save');
});

test('the designer has no deadbolt/cascade write path anymore', () => {
  assert.ok(!html.includes('doSaveDeadboltTrigger'), 'the flat single-deadbolt write is gone');
  assert.ok(!html.includes('doSaveCascade'), 'the designer cascade write is gone');
  assert.match(html, /renderFlowSummary/, 'retract/cascade selections render a read-only summary');
  assert.match(html, /jumpToDoorFlow/, 'the summary deep-links to the Door Flows editor');
});
