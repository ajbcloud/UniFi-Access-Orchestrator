'use strict';

// Guards the in-page authorization dialog that gates sensitive keypad ops.
// Extracts the REAL promptForAuthPin from public/index.html with the same
// extract-and-run harness the other dashboard tests use.

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

// Build a minimal DOM around the modal, with two mode radios.
function loadPrompt() {
  const radios = [
    { value: 'admin', checked: true },
    { value: 'current', checked: false },
  ];
  const modal = {
    style: { display: 'none' },
    querySelectorAll: () => radios,
    querySelector: (sel) => (sel.includes(':checked') ? radios.find((r) => r.checked) || null : null),
  };
  const els = {
    authPinModal: modal,
    authPinModalTitle: { textContent: '' },
    authPinModalMessage: { textContent: '' },
    authPinModeRow: { style: { display: 'none' } },
    authPinModalInput: { value: '', focus() {}, onkeydown: null },
    authPinModalConfirm: { onclick: null },
    authPinModalCancel: { onclick: null },
  };
  const document = { getElementById: (id) => els[id] || null };
  const src = 'let _authPinBusy = false;\nfunction toast(){}\n' + extractFn('promptForAuthPin');
  const factory = new Function('document', src + '; return promptForAuthPin;');
  return { promptForAuthPin: factory(document), els, radios };
}

test('admin-only prompt hides the mode row and returns the admin PIN', async () => {
  const { promptForAuthPin, els } = loadPrompt();
  const p = promptForAuthPin({ title: 'Authorize removal', allowCurrentPin: false });
  assert.strictEqual(els.authPinModal.style.display, 'flex');
  assert.strictEqual(els.authPinModeRow.style.display, 'none', 'no mode choice when current PIN is not allowed');
  els.authPinModalInput.value = '246810';
  els.authPinModalConfirm.onclick();
  assert.deepStrictEqual(await p, { mode: 'admin', pin: '246810' });
  assert.strictEqual(els.authPinModal.style.display, 'none');
});

test('allowCurrentPin shows the mode row and honors the current-PIN choice', async () => {
  const { promptForAuthPin, els, radios } = loadPrompt();
  const p = promptForAuthPin({ allowCurrentPin: true });
  assert.strictEqual(els.authPinModeRow.style.display, 'block');
  // user switches to "this user's current PIN"
  radios[0].checked = false;
  radios[1].checked = true;
  els.authPinModalInput.value = '4321';
  els.authPinModalConfirm.onclick();
  assert.deepStrictEqual(await p, { mode: 'current', pin: '4321' });
});

test('Enter submits and Escape cancels', async () => {
  const { promptForAuthPin, els } = loadPrompt();
  const p1 = promptForAuthPin({ allowCurrentPin: true });
  els.authPinModalInput.value = '112233';
  els.authPinModalInput.onkeydown({ key: 'Enter' });
  assert.deepStrictEqual(await p1, { mode: 'admin', pin: '112233' });

  const p2 = promptForAuthPin({});
  els.authPinModalInput.onkeydown({ key: 'Escape' });
  assert.strictEqual(await p2, null);
});

test('Cancel resolves null and a concurrent call is turned away', async () => {
  const { promptForAuthPin, els } = loadPrompt();
  const p1 = promptForAuthPin({});
  const p2 = promptForAuthPin({}); // busy -> null immediately
  assert.strictEqual(await p2, null);
  els.authPinModalCancel.onclick();
  assert.strictEqual(await p1, null);
});

test('missing modal elements degrade to resolve(null), never throw', async () => {
  const src = 'let _authPinBusy = false;\nfunction toast(){}\n' + extractFn('promptForAuthPin');
  const document = { getElementById: () => null };
  const factory = new Function('document', src + '; return promptForAuthPin;');
  const promptForAuthPin = factory(document);
  assert.strictEqual(await promptForAuthPin({}), null);
});
