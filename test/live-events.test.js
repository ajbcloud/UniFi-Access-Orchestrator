'use strict';

// Guards the Live Events rewrite: plain-language narration, outcome
// classification, the skipped-run label, and the filter predicate. All are
// pure named functions extracted from public/index.html.

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

function load(name, deps) {
  return new Function((deps || '') + '\n' + extractFn(name) + '; return ' + name + ';')();
}

test('narrateEvent: names who, where, and what for a normal entry', () => {
  const fn = load('narrateEvent');
  assert.equal(
    fn({ type: 'access.door.unlock', actor: 'Kim', location: 'Stairwell', action: 'Unlocked Elevator', success: true }),
    'Kim badged in at Stairwell, Unlocked Elevator.'
  );
});

test('narrateEvent: degrades gracefully with no actor or location', () => {
  const fn = load('narrateEvent');
  assert.equal(fn({ type: 'access.door.unlock' }), 'Someone badged in.');
  assert.equal(fn({ type: 'access.doorbell.call', location: 'Main' }), 'A visitor rang the doorbell at Main.');
});

test('narrateEvent: marks a failure', () => {
  const fn = load('narrateEvent');
  const out = fn({ type: 'system.reload', action: 'Reload failed', success: false });
  assert.match(out, /It failed\.$/);
});

test('classifyEventRow: failed, skipped, and actioned buckets', () => {
  const fn = load('classifyEventRow');
  assert.equal(fn({ success: false }), 'failed');
  assert.equal(fn({ action: 'Skipped: no group resolved' }), 'skipped');
  assert.equal(fn({ action: 'No rules matched' }), 'skipped');
  assert.equal(fn({ action: 'Unlocked Inner Door', success: true }), 'actioned');
});

test('skippedGroupLabel: pluralizes', () => {
  const fn = load('skippedGroupLabel');
  assert.equal(fn(1), '1 skipped event, show');
  assert.equal(fn(3), '3 skipped events, show');
});

test('eventMatchesFilters: outcome, door, and text search', () => {
  const matches = load('eventMatchesFilters', extractFn('classifyEventRow') + '\n' + extractFn('narrateEvent'));
  const actioned = { type: 'access.door.unlock', actor: 'Kim', location: 'Stairwell', action: 'Unlocked Elevator', success: true };
  const skipped = { type: 'access.door.unlock', location: 'Garage', action: 'Skipped: no group resolved' };

  // Default "actioned" hides skipped and failed.
  assert.equal(matches(actioned, { kind: 'actioned' }), true);
  assert.equal(matches(skipped, { kind: 'actioned' }), false);
  // "all" shows everything.
  assert.equal(matches(skipped, { kind: 'all' }), true);
  // Door filter.
  assert.equal(matches(actioned, { kind: 'all', door: 'Stairwell' }), true);
  assert.equal(matches(actioned, { kind: 'all', door: 'Garage' }), false);
  // Text search runs against the narration.
  assert.equal(matches(actioned, { kind: 'all', text: 'elevator' }), true);
  assert.equal(matches(actioned, { kind: 'all', text: 'nope' }), false);
});
