'use strict';

// Guards the in-page admin-key dialog that replaced window.prompt (Electron
// renderers do not implement prompt(), which broke first run on the packaged
// app). Extracts the REAL functions from public/index.html via the same
// extractFn harness dashboard-render.test.js uses, so these tests track the
// shipped code.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

// ---------------------------------------------------------------------------
// promptForApiKey: single-flight modal
// ---------------------------------------------------------------------------

function loadPrompt() {
  // Recreate the module-level singleton the function closes over.
  const src = 'let _apiKeyPrompt = null;\n' + extractFn('promptForApiKey');
  const els = {
    apiKeyModal: { style: { display: 'none' } },
    apiKeyModalInput: { value: '', focus() {}, onkeydown: null },
    apiKeyModalSave: { onclick: null },
    apiKeyModalCancel: { onclick: null },
  };
  const document = { getElementById: (id) => els[id] || null };
  const factory = new Function('document', src + '; return promptForApiKey;');
  return { promptForApiKey: factory(document), els };
}

test('concurrent calls share one modal and one promise', async () => {
  const { promptForApiKey, els } = loadPrompt();
  const p1 = promptForApiKey();
  const p2 = promptForApiKey();
  assert.strictEqual(p1, p2, 'second caller must receive the same promise');
  assert.strictEqual(els.apiKeyModal.style.display, 'flex');
  els.apiKeyModalInput.value = '  the-key  ';
  els.apiKeyModalSave.onclick();
  assert.strictEqual(await p1, 'the-key'); // trimmed
  assert.strictEqual(await p2, 'the-key');
  assert.strictEqual(els.apiKeyModal.style.display, 'none');
});

test('Enter submits, and the singleton resets for a fresh prompt', async () => {
  const { promptForApiKey, els } = loadPrompt();
  const p1 = promptForApiKey();
  els.apiKeyModalInput.value = 'abc123';
  els.apiKeyModalInput.onkeydown({ key: 'Enter' });
  assert.strictEqual(await p1, 'abc123');
  // a new call opens a NEW prompt (not the settled one)
  const p2 = promptForApiKey();
  assert.notStrictEqual(p1, p2);
  assert.strictEqual(els.apiKeyModal.style.display, 'flex');
  els.apiKeyModalCancel.onclick();
  assert.strictEqual(await p2, null);
});

test('Escape and Cancel resolve null; empty input resolves null', async () => {
  const { promptForApiKey, els } = loadPrompt();
  const p1 = promptForApiKey();
  els.apiKeyModalInput.onkeydown({ key: 'Escape' });
  assert.strictEqual(await p1, null);

  const p2 = promptForApiKey();
  els.apiKeyModalInput.value = '   ';
  els.apiKeyModalSave.onclick();
  assert.strictEqual(await p2, null); // whitespace-only treated as cancel
});

test('missing modal elements degrade to resolve(null), never throw', async () => {
  const src = 'let _apiKeyPrompt = null;\n' + extractFn('promptForApiKey');
  const document = { getElementById: () => null };
  const factory = new Function('document', src + '; return promptForApiKey;');
  const promptForApiKey = factory(document);
  assert.strictEqual(await promptForApiKey(), null);
});

// ---------------------------------------------------------------------------
// getApiKey precedence: localStorage first, desktop bridge fallback, then ''
// ---------------------------------------------------------------------------

function loadGetApiKey({ stored, bridgeKey }) {
  const src = extractFn('getApiKey');
  const localStorage = { getItem: () => (stored === undefined ? null : stored) };
  const window = bridgeKey === undefined
    ? {}
    : { orchestratorDesktop: { getAdminApiKey: () => bridgeKey } };
  const factory = new Function('localStorage', 'window', src + '; return getApiKey;');
  return factory(localStorage, window);
}

test('getApiKey: localStorage wins over the bridge', () => {
  assert.strictEqual(loadGetApiKey({ stored: 'local-key', bridgeKey: 'bridge-key' })(), 'local-key');
});

test('getApiKey: bridge fills in when localStorage is empty', () => {
  assert.strictEqual(loadGetApiKey({ stored: null, bridgeKey: 'bridge-key' })(), 'bridge-key');
});

test('getApiKey: empty everywhere yields empty string', () => {
  assert.strictEqual(loadGetApiKey({ stored: null })(), '');
  assert.strictEqual(loadGetApiKey({ stored: null, bridgeKey: '' })(), '');
});

test('getApiKey: a throwing bridge is contained', () => {
  const src = extractFn('getApiKey');
  const factory = new Function('localStorage', 'window', src + '; return getApiKey;');
  const getApiKey = factory(
    { getItem: () => null },
    { orchestratorDesktop: { getAdminApiKey: () => { throw new Error('ipc dead'); } } }
  );
  assert.strictEqual(getApiKey(), '');
});

// ---------------------------------------------------------------------------
// Whole-inline-script syntax guard for the single-file SPA
// ---------------------------------------------------------------------------

test('the dashboard inline script parses as valid JavaScript', () => {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m; let blocks = 0;
  while ((m = re.exec(html))) {
    blocks++;
    assert.doesNotThrow(() => new vm.Script(m[1]), `script block ${blocks} must parse`);
  }
  assert.ok(blocks >= 1, 'expected at least one inline script block');
});

// window.prompt must never come back: it is not implemented in Electron.
// Match actual invocations only (comments may mention it).
test('no window.prompt call remains in the dashboard', () => {
  assert.strictEqual(/window\.prompt\(/.test(html), false);
});
