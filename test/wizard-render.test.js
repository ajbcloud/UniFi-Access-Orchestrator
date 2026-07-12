'use strict';

// Guards the guided setup wizard's pure builders and its auto-open decision.
// Extracts the REAL functions from public/index.html with the same
// extract-and-run harness the other dashboard tests use, so these track the
// shipped code with no browser dependency.

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
  const factory = new Function(src + '; return ' + name + ';');
  return factory();
}

// ---------------------------------------------------------------------------
// computeWizardAutoOpen: the five install states plus a defensive null case
// ---------------------------------------------------------------------------

test('computeWizardAutoOpen opens only for a genuine fresh install', () => {
  const fn = load('computeWizardAutoOpen');

  // fresh: no host, no wizard state -> open
  assert.strictEqual(fn({ unifi: {} }), true);
  assert.strictEqual(fn({ unifi: { host: '' } }), true);

  // skipped / completed -> never
  assert.strictEqual(fn({ unifi: {}, setup_wizard: { skipped: true } }), false);
  assert.strictEqual(fn({ unifi: {}, setup_wizard: { completed: true } }), false);

  // legacy upgrade: real host, no setup_wizard key -> already set up, no open.
  // A gateway genuinely at 192.168.1.1 counts as configured (no placeholder
  // special-case), so an upgraded install there is not interrupted.
  assert.strictEqual(fn({ unifi: { host: '10.1.10.5' } }), false);
  assert.strictEqual(fn({ unifi: { host: '192.168.1.1' } }), false, 'a real configured host, not a placeholder');

  // resume: host still empty, wizard started but not finished -> open
  assert.strictEqual(fn({ unifi: { host: '' }, setup_wizard: { last_step: 'groups' } }), true);

  // defensive: unusable config never forces the wizard open
  assert.strictEqual(fn(null), false);
  assert.strictEqual(fn(undefined), false);
  assert.strictEqual(fn('nope'), false);
});

// ---------------------------------------------------------------------------
// step navigation
// ---------------------------------------------------------------------------

test('next/prevWizardStep walk the ordered list and stop at the ends', () => {
  const next = load('nextWizardStep');
  const prev = load('prevWizardStep');
  const list = load('wizardStepList')();

  assert.deepStrictEqual(list, ['welcome', 'connect', 'sync', 'groups', 'rule', 'events', 'finish']);
  assert.strictEqual(next('welcome'), 'connect');
  assert.strictEqual(next('events'), 'finish');
  assert.strictEqual(next('finish'), null, 'no step past finish');
  assert.strictEqual(next('nonsense'), null);
  assert.strictEqual(prev('connect'), 'welcome');
  assert.strictEqual(prev('welcome'), null, 'no step before welcome');
  assert.strictEqual(prev('nonsense'), null);
});

// ---------------------------------------------------------------------------
// stepper rendering: active / done / clickable states
// ---------------------------------------------------------------------------

test('renderWizardStepper marks done, active, and clickable states', () => {
  const render = load('renderWizardStepper');
  // on step "sync" (index 2), having visited up to index 3 ("groups")
  const out = render('sync', 3);

  // current step is active and not clickable
  assert.match(out, /class="wstep active" data-step="sync"/);
  // earlier steps are done and carry a checkmark
  assert.match(out, /class="wstep done clickable" data-step="welcome"/);
  assert.match(out, /class="wstep done clickable" data-step="connect"/);
  assert.ok(out.includes('&#10003;'), 'completed steps use a checkmark');
  // a visited-but-ahead step (groups, index 3) is clickable but not done
  assert.match(out, /class="wstep clickable" data-step="groups"/);
  // an unvisited step (finish) is neither done nor clickable
  assert.match(out, /class="wstep" data-step="finish"/);
});

test('renderWizardStepper: on the first step nothing is done or clickable', () => {
  const render = load('renderWizardStepper');
  const out = render('welcome', 0);
  assert.match(out, /class="wstep active" data-step="welcome"/);
  assert.ok(!out.includes('done'), 'no done steps at the start');
  assert.ok(!out.includes('clickable'), 'no clickable steps at the start');
});

// ---------------------------------------------------------------------------
// group-mapping rows: shared builder, data attributes (no ids), escaping
// ---------------------------------------------------------------------------

test('buildGroupMappingRows uses data attributes, never element ids', () => {
  const build = load('buildGroupMappingRows', extractFn('escapeHtml'));
  const out = build(['Staff', 'Delivery'], { Staff: 'Employees' });

  assert.ok(out.includes('data-mapping-group="Staff"'));
  assert.ok(out.includes('data-mapping-group="Delivery"'));
  assert.ok(!/\bid="/.test(out), 'rows must not carry id attributes (duplicate-id hazard)');
  // a mapped group shows its friendly name; an unmapped one falls back to itself
  assert.ok(out.includes('value="Employees"'), 'mapped value used');
  assert.ok(out.includes('value="Delivery"'), 'identity fallback used');
});

test('buildGroupMappingRows escapes hostile group names (XSS)', () => {
  const build = load('buildGroupMappingRows', extractFn('escapeHtml'));
  const out = build(['"><img src=x onerror=alert(1)>'], {});
  assert.ok(!out.includes('<img'), 'raw markup must not appear');
  assert.ok(out.includes('&lt;img'), 'must be escaped');
  assert.ok(!out.includes('"><img'), 'attribute breakout must be neutralised');
});

// ---------------------------------------------------------------------------
// event-source picker
// ---------------------------------------------------------------------------

test('buildWizardEventChoice preselects the current mode and lists all modes', () => {
  const build = load('buildWizardEventChoice');
  const out = build('api_webhook');
  assert.ok(out.includes('value="alarm_manager"'));
  assert.ok(out.includes('value="api_webhook"'));
  assert.ok(out.includes('value="websocket"'));
  // exactly the current mode is checked
  assert.match(out, /value="api_webhook" checked/);
  assert.ok(!/value="alarm_manager" checked/.test(out));
  // default when nothing supplied is websocket
  assert.match(build(), /value="websocket" checked/);
  assert.ok(!/value="alarm_manager" checked/.test(build()));
});

// ---------------------------------------------------------------------------
// finish summary
// ---------------------------------------------------------------------------

test('buildWizardFinishHtml shows counts, mode label, and a zero-rule nudge', () => {
  const build = load('buildWizardFinishHtml', extractFn('escapeHtml'));

  const withRules = build({ doors: 4, users: 9, rules: 2, eventMode: 'alarm_manager' });
  assert.ok(withRules.includes('>4<'), 'door count shown');
  assert.ok(withRules.includes('>9<'), 'user count shown');
  assert.ok(withRules.includes('Alarm Manager'), 'friendly mode label shown');
  assert.ok(!withRules.includes('No rules yet'), 'no nudge when rules exist');

  const noRules = build({ doors: 0, users: 0, rules: 0, eventMode: '' });
  assert.ok(noRules.includes('No rules yet'), 'nudge appears with zero rules');
  assert.ok(noRules.includes('Not set'), 'unset mode labelled');
});

test('buildWizardFinishHtml tolerates a missing summary object', () => {
  const build = load('buildWizardFinishHtml', extractFn('escapeHtml'));
  assert.doesNotThrow(() => build());
  assert.doesNotThrow(() => build({}));
});
