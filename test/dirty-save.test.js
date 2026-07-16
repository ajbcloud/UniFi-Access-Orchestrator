'use strict';

// Guards the dirty-state Save model: a section's Save button stays visible but
// is disabled until something in the section changes, and an "Unsaved changes"
// label appears while dirty. Re-arming after a save disables it again. Extracts
// the REAL helpers from public/index.html with the shared extract-and-run
// harness.

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

// Minimal scope/button mock: the scope persists across "re-renders" (like the
// real container divs), the button can be swapped out (like innerHTML does).
// The scope resolves the button selector and the [data-dirty-label] element.
function makeDom() {
  let button = { disabled: false };
  const label = { style: { display: '' } };
  const listeners = { input: [], change: [] };
  const scope = {
    querySelector: (sel) => (sel === '[data-dirty-label]' ? label : button),
    addEventListener: (evt, fn) => { listeners[evt].push(fn); },
  };
  const document = { querySelector: (sel) => (sel === '#scope' ? scope : null) };
  return {
    document,
    scope,
    listeners,
    label,
    getButton: () => button,
    replaceButton: () => { button = { disabled: false }; return button; },
    fire: (evt) => listeners[evt].forEach((fn) => fn()),
  };
}

function loadHelpers(dom) {
  const src = extractFn('armDirtySave') + '\n' + extractFn('markSectionDirty');
  const factory = new Function('document', src + '; return { armDirtySave, markSectionDirty };');
  return factory(dom.document);
}

test('arming disables the button and hides the label; an edit enables both; re-arm resets', () => {
  const dom = makeDom();
  const { armDirtySave } = loadHelpers(dom);

  armDirtySave('#scope', 'button');
  assert.strictEqual(dom.getButton().disabled, true, 'disabled until dirty');
  assert.strictEqual(dom.label.style.display, 'none', 'label hidden until dirty');

  dom.fire('input');
  assert.strictEqual(dom.getButton().disabled, false, 'enabled after an edit');
  assert.strictEqual(dom.label.style.display, '', 'unsaved label shown after an edit');

  armDirtySave('#scope', 'button'); // section re-rendered after a save
  assert.strictEqual(dom.getButton().disabled, true, 'disabled again after re-arm');
  assert.strictEqual(dom.label.style.display, 'none', 'label hidden again after re-arm');
});

test('listeners attach once per scope even when re-armed many times', () => {
  const dom = makeDom();
  const { armDirtySave } = loadHelpers(dom);
  armDirtySave('#scope', 'button');
  armDirtySave('#scope', 'button');
  armDirtySave('#scope', 'button');
  assert.strictEqual(dom.listeners.input.length, 1, 'one input listener');
  assert.strictEqual(dom.listeners.change.length, 1, 'one change listener');
});

test('a change event on a re-rendered button still enables the fresh button', () => {
  const dom = makeDom();
  const { armDirtySave } = loadHelpers(dom);
  armDirtySave('#scope', 'button');
  const fresh = dom.replaceButton(); // innerHTML re-render swapped the button
  fresh.disabled = true;
  dom.fire('change');
  assert.strictEqual(fresh.disabled, false, 'the listener re-queries the button');
});

test('markSectionDirty force-enables the button (programmatic row add/remove)', () => {
  const dom = makeDom();
  const { armDirtySave, markSectionDirty } = loadHelpers(dom);
  armDirtySave('#scope', 'button');
  assert.strictEqual(dom.getButton().disabled, true);
  markSectionDirty('#scope', 'button');
  assert.strictEqual(dom.getButton().disabled, false);
});

test('missing scope or button never throws', () => {
  const dom = makeDom();
  const { armDirtySave, markSectionDirty } = loadHelpers(dom);
  assert.doesNotThrow(() => armDirtySave('#nope', 'button'));
  assert.doesNotThrow(() => markSectionDirty('#nope', 'button'));
});
