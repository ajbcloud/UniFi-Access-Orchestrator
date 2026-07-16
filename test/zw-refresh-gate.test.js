'use strict';

// Guards the UI-freeze fix in public/index.html. Field report: after ANY
// deadbolt action the panel froze until a page reload. Two mechanisms had to
// change: (1) every handler that disables the deadbolt buttons must re-enable
// them in a finally (the repaint that used to restore them is skipped while a
// field has focus), and (2) a skipped focus-guarded repaint must be retried
// (timer / focusout / health poll) instead of dropped forever. Also: api()
// must carry an abort timeout so a hung request cannot pin the UI.

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

// --- createZwRefreshGate behavior -----------------------------------------

function loadGate() {
  const src = extractFn('createZwRefreshGate');
  return new Function('setTimeout', 'clearTimeout', src + '; return createZwRefreshGate;');
}

test('gate: a skipped repaint arms exactly one retry timer', () => {
  const timers = [];
  const fakeSetTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const gate = loadGate()(fakeSetTimeout, () => {})(2000);
  let retried = 0;
  gate.skipped(() => retried++);
  gate.skipped(() => retried++);
  gate.skipped(() => retried++);
  assert.equal(timers.length, 1, 'repeat skips share one timer');
  assert.equal(timers[0].ms, 2000);
  assert.equal(gate.pending, true);
  timers[0].fn();
  assert.equal(retried, 1, 'timer delivers the retry');
});

test('gate: ran() clears pending and cancels the timer', () => {
  let cleared = null;
  const fakeSetTimeout = () => 42;
  const fakeClearTimeout = (id) => { cleared = id; };
  const gate = loadGate()(fakeSetTimeout, fakeClearTimeout)();
  gate.skipped(() => {});
  gate.ran();
  assert.equal(gate.pending, false);
  assert.equal(cleared, 42, 'armed timer cancelled');
});

test('gate: kick() retries only when a repaint is owed', () => {
  const gate = loadGate()(() => 1, () => {})();
  let retried = 0;
  gate.kick(() => retried++);
  assert.equal(retried, 0, 'nothing owed, nothing fired');
  gate.skipped(() => {});
  gate.kick(() => retried++);
  assert.equal(retried, 1, 'pending repaint delivered on kick');
});

// --- source-level contracts (the freeze regression guards) -----------------

test('every handler that sets busy(true) re-enables in a finally', () => {
  const setters = [...html.matchAll(/_setDeadboltButtonsBusy\(true\)/g)];
  assert.ok(setters.length >= 4, `expected the four busy handlers, found ${setters.length}`);
  for (const name of ['startPairing', 'startUnpairNode', 'startUnpair', 'deadboltControl']) {
    const src = extractFn(name);
    assert.match(src, /_setDeadboltButtonsBusy\(true\)/, `${name} disables the buttons`);
    assert.match(src, /finally\s*\{[^}]*_setDeadboltButtonsBusy\(false\)/, `${name} re-enables in a finally`);
  }
});

test('every focus guard records the skip on its section gate instead of dropping it', () => {
  const refresh = extractFn('refreshZwaveDeadbolt');
  assert.match(refresh, /_devicesGate\.skipped\(renderDeadboltDevices\)/,
    'refreshZwaveDeadbolt records skipped repaints, retried by the section OWNER');
  const devices = extractFn('renderDeadboltDevices');
  assert.match(devices, /_devicesGate\.skipped\(/, 'renderDeadboltDevices records skipped repaints');
  assert.match(devices, /_devicesGate\.ran\(\)/, 'renderDeadboltDevices clears the gate on a real repaint');
  const flows = extractFn('renderDoorFlows');
  assert.match(flows, /_doorFlowsGate\.skipped\(/, 'renderDoorFlows records skipped repaints');
  assert.match(flows, /_doorFlowsGate\.ran\(\)/, 'renderDoorFlows clears the gate on a real repaint');
  const keypad = extractFn('renderKeypadUsers');
  assert.match(keypad, /_keypadGate\.skipped\(/, 'renderKeypadUsers records skipped repaints');
  assert.match(keypad, /_keypadGate\.ran\(\)/, 'renderKeypadUsers clears the gate on a real repaint');
});

test('no focus guard ever includes BUTTON (the vanishing-section regression)', () => {
  // One shared predicate, and it must skip only SELECT/INPUT/TEXTAREA. A
  // focused Save button deferring the rebuild its own click earned is how
  // the saved deadbolt trigger used to vanish until a page reload.
  const pred = extractFn('sectionHoldsFocus');
  assert.match(pred, /SELECT\|INPUT\|TEXTAREA/, 'the shared predicate covers the three field types');
  assert.ok(!/BUTTON/.test(pred), 'BUTTON must never hold off a repaint');
  // And no renderer sneaks in its own BUTTON-including tagName regex.
  for (const name of ['renderDeadboltDevices', 'refreshZwaveDeadbolt', 'renderDoorFlows', 'renderKeypadUsers']) {
    const src = extractFn(name);
    assert.ok(!/BUTTON/.test(src), `${name} must not test for BUTTON focus`);
    assert.match(src, /sectionHoldsFocus\(/, `${name} uses the shared predicate`);
  }
});

test('user-initiated mutations repaint through repaintOwned with the guard bypassed', () => {
  const owned = extractFn('repaintOwned');
  assert.match(owned, /renderDeadboltDevices\(true\)/, 'devices force-repaint');
  assert.match(owned, /renderDoorFlows\(true\)/, 'door-flows force-repaint');
  assert.match(owned, /renderKeypadUsers\(true\)/, 'keypad force-repaint');
  // The keypad Save and Remove paths must use it: the old guarded refresh
  // skipped while the picker held focus, leaving the panel dead until a
  // page reload (field report: had to Ctrl+R to re-add a removed user).
  const save = extractFn('saveKeypadUser');
  assert.match(save, /repaintOwned\('keypad'\)/, 'Save PIN repaints the keypad panel unguarded');
  const remove = extractFn('removeKeypadUser');
  assert.match(remove, /repaintOwned\('keypad'\)/, 'Remove repaints the keypad panel unguarded');
  const saveFlow = extractFn('saveDoorFlow');
  assert.match(saveFlow, /repaintOwned\('doorflows'\)/, 'a saved door flow repaints in place (never vanishes)');
});

test('focusout and the health poll deliver owed repaints', () => {
  const wire = extractFn('wireSectionFocusRetry');
  assert.match(wire, /addEventListener\('focusout'/, 'focusout listener wired');
  const health = extractFn('fetchHealth');
  assert.match(health, /_devicesGate\.kick\(renderDeadboltDevices\)/, 'health poll backstops the devices repaint');
  assert.match(health, /_doorFlowsGate\.kick\(renderDoorFlows\)/, 'health poll backstops the door-flows repaint');
  assert.match(health, /_keypadGate\.kick\(renderKeypadUsers\)/, 'health poll backstops the keypad repaint');
});

test('api() aborts hung requests instead of pinning the UI forever', () => {
  const src = extractFn('api');
  assert.match(src, /AbortController/, 'abort controller wired');
  assert.match(src, /API_TIMEOUT_MS/, 'timeout constant used');
  assert.match(src, /clearTimeout\(timer\)/, 'timer cleared after the response');
  assert.match(html, /const API_TIMEOUT_MS = 45000/, '45s ceiling (clears the ~30s worst-case verify)');
});
