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

// groupNames stubs _getDiscoveredGroupNames so the scope-dropdown path is
// exercisable; the default keeps every no-groups call site unchanged.
function load(groupNames) {
  const src = 'function _getDiscoveredGroupNames() { return ' + JSON.stringify(groupNames || []) + '; }\n'
    + extractFn('escapeHtml') + '\n' + extractFn('cssId') + '\n' + extractFn('_dfGroups')
    + '\n' + extractFn('_scopeToValue')
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
  assert.match(out, /badges in/, 'a no-groups site shows the plain badge-in trigger');
  assert.match(out, /everyone/, 'no-groups scope shows static everyone text');
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
  assert.match(noLocks, /no deadbolt is paired yet/i, 'empty state names the missing hardware');
  assert.match(noLocks, /Devices tab/, 'the hint points at the Devices tab');
  assert.match(noLocks, /openDeadboltTab\(\)/, 'the hint links to the Devices tab');
});

test('the unlock-other-doors action appears once added and is absent on a single-door site', () => {
  const withUnlock = flow({ triggers: [{ type: 'entry', scope: null, actions: { unlock: { doors: [] }, retract: [] } }] });
  const out = load()('Front Door', withUnlock, DATA);
  assert.match(out, /data-df-action="unlock"/, 'multi-door site sees the unlock action once added');
  const single = load()('Front Door', withUnlock, { doors: [DATA.doors[0]], locks: DATA.locks });
  assert.ok(!/data-df-action="unlock"/.test(single), 'single-door site sees no unlock action (nowhere to unlock to)');
  const notAdded = load()('Front Door', flow(), DATA);
  assert.ok(!/data-df-action="unlock"/.test(notAdded), 'the action is opt-in: not shown until added via + add action');
});

test('with groups, entry reads "[scope] badges in" and the doorbell scope option is "anyone"', () => {
  const out = load(['Staff', 'Visitors'])('Front Door', flow(), DATA);
  assert.match(out, /id="dfScope_/, 'the scope dropdown renders when groups exist');
  assert.match(out, /badges in/, 'the type chip reads badges in');
  assert.ok(!out.includes('taps in'), 'the redundant taps-in sentence is gone');
  const doorbellFlow = flow({ triggers: [{ type: 'doorbell', scope: null, doorbell: { reason_code: 107, viewer_to_group: {} }, actions: { unlock: null, retract: [] } }] });
  const bell = load(['Staff'])('Front Door', doorbellFlow, DATA);
  assert.match(bell, />anyone</, 'doorbell scope offers anyone');
  assert.ok(!bell.includes('anyone who answers'), 'never reads "anyone who answers answers"');
  assert.match(bell, /rings and/, 'doorbell reads: doorbell rings and [scope] answers');
});

test('the doorbell advanced expander explains the reason code in plain language', () => {
  const doorbellFlow = flow({ triggers: [{ type: 'doorbell', scope: null, doorbell: { reason_code: 107, viewer_to_group: {} }, actions: { unlock: null, retract: [] } }] });
  const out = load()('Front Door', doorbellFlow, DATA);
  assert.match(out, /Reason code is the event code UniFi sends/);
  assert.match(out, /107, means an admin unlocked the door/);
});

test('single-door site with no deadbolt: the chooser still shows both options with reasons', () => {
  const single = load()('Front Door', flow({ triggers: [entryTrigger([])] }), { doors: [DATA.doors[0]], locks: [] });
  assert.match(single, /\+ add action/, 'the add-action control is always present');
  assert.match(single, /no other doors are set up in UniFi yet/, 'the unlock option explains why it is empty');
  assert.match(single, /no deadbolt is paired yet/i, 'the retract option explains why it is empty');
  assert.match(single, /openDeadboltTab\(\)/, 'and links to the Devices tab');
});

test('both actions in use: the chooser marks each done, and retract + unlock still render together', () => {
  const maxed = flow({ triggers: [{
    type: 'entry', scope: null,
    actions: {
      unlock: [{ doors: ['Interior Door'] }],
      retract: [
        { lock_id: 'front_deadbolt', after_unlock: 'stay_unlocked' },
        { lock_id: 'side_deadbolt', after_unlock: 'stay_unlocked' },
      ],
    },
  }] });
  const out = load()('Front Door', maxed, DATA);
  assert.match(out, /\+ add action/, 'the control stays present');
  assert.match(out, /Add another/, 'unlock actions stack: another one is always addable');
  assert.match(out, /every paired deadbolt is already retracting/, 'retract is shown as exhausted');
  // multiple actions genuinely coexist in one trigger
  assert.match(out, /Retract deadbolt/);
  assert.match(out, /data-df-action="unlock"/);
  assert.match(out, /Front Bolt/);
  assert.match(out, /Side Bolt/);
});

test('a doorbell trigger can unlock its own door (buzz-in), labeled this door', () => {
  const bell = flow({ triggers: [{ type: 'doorbell', scope: null, doorbell: { reason_code: 107, viewer_to_group: {} }, actions: { unlock: { doors: [] }, retract: [] } }] });
  const out = load()('Front Door', bell, { doors: [DATA.doors[0]], locks: DATA.locks });
  assert.match(out, /data-df-action="unlock"/, 'the unlock card renders on a single-door doorbell site');
  assert.match(out, /Front Door \(this door\)/, 'the trigger door is offered and labeled');
});

test('an entry trigger never offers its own door to unlock', () => {
  const withUnlock = flow({ triggers: [{ type: 'entry', scope: null, actions: { unlock: { doors: [] }, retract: [] } }] });
  const single = load()('Front Door', withUnlock, { doors: [DATA.doors[0]], locks: DATA.locks });
  assert.ok(!/data-df-action="unlock"/.test(single), 'entry on a single-door site has nothing to unlock');
});

test('a door can hold multiple triggers of the same type, each scoped', () => {
  const two = flow({ triggers: [
    { type: 'doorbell', scope: { groups: ['Staff'] }, doorbell: { reason_code: 107, viewer_to_group: {} }, actions: { unlock: { doors: ['Interior Door'] }, retract: [] } },
    { type: 'doorbell', scope: { groups: ['Visitors'] }, doorbell: { reason_code: 107, viewer_to_group: {} }, actions: { unlock: { doors: [] }, retract: [] } },
  ] });
  const out = load(['Staff', 'Visitors'])('Front Door', two, DATA);
  assert.match(out, /data-df-trig="0"/, 'first doorbell trigger renders');
  assert.match(out, /data-df-trig="1"/, 'second doorbell trigger renders');
  assert.ok(!/addTrigger\(&quot;Front Door&quot;, 'entry'\)/.test(out), 'no badge-in add button (every flow starts with one)');
  assert.match(out, /addTrigger\(&quot;Front Door&quot;, 'doorbell'\)/, 'doorbell trigger always addable');
  assert.match(out, /more than one doorbell rule/, 'the scope hint appears when a type repeats and groups exist');
});

test('a fresh trigger opens the action chooser; a trigger with an action collapses it', () => {
  const empty = load()('Front Door', flow({ triggers: [entryTrigger([])] }), DATA);
  const openMenu = empty.match(/<div id="dfAddMenu_[^"]*"[^>]*>/)[0];
  assert.ok(!/display:none/.test(openMenu), 'no actions yet -> chooser is open');
  const withAction = load()('Front Door', flow(), DATA); // flow() has a retract edge
  const closedMenu = withAction.match(/<div id="dfAddMenu_[^"]*"[^>]*>/)[0];
  assert.ok(/display:none/.test(closedMenu), 'an action present -> chooser tucked behind the button');
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
