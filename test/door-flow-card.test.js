'use strict';

// Guards buildDoorFlowCard: one card per configured door in the Door Flows
// editor ("everything starts at the door"). The card must always be editable
// (the old separate automation block vanished after a save), offer only
// usable locks for a new retract edge, and keep the retract-vs-cascade
// distinction explicit. Extracts the REAL functions from public/index.html
// via the shared extractFn harness.

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

function load() {
  const src = extractFn('escapeHtml') + '\n' + extractFn('cssId')
    + '\n' + extractFn('buildRetractEdgeRow') + '\n' + extractFn('buildCascadeEditor')
    + '\n' + extractFn('buildDoorFlowCard');
  return new Function(src + '; return buildDoorFlowCard;')();
}

const DATA = {
  doors: [
    { name: 'Front Door', id: 'd1', discovered: true },
    { name: 'Interior Door', id: 'd2', discovered: true },
  ],
  locks: [
    { lock_id: 'front_deadbolt', name: 'Front Bolt', paired: true, bound: true, hardware_auto_relock: false },
    { lock_id: 'side_deadbolt', name: 'Side Bolt', paired: true, bound: true, hardware_auto_relock: null },
    { lock_id: 'ghost_bolt', name: 'Ghost', paired: false, bound: false, hardware_auto_relock: null },
  ],
};

function flow(overrides = {}) {
  return Object.assign({
    door_id: 'd1',
    retract: [{ lock_id: 'front_deadbolt', after_unlock: 'lock_default', require_result: 'ACCESS', mirror_unlock: false, relock_cooldown_seconds: 10 }],
    cascade: null,
  }, overrides);
}

test('a card carries the door headline, its edges, Save, and Remove Flow', () => {
  const out = load()('Front Door', flow(), DATA);
  assert.match(out, /When entry is granted at Front Door/);
  assert.match(out, /Retract <strong>Front Bolt<\/strong>/);
  assert.match(out, /data-df-save/, 'Save button carries the dirty-save hook');
  assert.match(out, /saveDoorFlow\(&quot;Front Door&quot;\)/);
  assert.match(out, /removeDoorFlow\(&quot;Front Door&quot;\)/);
  assert.match(out, /data-dirty-label/, 'unsaved-changes label present');
});

test('the add-deadbolt picker offers only unwired, usable locks (no ghosts)', () => {
  const out = load()('Front Door', flow(), DATA);
  assert.match(out, /value="side_deadbolt"/, 'free paired lock offered');
  assert.ok(!out.includes('value="ghost_bolt"'), 'unpaired ghost never offered');
  const addSel = out.match(/<select id="dfAddLock_[^>]*>[\s\S]*?<\/select>/);
  assert.ok(addSel && !addSel[0].includes('front_deadbolt'), 'already-wired lock not offered again');
});

test('every usable lock wired -> no add picker; none usable -> pair-first hint', () => {
  const both = flow({ retract: [
    { lock_id: 'front_deadbolt', after_unlock: 'lock_default' },
    { lock_id: 'side_deadbolt', after_unlock: 'lock_default' },
  ] });
  const wired = load()('Front Door', both, DATA);
  assert.ok(!wired.includes('dfAddLock_'), 'nothing left to add');
  const noLocks = load()('Front Door', flow({ retract: [] }), { doors: DATA.doors, locks: [] });
  assert.match(noLocks, /Pair one under Deadbolt Devices/, 'empty state deep-links down to the device section');
});

test('cascade appears with 2+ doors and is absent on a single-door site', () => {
  const out = load()('Front Door', flow(), DATA);
  assert.match(out, /cascade/i, 'multi-door site sees the cascade block');
  const single = load()('Front Door', flow(), { doors: [DATA.doors[0]], locks: DATA.locks });
  assert.ok(!/cascade/i.test(single), 'single-door site sees no cascade block (progressive disclosure)');
});

test('the copy separates retract (real lock command) from gating', () => {
  const out = load()('Front Door', flow(), DATA);
  assert.match(out, /real Z-Wave unlock command/, 'retract copy names the physical action');
  assert.match(out, /gate keypad PINs/, 'gating consequence stated where the edge is made');
});

test('an undiscovered door is badged but stays fully editable', () => {
  const data = { doors: [{ name: 'Old Door', id: 'd9', discovered: false }, DATA.doors[1]], locks: DATA.locks };
  const out = load()('Old Door', flow({ door_id: 'd9' }), data);
  assert.match(out, /not discovered/, 'stale door flagged');
  assert.match(out, /data-df-save/, 'still saveable');
});

test('door names are escaped everywhere in the card', () => {
  const data = { doors: [{ name: 'Evil <img src=x>', id: 'd6', discovered: true }], locks: DATA.locks };
  const out = load()('Evil <img src=x>', flow(), data);
  assert.ok(!out.includes('<img src=x>'));
  assert.match(out, /Evil &lt;img src=x&gt;/);
});
