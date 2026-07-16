'use strict';

// Guards buildUnlockAction: the "unlock other doors" action of a trigger on a
// door card. It momentarily unlocks OTHER UniFi doors (never a lock command),
// so the checklist must exclude the door itself. The action is opt-in: it only
// renders once the trigger has an unlock object (added via "+ add action"), and
// it vanishes when there is nowhere to unlock to. It also carries a debounce and
// a delay. Extracts the REAL function from public/index.html.

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
  const src = extractFn('escapeHtml') + '\n' + extractFn('cssId') + '\n' + extractFn('buildUnlockAction');
  return new Function(src + '; return buildUnlockAction;')();
}

const DOORS = [
  { name: 'Front Door', id: 'd1', discovered: true },
  { name: 'Interior Door', id: 'd2', discovered: true },
  { name: 'Elevator', id: 'd3', discovered: true },
];

// signature: buildUnlockAction(door, tIdx, unlock, doors)
test('one known door -> no unlock action (nowhere to unlock to)', () => {
  const out = load()('Front Door', 0, { doors: [] }, [DOORS[0]]);
  assert.equal(out, '', 'a single-door site never sees the unlock action');
});

test('the unlock action is opt-in: no unlock object -> nothing rendered', () => {
  const out = load()('Front Door', 0, null, DOORS);
  assert.equal(out, '', 'even with other doors, the action only appears once added via + add action');
});

test('the checklist offers every OTHER door, never the trigger itself', () => {
  const out = load()('Front Door', 0, { doors: [] }, DOORS);
  assert.match(out, /value="Interior Door"/);
  assert.match(out, /value="Elevator"/, 'the elevator is just another door in the list');
  assert.ok(!out.includes('value="Front Door"'), 'a door cannot unlock itself');
});

test('an existing unlock action pre-checks its doors and shows its debounce + delay', () => {
  const out = load()('Front Door', 0, { doors: ['Elevator'], debounce_seconds: 15, delay_seconds: 5 }, DOORS);
  assert.match(out, /value="Elevator" checked/, 'saved target checked');
  assert.ok(!/value="Interior Door" checked/.test(out), 'unselected door unchecked');
  assert.match(out, /value="15"/, 'saved debounce shown');
  assert.match(out, /value="5"/, 'saved delay shown');
});

test('a freshly added unlock action -> nothing checked, default 8s debounce and 0s delay', () => {
  const out = load()('Front Door', 0, { doors: [] }, DOORS);
  assert.ok(!out.includes(' checked'), 'nothing pre-checked');
  assert.match(out, /value="8"/, 'default debounce');
  assert.match(out, /value="0"/, 'default delay');
});

test('copy states the safety contract: UniFi unlock only, never a lock command', () => {
  const out = load()('Front Door', 0, { doors: [] }, DOORS);
  assert.match(out, /never a lock command/);
});

test('checkboxes are keyed per door and trigger so distinct triggers do not collide', () => {
  const out = load()('Front Door', 2, { doors: ['Elevator'] }, DOORS);
  assert.match(out, /data-df-trig="2"/, 'the trigger index is carried on each checkbox');
  assert.match(out, /class="df-unlock-door"/);
});

test('door names are escaped in the checklist', () => {
  const doors = [{ name: 'Front Door', id: 'd1' }, { name: 'Evil <img src=x>', id: 'd2' }];
  const out = load()('Front Door', 0, { doors: [] }, doors);
  assert.ok(!out.includes('<img src=x>'));
  assert.match(out, /Evil &lt;img src=x&gt;/);
});
