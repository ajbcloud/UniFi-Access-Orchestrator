'use strict';

// Guards the loading and empty-state helpers, so "still fetching" and "nothing
// configured" render distinctly. Extracts the real functions from index.html.

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

const escapeDep = extractFn('escapeHtml');

test('loadingHtml: renders a spinner with an accessible-hidden glyph and escaped label', () => {
  const fn = load('loadingHtml', escapeDep);
  const out = fn('Loading doors');
  assert.match(out, /class="loading"/);
  assert.match(out, /loading-spinner/);
  assert.match(out, /aria-hidden="true"/);
  assert.match(out, /Loading doors/);
});

test('loadingHtml: defaults the label and escapes it', () => {
  const fn = load('loadingHtml', escapeDep);
  assert.match(fn(), /Loading</);
  assert.ok(!fn('<x>').includes('<x>'), 'label is escaped');
});

test('emptyStateHtml: distinct from loading, escapes the message, keeps the icon', () => {
  const fn = load('emptyStateHtml', escapeDep);
  const out = fn('No rules yet. Add your first rule.', '\u{1F513}');
  assert.match(out, /class="empty-state"/);
  assert.ok(!out.includes('loading-spinner'), 'an empty state is not a loading state');
  assert.match(out, /No rules yet/);
  assert.match(out, /empty-icon/);
  assert.ok(!fn('<script>').includes('<script>'), 'the message is escaped');
});
