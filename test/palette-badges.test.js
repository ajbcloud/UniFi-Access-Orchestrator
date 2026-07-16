'use strict';

// Guards the palette-discipline helpers extracted from public/index.html:
// the honest keypad badge (code_present / revoke_pending), the gating notice
// banner, and the card state-stripe helpers. Extracts the real functions via
// the shared extract-and-run harness so the tests track the shipped code.

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
  const src = (deps || '') + '\n' + extractFn(name);
  return new Function(src + '; return ' + name + ';')();
}

const escapeDep = extractFn('escapeHtml');

test('keypadBlockedLabel: reports the honest state', () => {
  const fn = load('keypadBlockedLabel');
  assert.equal(fn({ code_present: true }), 'blocked, code still on lock');
  assert.equal(fn({ revoke_pending: true }), 'blocked, removal pending');
  assert.equal(fn({}), 'blocked, code removed');
  // code_present wins over revoke_pending when both somehow set.
  assert.equal(fn({ code_present: true, revoke_pending: true }), 'blocked, code still on lock');
});

test('keypadLockBadge: blocked badge escapes names and states the outcome', () => {
  const fn = load('keypadLockBadge', escapeDep + '\n' + extractFn('keypadBlockedLabel'));
  const out = fn({ status: 'blocked', code_present: false, revoke_pending: false }, '<b>Lock</b>', 'Door <x>');
  assert.ok(out.includes('blocked, code removed'), 'states the outcome');
  assert.ok(!out.includes('<b>Lock</b>'), 'lock name is escaped');
  assert.ok(!out.includes('Door <x>'), 'door name is escaped');
  assert.ok(out.includes('&lt;b&gt;Lock&lt;/b&gt;'), 'escaped lock name present');
});

test('keypadLockBadge: non-blocked statuses render their own badge', () => {
  const fn = load('keypadLockBadge', escapeDep + '\n' + extractFn('keypadBlockedLabel'));
  assert.ok(fn({ status: 'ok' }, 'Front', null).includes('badge success'));
  assert.ok(fn({ status: 'pending' }, 'Front', null).includes('pending'));
  assert.ok(fn({ status: 'missing' }, 'Front', null).includes('missing'));
});

test('accessGatingBanner: uses the solid notice class, not the old inline badge', () => {
  const fn = load('accessGatingBanner', escapeDep);
  const out = fn({ available: false }, 2);
  assert.ok(out.includes('class="notice notice-warn"'), 'renders the dedicated notice class');
  assert.ok(!out.includes('style="display:block'), 'no inline-styled badge left behind');
  assert.equal(fn({ available: true }, 0), '', 'no banner when nothing is gated');
});

test('cardStateClass / setCardState: map state to a stripe modifier', () => {
  const cardStateClass = load('cardStateClass');
  assert.equal(cardStateClass('fault'), 'card-state-fault');
  assert.equal(cardStateClass('degraded'), 'card-state-degraded');
  assert.equal(cardStateClass(null), '');

  const setCardState = load('setCardState');
  const classes = new Set(['card-state-ok']);
  const el = {
    classList: {
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      add: (c) => classes.add(c),
    },
  };
  setCardState(el, 'fault');
  assert.ok(classes.has('card-state-fault') && !classes.has('card-state-ok'), 'swaps to the new state');
  setCardState(el, null);
  assert.ok(!classes.has('card-state-fault'), 'clears the stripe when state is null');
});
