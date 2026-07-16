'use strict';

// Source-contract guards for the small palette and accessibility fixes in
// public/index.html. These are markup-level invariants, so we assert against
// the file text rather than executing a renderer.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('the UniFi token fields are masked (password type)', () => {
  assert.match(html, /id="settingUnifiToken"[^>]*type="password"|type="password"[^>]*id="settingUnifiToken"/,
    'the Settings token input is a password field');
  assert.match(html, /id="setupToken"[^>]*type="password"|type="password"[^>]*id="setupToken"/,
    'the wizard token input is a password field');
});

test('the tinted designer danger override is gone (one danger style)', () => {
  assert.ok(!/\.btn\.btn-danger\s*\{/.test(html),
    'the specificity-winning tinted .btn.btn-danger override was removed so danger buttons look identical');
});

test('the status pill starts in a neutral connecting state, not red', () => {
  assert.match(html, /id="statusPill" class="status-pill connecting"/,
    'first paint uses the connecting class, not offline');
  assert.match(html, /\.status-pill\.connecting \{/, 'a connecting color is defined');
});

test('the theme toggle static label matches the light-default state', () => {
  assert.ok(!/&#127769; Theme<\/button>/.test(html), 'the dead "Theme" label is gone');
});

test('decorative stat icons are hidden from assistive tech', () => {
  // Every dashboard stat icon should be aria-hidden so a screen reader does
  // not read the emoji glyph as content.
  const statIcons = html.match(/<div class="stat-icon[^"]*"[^>]*>/g) || [];
  assert.ok(statIcons.length >= 4, 'found the stat icons');
  assert.ok(statIcons.every((s) => s.includes('aria-hidden="true"')), 'each stat icon is aria-hidden');
});
