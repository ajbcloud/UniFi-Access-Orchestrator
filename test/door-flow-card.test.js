'use strict';

// Guards buildDoorFlowCard: one card per configured door ("everything starts
// at the door"). The card holds one or more TRIGGERS (entry + doorbell), each
// with a scope and actions (retract deadbolts, unlock other doors). On a simple
// site with no groups the scope control is hidden. Extracts the REAL functions
// from public/index.html.

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
  const src = extractFn('escapeHtml') + '\n' + extractFn('cssId') + '\n' + extractFn('_dfGroups')
    + '\n' + extractFn('buildRetractEdgeRow') + '\n' + extractFn('buildUnlockAction')
    + '\n' + extractFn('buildTriggerBlock') + '\n' + extractFn('buildDoorFlowCard');
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

function entryTrigger(retract) {
  return { type: 'entry', scope: null, actions: { unlock: null, retract: retract || [] } };
}
function flow(overrides = {}) {
  return Object.assign({
    door_id: 'd1',
    triggers: [entryTrigger([{ lock_id: 'front_deadbolt', after_unlock: 'stay_unlocked', require_result: 'ACCESS', mirror_unlock: false, relock_cooldown_seconds: 10 }])],
  }, overrides);
}

test('a card carries the door name, its trigger, edges, Save, and Remove Flow', () => {
  const out = load()('Front Door', flow(), DATA);
  assert.match(out, /Front Door/);
  assert.match(out, /taps in/, 'a no-groups site shows the plain tap-in trigger');
  assert.match(out, /Retract deadbolt/, 'the retract action is titled');
  assert.match(out, /Front Bolt/, 'the retracted lock is named');
  assert.match(out, /data-df-save/, 'Save button carries the dirty-save hook');
  assert.match(out, /saveDoorFlow\(&quot;Front Door&quot;\)/);
  assert.match(out, /removeDoorFlow\(&quot;Front Door&quot;\)/);
  assert.match(out, /data-dirty-label/, 'unsaved-changes label present');
});

test('an add-trigger control appends a doorbell trigger', () => {
  const out = load()('Front Door', flow(), DATA);
  assert.match(out, /addTrigger\(&quot;Front Door&quot;, 'doorbell'\)/);
  assert.match(out, /doorbell trigger/i);
});

test('the add-deadbolt picker offers only unwired, usable locks (no ghosts)', () => {
  const out = load()('Front Door', flow(), DATA);
  assert.match(out, /value="side_deadbolt"/, 'free paired lock offered');
  assert.ok(!out.includes('value="ghost_bolt"'), 'unpaired ghost never offered');
  const addSel = out.match(/<select id="dfAddLock_[^>]*>[\s\S]*?<\/select>/);
  assert.ok(addSel && !addSel[0].includes('front_deadbolt'), 'already-wired lock not offered again');
  assert.match(out, /addRetractEdge\(&quot;Front Door&quot;, 0\)/, 'add targets this door + trigger 0');
});

test('every usable lock wired -> no add picker; none usable -> pair-first hint', () => {
  const both = flow({ triggers: [entryTrigger([
    { lock_id: 'front_deadbolt', after_unlock: 'stay_unlocked' },
    { lock_id: 'side_deadbolt', after_unlock: 'stay_unlocked' },
  ])] });
  const wired = load()('Front Door', both, DATA);
  assert.ok(!wired.includes('dfAddLock_'), 'nothing left to add');
  const noLocks = load()('Front Door', flow({ triggers: [entryTrigger([])] }), { doors: DATA.doors, locks: [] });
  assert.match(noLocks, /No deadbolt is paired yet/, 'empty state names the missing hardware');
  assert.match(noLocks, /Deadbolt Devices tab/, 'the hint points at the device tab');
  assert.match(noLocks, /openDeadboltTab\(\)/, 'the hint links to the Deadbolt Devices tab');
});

test('the unlock-other-doors action appears once added and is absent on a single-door site', () => {
  const withUnlock = flow({ triggers: [{ type: 'entry', scope: null, actions: { unlock: { doors: [] }, retract: [] } }] });
  const out = load()('Front Door', withUnlock, DATA);
  assert.match(out, /Unlock other doors/, 'multi-door site sees the unlock action once added');
  const single = load()('Front Door', withUnlock, { doors: [DATA.doors[0]], locks: DATA.locks });
  assert.ok(!/Unlock other doors/.test(single), 'single-door site sees no unlock action (nowhere to unlock to)');
  const notAdded = load()('Front Door', flow(), DATA);
  assert.ok(!/Unlock other doors/.test(notAdded), 'the action is opt-in: not shown until added via + add action');
});

test('the inline gating note points at Keypad Users when a deadbolt retracts', () => {
  const out = load()('Front Door', flow(), DATA);
  assert.match(out, /follow UniFi access to <strong>Front Door<\/strong>/, 'gating stated where it is caused');
  assert.match(out, /openKeypadTab\(\)/, 'links to the Keypad Users tab');
  const noRetract = load()('Front Door', flow({ triggers: [entryTrigger([])] }), DATA);
  assert.ok(!/follow UniFi access/.test(noRetract), 'no gating note without a retract');
});

test('a summary chip counts the deadbolts and doors', () => {
  const out = load()('Front Door', flow(), DATA);
  assert.match(out, /1 deadbolt/);
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
