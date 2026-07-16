'use strict';

// Guards buildUnlockAction: one "Unlock a door" action card on a trigger. Each
// action targets ONE door (chosen via the "+ add action" picker) and carries its
// own debounce and delay. It renders nothing for an empty action (a door is
// always chosen on add). When the target is the trigger's own door (doorbell
// buzz-in) it is labeled "(this door)". Extracts the REAL function from
// public/index.html.

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

// signature: buildUnlockAction(door, tIdx, unlock, aIdx)
test('an empty action renders nothing (a door is always chosen on add)', () => {
  assert.equal(load()('Front Door', 0, { doors: [] }, 0), '', 'no door -> no card');
  assert.equal(load()('Front Door', 0, null, 0), '', 'no action -> no card');
});

test('a single-door unlock card names the target door and shows its debounce + delay', () => {
  const out = load()('Front Door', 0, { doors: ['Elevator'], debounce_seconds: 15, delay_seconds: 5 }, 0);
  assert.match(out, /data-df-action="unlock"/, 'it is an unlock action card');
  assert.match(out, /Unlock a door/, 'titled Unlock a door');
  assert.match(out, /Elevator/, 'the one target door is named');
  assert.match(out, /value="15"/, 'saved debounce shown');
  assert.match(out, /value="5"/, 'saved delay shown');
});

test('defaults: 8s debounce and 0s delay when unset', () => {
  const out = load()('Front Door', 0, { doors: ['Interior Door'] }, 0);
  assert.match(out, /value="8"/, 'default debounce');
  assert.match(out, /value="0"/, 'default delay');
});

test('the trigger own door is labeled "(this door)" (doorbell buzz-in)', () => {
  const out = load()('Front Door', 0, { doors: ['Front Door'] }, 0);
  assert.match(out, /Front Door \(this door\)/, 'buzz-in target is obvious');
});

test('another door is not labeled "(this door)"', () => {
  const out = load()('Front Door', 0, { doors: ['Elevator'] }, 0);
  assert.ok(!/\(this door\)/.test(out), 'a different door is just named');
});

test('copy states the safety contract: UniFi unlock only, never a lock command', () => {
  const out = load()('Front Door', 0, { doors: ['Elevator'] }, 0);
  assert.match(out, /never a lock command/);
});

test('debounce/delay inputs are keyed per door, trigger and action so they do not collide', () => {
  const out = load()('Front Door', 2, { doors: ['Elevator'] }, 1);
  assert.match(out, /id="dfDebounce_[^"]*_2_1"/, 'trigger + action indices carried on the debounce input');
  assert.match(out, /id="dfDelay_[^"]*_2_1"/, 'and on the delay input');
});

test('the target door name is escaped', () => {
  const out = load()('Front Door', 0, { doors: ['Evil <img src=x>'] }, 0);
  assert.ok(!out.includes('<img src=x>'));
  assert.match(out, /Evil &lt;img src=x&gt;/);
});
