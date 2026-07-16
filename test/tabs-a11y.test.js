'use strict';

// Guards the keyboard navigation for the main tab bar: the pure index math and
// the keydown handler that moves focus and activation together. Extracts the
// real functions from public/index.html.

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

test('nextTabIndex: arrow keys wrap, Home/End jump, other keys ignored', () => {
  const nextTabIndex = new Function(extractFn('nextTabIndex') + '; return nextTabIndex;')();
  assert.equal(nextTabIndex('ArrowRight', 0, 6), 1);
  assert.equal(nextTabIndex('ArrowRight', 5, 6), 0, 'wraps forward');
  assert.equal(nextTabIndex('ArrowLeft', 0, 6), 5, 'wraps backward');
  assert.equal(nextTabIndex('ArrowLeft', 3, 6), 2);
  assert.equal(nextTabIndex('Home', 3, 6), 0);
  assert.equal(nextTabIndex('End', 0, 6), 5);
  assert.equal(nextTabIndex('Enter', 2, 6), null, 'unrelated keys are ignored');
});

test('handleTabKeydown: moves focus and activation to the neighbour tab', () => {
  // Build fake tabs and a mock document; stub activateTab to record the target.
  const src = 'let _activated = null;\n'
    + 'function activateTab(t){ _activated = t; }\n'
    + extractFn('nextTabIndex') + '\n'
    + extractFn('handleTabKeydown')
    + '; return { handleTabKeydown, get activated(){ return _activated; } };';
  const tabs = [];
  for (let i = 0; i < 6; i++) tabs.push({ i, focused: false, focus() { this.focused = true; } });
  const document = { querySelectorAll: () => tabs };
  const mod = new Function('document', src)(document);

  let prevented = false;
  mod.handleTabKeydown({ key: 'ArrowRight', currentTarget: tabs[0], preventDefault: () => { prevented = true; } });
  assert.ok(prevented, 'default scroll is prevented');
  assert.ok(tabs[1].focused, 'focus moved to the next tab');
  assert.equal(mod.activated, tabs[1], 'the next tab was activated');
});
