'use strict';

// Guards two desktop UX fixes in public/index.html, using the same
// extract-and-run harness as the other dashboard tests:
//   1. setPairPanel: the pairing status poll must not destroy the PIN input
//      the user is typing into (it rewrote the panel every 1.5s before).
//   2. updateStatus: the in-app status pill mapping must match the Electron
//      window title mapping so they never contradict each other.

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

// ---------------------------------------------------------------------------
// setPairPanel: skip unchanged writes, preserve the PIN input across a rewrite
// ---------------------------------------------------------------------------

// A mock DOM that models the real browser behavior: assigning panel.innerHTML
// destroys the old subtree and (only if the new HTML declares the input) makes
// a fresh, blank #zwavePinInput. Focus is lost on any rewrite.
function makeDom() {
  let currentInput = null;
  let activeEl = null;
  let writes = 0;

  function makeInput() {
    const inp = {
      value: '',
      selectionStart: 0,
      selectionEnd: 0,
      focus() { activeEl = inp; },
      setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; }
    };
    return inp;
  }

  const panel = {
    _html: '',
    set innerHTML(v) {
      writes++;
      this._html = v;
      currentInput = (typeof v === 'string' && v.indexOf('zwavePinInput') >= 0) ? makeInput() : null;
      activeEl = null; // a rewrite blows away focus
    },
    get innerHTML() { return this._html; }
  };

  const document = {
    getElementById(id) {
      if (id === 'zwavePairPanel') return panel;
      if (id === 'zwavePinInput') return currentInput;
      return null;
    },
    get activeElement() { return activeEl; }
  };

  return {
    document,
    getInput: () => currentInput,
    focusInput: () => { if (currentInput) currentInput.focus(); },
    writes: () => writes
  };
}

function loadSetPairPanel(dom) {
  const src = 'let _lastPairPanelHtml = null;\n' + extractFn('setPairPanel');
  const factory = new Function('document', src + '; return setPairPanel;');
  return factory(dom.document);
}

const DSK_HTML = '<input type="text" id="zwavePinInput"><button>Submit PIN</button>';

test('setPairPanel skips the write when HTML is unchanged, preserving a typed PIN', () => {
  const dom = makeDom();
  const setPairPanel = loadSetPairPanel(dom);

  setPairPanel(DSK_HTML);                 // first paint: creates the input
  assert.strictEqual(dom.writes(), 1);
  const input = dom.getInput();
  input.value = '123';                    // user starts typing
  dom.focusInput();

  setPairPanel(DSK_HTML);                 // identical poll tick: must be a no-op
  setPairPanel(DSK_HTML);
  assert.strictEqual(dom.writes(), 1, 'unchanged HTML must not rewrite the panel');
  assert.strictEqual(dom.getInput(), input, 'same input element survives');
  assert.strictEqual(dom.getInput().value, '123', 'typed digits are preserved');
});

test('setPairPanel preserves value and focus when a real rewrite happens', () => {
  const dom = makeDom();
  const setPairPanel = loadSetPairPanel(dom);

  setPairPanel(DSK_HTML + ' v1');
  const first = dom.getInput();
  first.value = '42';
  first.selectionStart = 2; first.selectionEnd = 2;
  dom.focusInput();

  setPairPanel(DSK_HTML + ' v2');         // different HTML: a rewrite is required
  assert.strictEqual(dom.writes(), 2);
  const next = dom.getInput();
  assert.notStrictEqual(next, first, 'the rewrite creates a new input element');
  assert.strictEqual(next.value, '42', 'value carried across the rewrite');
  assert.strictEqual(dom.document.activeElement, next, 'focus restored to the new input');
  assert.strictEqual(next.selectionStart, 2, 'caret restored');
});

test('setPairPanel handles a panel with no input and never throws', () => {
  const dom = makeDom();
  const setPairPanel = loadSetPairPanel(dom);
  assert.doesNotThrow(() => setPairPanel('<div>starting the Z-Wave controller...</div>'));
  assert.strictEqual(dom.getInput(), null);
  assert.strictEqual(dom.writes(), 1);
});

// ---------------------------------------------------------------------------
// updateStatus: pill mapping must match the window-title mapping
// ---------------------------------------------------------------------------

function loadUpdateStatus(healthData) {
  const src = 'let healthData = ' + JSON.stringify(healthData) + ';\n' + extractFn('updateStatus');
  const pill = { className: '', _span: { textContent: '' }, querySelector() { return this._span; } };
  const document = { getElementById: (id) => (id === 'statusPill' ? pill : null) };
  const factory = new Function('document', src + '; return updateStatus;');
  return { updateStatus: factory(document), pill };
}

test('updateStatus(false) shows Offline (server unreachable)', () => {
  const { updateStatus, pill } = loadUpdateStatus(null);
  updateStatus(false);
  assert.ok(pill.className.includes('offline'));
  assert.strictEqual(pill._span.textContent, 'Offline');
});

test('updateStatus: only a connected controller reads Online', () => {
  const c = loadUpdateStatus({ unifi: { connection_state: 'connected' } });
  c.updateStatus(true);
  assert.ok(c.pill.className.includes('online'));
  assert.strictEqual(c.pill._span.textContent, 'Online');
});

test('updateStatus: connecting/reconnecting read Reconnecting', () => {
  for (const cs of ['reconnecting', 'connecting']) {
    const c = loadUpdateStatus({ unifi: { connection_state: cs } });
    c.updateStatus(true);
    assert.ok(c.pill.className.includes('reconnecting'), cs + ' -> reconnecting');
    assert.strictEqual(c.pill._span.textContent, 'Reconnecting');
  }
});

test('updateStatus: unknown/undefined/disconnected read Disconnected (matches title)', () => {
  for (const cs of ['disconnected', 'unknown', undefined]) {
    const c = loadUpdateStatus({ unifi: { connection_state: cs } });
    c.updateStatus(true);
    assert.ok(c.pill.className.includes('offline'), String(cs) + ' -> offline pill');
    assert.strictEqual(c.pill._span.textContent, 'Disconnected', String(cs) + ' -> Disconnected');
  }
});

// ---------------------------------------------------------------------------
// Electron health watchdog (electron/main.js): a slow service must never be
// relaunched mid-operation, and the title must say "Not responding" (this
// app's server is stalled) rather than pretending the UniFi link dropped.
// Source-level contracts, same style as the freeze-fix guards.
// ---------------------------------------------------------------------------

const electronMain = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

function extractElectronFn(name) {
  const start = electronMain.indexOf('function ' + name);
  assert.ok(start >= 0, 'function not found in electron/main.js: ' + name);
  let depth = 0;
  const open = electronMain.indexOf('{', start);
  for (let j = open; j < electronMain.length; j++) {
    if (electronMain[j] === '{') depth++;
    else if (electronMain[j] === '}') { depth--; if (depth === 0) return electronMain.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}

test('watchdog: probe timeout is 15s (an S0 verify can stall the event loop past 5s)', () => {
  const src = extractElectronFn('startHealthWatchdog');
  assert.match(src, /timeout:\s*15000/);
  assert.ok(!/timeout:\s*5000/.test(src), 'old 5s probe timeout removed');
});

test('watchdog: a timeout never feeds the relaunch, only hard connection errors do', () => {
  const src = extractElectronFn('startHealthWatchdog');
  assert.match(src, /timedOut = true/, 'timeout flagged');
  assert.match(src, /if \(timedOut\) return;/, 'flag short-circuits the relaunch path');
  assert.match(src, /if \(counted\) return;/, 'one failure per probe, however many events fire');
});

test('watchdog: consecutive failures surface as Not responding in the title', () => {
  const src = extractElectronFn('startHealthWatchdog');
  assert.match(src, /Not responding/);
  assert.match(src, /healthFailCount >= 2/, 'after 2+ consecutive failures');
});

test('native View menu reconciles with the six tabs', () => {
  // Every top-level destination is reachable from the menu, with matching
  // labels and sequential accelerators.
  assert.match(electronMain, /label: 'Visual Designer',\s*accelerator: 'CmdOrCtrl\+4',\s*click: \(\) => navigateTo\('designer'\)/,
    'Visual Designer is in the menu at Cmd+4');
  assert.match(electronMain, /label: 'Settings',\s*accelerator: 'CmdOrCtrl\+5',\s*click: \(\) => navigateTo\('settings'\)/,
    'Settings is in the menu at Cmd+5');
  assert.match(electronMain, /label: 'Test Tools',\s*accelerator: 'CmdOrCtrl\+6'/,
    'Test Tools moved to Cmd+6 to make room');
  assert.match(electronMain, /label: 'Automations',\s*accelerator: 'CmdOrCtrl\+3'/,
    'the Configuration entry is renamed Automations');
});
