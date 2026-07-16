'use strict';

// Guards the in-page confirm dialog that replaced window.confirm (native
// confirm in Electron leaves the renderer's form controls unresponsive after
// it returns until the window regains focus; the door picker needed a page
// refresh after Remove Flow to become selectable again). Extracts the REAL
// confirmInApp from public/index.html via the same extractFn harness
// api-key-modal.test.js uses.

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
  // Recreate the module-level busy flag the function closes over.
  const src = 'let _confirmBusy = false;\n' + extractFn('confirmInApp');
  const els = {
    confirmModal: { style: { display: 'none' }, onkeydown: null },
    confirmModalTitle: { textContent: '', style: { display: 'none' } },
    confirmModalMessage: { textContent: '' },
    confirmModalConfirm: { textContent: '', className: '', onclick: null },
    confirmModalCancel: { textContent: '', onclick: null, focus() {} },
  };
  const document = { getElementById: (id) => els[id] || null };
  const factory = new Function('document', src + '; return confirmInApp;');
  return { confirmInApp: factory(document), els };
}

test('confirm resolves true; the message is rendered as text, never markup', async () => {
  const { confirmInApp, els } = load();
  const p = confirmInApp('Remove "Front <b>Door</b>"?\n\nIts deadbolts stop retracting.', { confirmLabel: 'Remove', danger: true });
  assert.strictEqual(els.confirmModal.style.display, 'flex');
  assert.strictEqual(els.confirmModalMessage.textContent, 'Remove "Front <b>Door</b>"?\n\nIts deadbolts stop retracting.',
    'raw string stored via textContent so embedded markup can never execute');
  assert.strictEqual(els.confirmModalConfirm.textContent, 'Remove');
  assert.match(els.confirmModalConfirm.className, /btn-danger/, 'danger swaps the confirm button style');
  els.confirmModalConfirm.onclick();
  assert.strictEqual(await p, true);
  assert.strictEqual(els.confirmModal.style.display, 'none');
});

test('cancel resolves false and tears the handlers down', async () => {
  const { confirmInApp, els } = load();
  const p = confirmInApp('Proceed?');
  assert.strictEqual(els.confirmModalConfirm.textContent, 'OK', 'default confirm label');
  assert.match(els.confirmModalConfirm.className, /btn-primary/, 'non-danger keeps the primary style');
  els.confirmModalCancel.onclick();
  assert.strictEqual(await p, false);
  assert.strictEqual(els.confirmModal.onkeydown, null, 'keydown handler removed');
  assert.strictEqual(els.confirmModalConfirm.onclick, null, 'confirm handler removed');
});

test('Escape declines and stops the event from reaching page-level shortcuts', async () => {
  const { confirmInApp, els } = load();
  const p = confirmInApp('Delete this rule?');
  let stopped = 0;
  els.confirmModal.onkeydown({ key: 'Escape', stopPropagation: () => { stopped++; } });
  assert.strictEqual(await p, false);
  assert.strictEqual(stopped, 1, 'stopPropagation called so the designer\'s Escape handling cannot double-fire');
});

test('a concurrent call is turned away with false, not given the first dialog\'s answer', async () => {
  const { confirmInApp, els } = load();
  const first = confirmInApp('Remove flow A?');
  const second = confirmInApp('Remove flow B?');
  assert.strictEqual(await second, false, 'second question never proceeds on the first prompt');
  assert.strictEqual(els.confirmModalMessage.textContent, 'Remove flow A?', 'first dialog untouched');
  els.confirmModalConfirm.onclick();
  assert.strictEqual(await first, true);
  // and after settling, a fresh call opens normally
  const third = confirmInApp('Remove flow C?');
  assert.strictEqual(els.confirmModalMessage.textContent, 'Remove flow C?');
  els.confirmModalCancel.onclick();
  assert.strictEqual(await third, false);
});

test('title stays hidden by default and shows only when provided', async () => {
  const { confirmInApp, els } = load();
  const p1 = confirmInApp('No title here.');
  assert.strictEqual(els.confirmModalTitle.style.display, 'none');
  els.confirmModalCancel.onclick();
  await p1;
  const p2 = confirmInApp('Titled.', { title: 'Careful' });
  assert.strictEqual(els.confirmModalTitle.style.display, '');
  assert.strictEqual(els.confirmModalTitle.textContent, 'Careful');
  els.confirmModalCancel.onclick();
  await p2;
});

test('missing modal elements degrade to resolve(false), never throw', async () => {
  const src = 'let _confirmBusy = false;\n' + extractFn('confirmInApp');
  const document = { getElementById: () => null };
  const factory = new Function('document', src + '; return confirmInApp;');
  const confirmInApp = factory(document);
  assert.strictEqual(await confirmInApp('anything'), false);
});

// window.confirm must never come back: in Electron it leaves form controls
// unresponsive until the window refocuses. Match actual invocations only
// (confirmInApp( and confirmRealUnlock( do not match this pattern).
test('no native confirm call remains in the dashboard', () => {
  assert.strictEqual(/\bconfirm\(/.test(html), false);
});
