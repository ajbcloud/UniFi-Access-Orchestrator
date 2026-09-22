'use strict';

// Drives the dashboard's Upgrade banner view model (renderUpdateBanner in
// public/index.html) with the `update` object /health returns, so the banner
// logic ships tested without a browser. Extracts the real function source.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extractFn(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'function not found: ' + name);
  let depth = 0;
  const open = html.indexOf('{', start);
  for (let j = open; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) return html.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}

const renderUpdateBanner = new Function(extractFn('renderUpdateBanner') + '; return renderUpdateBanner;')();

const base = {
  enabled: true, mode: 'headless', install_method: 'helper',
  current_version: '11.2.4', latest_version: '11.3.0', update_available: true,
  release_url: 'https://github.com/ajbcloud/UniFi-Access-Orchestrator/releases/tag/v11.3.0',
  published_at: '2026-09-22T18:46:36Z',
  install: { state: 'idle', progress: null, detail: null, error: null }
};
const withInstall = (install, extra) => Object.assign({}, base, extra || {}, { install: Object.assign({}, base.install, install) });

test('hidden when there is nothing to do or updates are disabled', () => {
  assert.strictEqual(renderUpdateBanner(null).visible, false);
  assert.strictEqual(renderUpdateBanner(Object.assign({}, base, { update_available: false })).visible, false);
  assert.strictEqual(renderUpdateBanner(Object.assign({}, base, { enabled: false })).visible, false);
});

test('update available: Upgrade button, versions named, release notes link', () => {
  const vm = renderUpdateBanner(base);
  assert.strictEqual(vm.visible, true);
  assert.match(vm.title, /v11\.3\.0 is available/);
  assert.match(vm.title, /running v11\.2\.4/);
  assert.deepStrictEqual(vm.button, { label: 'Upgrade', disabled: false, action: 'install' });
  assert.strictEqual(vm.notesUrl, base.release_url);
  assert.strictEqual(vm.progress, null);
});

test('download-only builds (unsigned macOS) get a Download button instead', () => {
  const vm = renderUpdateBanner(Object.assign({}, base, { install_method: 'download' }));
  assert.strictEqual(vm.button.action, 'download');
  assert.match(vm.button.label, /Download v11\.3\.0/);
  assert.match(vm.sub, /cannot update itself/);
});

test('in-flight states disable the button and show progress', () => {
  let vm = renderUpdateBanner(withInstall({ state: 'requested' }));
  assert.strictEqual(vm.button.disabled, true);
  assert.deepStrictEqual(vm.progress, { percent: null });

  vm = renderUpdateBanner(withInstall({ state: 'downloading', progress: 37 }));
  assert.match(vm.title, /Downloading v11\.3\.0 \(37%\)/);
  assert.deepStrictEqual(vm.progress, { percent: 37 });
  assert.strictEqual(vm.button.disabled, true);

  vm = renderUpdateBanner(withInstall({ state: 'installing', detail: 'Installing dependencies' }));
  assert.match(vm.title, /Installing v11\.3\.0/);
  assert.strictEqual(vm.sub, 'Installing dependencies');
  assert.strictEqual(vm.button.disabled, true);

  vm = renderUpdateBanner(withInstall({ state: 'restarting' }));
  assert.strictEqual(vm.tone, 'ready');
  assert.match(vm.title, /Restarting/);
  assert.strictEqual(vm.button.disabled, true);
});

test('ready (desktop download finished) offers Upgrade to restart into it', () => {
  const vm = renderUpdateBanner(withInstall({ state: 'ready', progress: 100 }, { install_method: 'desktop' }));
  assert.strictEqual(vm.tone, 'ready');
  assert.match(vm.title, /downloaded and ready/);
  assert.deepStrictEqual(vm.button, { label: 'Upgrade', disabled: false, action: 'install' });
});

test('failed: stays visible with the error and a retry, even if the check later says current', () => {
  const vm = renderUpdateBanner(withInstall({ state: 'failed', error: 'npm install failed' }));
  assert.strictEqual(vm.tone, 'failed');
  assert.match(vm.sub, /npm install failed/);
  assert.match(vm.sub, /still on v11\.2\.4/);
  assert.deepStrictEqual(vm.button, { label: 'Retry upgrade', disabled: false, action: 'install' });
  // A failure record survives update_available flipping off (it is shown until retried).
  const vm2 = renderUpdateBanner(withInstall({ state: 'failed', error: 'x' }, { update_available: false }));
  assert.strictEqual(vm2.visible, true);
});

test('the banner markup and wiring exist in the page', () => {
  assert.ok(html.includes('id="updateBanner"'), 'banner container');
  assert.ok(html.includes('id="updateBannerBtn"'), 'upgrade button');
  assert.ok(html.includes("onclick=\"onUpgradeClick()\""), 'button handler');
  assert.ok(/applyUpdateBanner\(healthData\.update\)/.test(html), 'health poll feeds the banner');
  assert.ok(/data\.type === 'system\.update_state'/.test(html), 'SSE pushes feed the banner');
  assert.ok(/\.update-banner\s*\{[^}]*position:\s*sticky/.test(html), 'banner is pinned to the top');
});
