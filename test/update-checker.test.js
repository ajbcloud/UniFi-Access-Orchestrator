'use strict';

// Covers src/update-checker.js: version ordering, the check/install state
// machine with an injected release feed, the desktop backend contract, and the
// headless installer's helper (request file) and manual modes. No network, no
// real timers.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  UpdateChecker, HeadlessInstaller, compareVersions, isNewer, normalizeTag, parseVersion,
  REQUEST_FILE, RESULT_FILE
} = require('../src/update-checker');

const quiet = { info() {}, warn() {}, error() {} };

// Manual timers so a test can fire the first check on demand.
function fakeTimers() {
  const timers = [];
  return {
    setTimeout: (fn, ms) => { const t = { fn, ms, kind: 'timeout', unref() {} }; timers.push(t); return t; },
    setInterval: (fn, ms) => { const t = { fn, ms, kind: 'interval', unref() {} }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    clearInterval: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    timers,
    fire(kind) {
      for (const t of timers.filter((x) => x.kind === kind)) {
        if (kind === 'timeout') { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); } // one-shot, like the real thing
        t.fn();
      }
    }
  };
}

function makeChecker(overrides = {}) {
  const t = fakeTimers();
  const releases = overrides.releases || [{ version: 'v11.3.0', name: 'v11.3.0', url: 'https://example/rel', notes: 'notes', published_at: '2026-09-22T00:00:00Z' }];
  let calls = 0;
  const checker = new UpdateChecker(Object.assign({
    currentVersion: '11.2.4',
    logger: quiet,
    startupDelayMs: 10,
    fetchLatest: async () => { calls++; const r = releases[Math.min(calls - 1, releases.length - 1)]; if (r instanceof Error) throw r; return r; },
    setTimeout: t.setTimeout, clearTimeout: t.clearTimeout, setInterval: t.setInterval, clearInterval: t.clearInterval,
    now: () => 1_000_000
  }, overrides.opts || {}));
  return { checker, t, calls: () => calls };
}

// ---------------------------------------------------------------------------
// versions

test('compareVersions orders numerically and handles v prefixes and prereleases', () => {
  assert.strictEqual(compareVersions('v11.2.4', '11.2.4'), 0);
  assert.strictEqual(compareVersions('11.10.0', '11.9.9'), 1, '10 > 9 numerically, not lexically');
  assert.strictEqual(compareVersions('11.2.4', '12.0.0'), -1);
  assert.strictEqual(compareVersions('1.2.0-beta.1', '1.2.0'), -1, 'prerelease sorts before release');
  assert.strictEqual(compareVersions('1.2.0-beta.2', '1.2.0-beta.10'), -1);
  assert.strictEqual(compareVersions('garbage', '1.0.0'), 0, 'unparseable never reads as newer');
  assert.ok(isNewer('v11.2.5', '11.2.4'));
  assert.ok(!isNewer('v11.2.4', '11.2.4'));
  assert.ok(!isNewer('v11.1.1', '11.2.4'));
});

test('normalizeTag and parseVersion', () => {
  assert.strictEqual(normalizeTag('11.2.4'), 'v11.2.4');
  assert.strictEqual(normalizeTag('V1.2.3-rc.1'), 'v1.2.3-rc.1');
  assert.strictEqual(normalizeTag('latest'), null);
  assert.deepStrictEqual(parseVersion('v2.0.1'), { major: 2, minor: 0, patch: 1, pre: null });
});

// ---------------------------------------------------------------------------
// check()

test('a newer release flips update_available and records release details', async () => {
  const { checker } = makeChecker();
  const st = await checker.check();
  assert.strictEqual(st.update_available, true);
  assert.strictEqual(st.latest_version, '11.3.0');
  assert.strictEqual(st.current_version, '11.2.4');
  assert.strictEqual(st.release_url, 'https://example/rel');
  assert.strictEqual(st.last_error, null);
  assert.ok(st.last_check_at);
});

test('the same or an older release is not an update', async () => {
  const same = makeChecker({ releases: [{ version: 'v11.2.4' }] });
  assert.strictEqual((await same.checker.check()).update_available, false);
  const older = makeChecker({ releases: [{ version: 'v11.1.0' }] });
  assert.strictEqual((await older.checker.check()).update_available, false);
});

test('a failed lookup lands in last_error and never throws', async () => {
  const { checker } = makeChecker({ releases: [new Error('GitHub returned HTTP 403 (GitHub API rate limit)')] });
  const st = await checker.check();
  assert.strictEqual(st.update_available, false);
  assert.match(st.last_error, /rate limit/);
});

test('start() schedules the first check after the startup delay, then an interval', async () => {
  const { checker, t, calls } = makeChecker({ opts: { config: { check_interval_hours: 2 } } });
  checker.start();
  assert.strictEqual(calls(), 0);
  assert.strictEqual(t.timers[0].ms, 10);
  t.fire('timeout');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls(), 1);
  const interval = t.timers.find((x) => x.kind === 'interval');
  assert.ok(interval, 'interval scheduled after the first check');
  assert.strictEqual(interval.ms, 2 * 3600 * 1000);
  checker.stop();
  assert.strictEqual(t.timers.length, 0);
});

test('configure() clamps the interval and honours enabled=false', async () => {
  const { checker, calls } = makeChecker({ opts: { config: { enabled: false, check_interval_hours: 0.1 } } });
  assert.strictEqual(checker.getState().enabled, false);
  assert.strictEqual(checker.getState().check_interval_hours, 1, 'never below hourly');
  checker.start();
  assert.strictEqual(checker.timer, null, 'disabled: nothing scheduled');
  await checker.check();
  assert.strictEqual(calls(), 0, 'disabled: a plain check() is a no-op');
  await checker.check({ force: true });
  assert.strictEqual(calls(), 1, 'force bypasses the toggle for the Help menu');
});

test('concurrent checks share one lookup', async () => {
  const { checker, calls } = makeChecker();
  await Promise.all([checker.check(), checker.check(), checker.check()]);
  assert.strictEqual(calls(), 1);
});

// ---------------------------------------------------------------------------
// install() via a backend (desktop contract)

test('install() routes to the backend and mirrors its progress reports', async () => {
  const { checker } = makeChecker();
  const seen = [];
  checker.onChange((st) => seen.push(st.install.state));
  let attached = null;
  checker.setBackend({
    installMethod: 'desktop',
    supportsInstall: true,
    attach(fn) { attached = fn; },
    async check() { return { version: '11.3.0', url: 'u' }; },
    async install(version) { assert.strictEqual(version, 'v11.3.0'); return { state: 'downloading', progress: 0 }; }
  });
  assert.strictEqual(checker.getState().install_method, 'desktop');
  await checker.check();
  const inst = await checker.install();
  assert.strictEqual(inst.state, 'downloading');
  attached({ state: 'downloading', progress: 42 });
  assert.strictEqual(checker.getState().install.progress, 42);
  attached({ state: 'ready', progress: 100 });
  assert.strictEqual(checker.getState().install.state, 'ready');
  assert.ok(seen.includes('downloading') && seen.includes('ready'));

  // Second click while ready goes straight back to the backend (restart).
  checker.backend.install = async () => ({ state: 'installing', progress: 100 });
  assert.strictEqual((await checker.install()).state, 'installing');
  // ...and a third click while installing is refused as BUSY.
  await assert.rejects(checker.install(), (e) => e.code === 'BUSY');
});

test('a backend answering null means "current" and a download-only backend refuses install', async () => {
  const { checker } = makeChecker();
  checker.setBackend({ installMethod: 'download', supportsInstall: false, attach() {}, async check() { return null; } });
  const st = await checker.check();
  assert.strictEqual(st.update_available, false);
  assert.strictEqual(st.install_method, 'download');
  checker.backend.check = async () => ({ version: '11.9.0' });
  await checker.check();
  await assert.rejects(checker.install(), (e) => e.code === 'MANUAL' && /Download/.test(e.instructions));
  assert.strictEqual(checker.getState().install.state, 'idle', 'a MANUAL refusal is not a failure');
});

test('install() re-checks first and refuses when nothing is newer', async () => {
  const { checker, calls } = makeChecker({ releases: [{ version: 'v11.2.4' }] });
  await assert.rejects(checker.install(), (e) => e.code === 'NO_UPDATE');
  assert.strictEqual(calls(), 1, 'the refusal came after a fresh look');
});

test('a backend error during install is recorded as failed', async () => {
  const { checker } = makeChecker();
  checker.setBackend({ installMethod: 'desktop', attach() {}, async check() { return { version: '11.3.0' }; }, async install() { throw new Error('disk full'); } });
  await checker.check();
  await assert.rejects(checker.install(), /disk full/);
  assert.strictEqual(checker.getState().install.state, 'failed');
  assert.strictEqual(checker.getState().install.error, 'disk full');
  // Retry is allowed from failed.
  checker.backend.install = async () => ({ state: 'downloading' });
  assert.strictEqual((await checker.install()).state, 'downloading');
});

// ---------------------------------------------------------------------------
// HeadlessInstaller

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'uao-test-')); }

test('helper mode writes an upgrade.request the root unit can pick up', async () => {
  const stateDir = tmpdir();
  const appDir = tmpdir();
  const installer = new HeadlessInstaller({ appDir, stateDir, env: { UPDATE_HELPER_INSTALLED: '1' }, logger: quiet, platform: 'linux' });
  assert.strictEqual(installer.mode(), 'helper');
  const reports = [];
  const r = await installer.install('11.3.0', (p) => reports.push(p));
  assert.strictEqual(r.state, 'requested');
  const req = JSON.parse(fs.readFileSync(path.join(stateDir, REQUEST_FILE), 'utf8'));
  assert.strictEqual(req.version, 'v11.3.0');
  assert.ok(installer.requestPending());
  fs.rmSync(stateDir, { recursive: true, force: true }); fs.rmSync(appDir, { recursive: true, force: true });
});

test('without the helper and with a read-only app dir the mode is manual with instructions', async () => {
  const appDir = tmpdir();
  // No scripts/upgrade.sh in this dir, so direct mode is impossible.
  const installer = new HeadlessInstaller({ appDir, stateDir: null, env: {}, logger: quiet, platform: 'linux' });
  assert.strictEqual(installer.mode(), 'manual');
  await assert.rejects(installer.install('v11.3.0', () => {}), (e) => e.code === 'MANUAL' && /install-upgrade-helper\.sh/.test(e.instructions));
  fs.rmSync(appDir, { recursive: true, force: true });
});

test('a git checkout is never upgraded in place (protects a developer working tree)', () => {
  const appDir = tmpdir();
  fs.mkdirSync(path.join(appDir, 'scripts'));
  fs.writeFileSync(path.join(appDir, 'scripts', 'upgrade.sh'), '#!/bin/bash\n');
  fs.mkdirSync(path.join(appDir, '.git'));
  const installer = new HeadlessInstaller({ appDir, stateDir: null, env: {}, logger: quiet, platform: 'linux' });
  assert.strictEqual(installer.mode(), 'manual');
  fs.rmdirSync(path.join(appDir, '.git'));
  installer._modeCache = null; // the 30s cache would otherwise hide the change
  assert.strictEqual(installer.mode(), 'direct');
  fs.rmSync(appDir, { recursive: true, force: true });
});

test('direct mode runs a private copy of the script and exits on success', async () => {
  const appDir = tmpdir();
  fs.mkdirSync(path.join(appDir, 'scripts'));
  fs.writeFileSync(path.join(appDir, 'scripts', 'upgrade.sh'), '#!/bin/bash\necho step one\n');
  const spawned = [];
  let exited = null;
  const EventEmitter = require('events');
  const installer = new HeadlessInstaller({
    appDir, stateDir: null, env: {}, logger: quiet, platform: 'linux',
    exit: (code) => { exited = code; },
    spawnImpl: (cmd, args, opts) => {
      spawned.push({ cmd, args, opts });
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      setImmediate(() => { child.stdout.emit('data', Buffer.from('Installing files\n')); child.emit('exit', 0); });
      return child;
    }
  });
  const reports = [];
  const r = await installer.install('v11.3.0', (p) => reports.push(p));
  assert.strictEqual(r.state, 'installing');
  assert.strictEqual(spawned[0].cmd, 'bash');
  assert.notStrictEqual(spawned[0].args[0], path.join(appDir, 'scripts', 'upgrade.sh'), 'runs a copy, not the file the upgrade replaces');
  assert.strictEqual(spawned[0].args[1], 'v11.3.0');
  assert.strictEqual(spawned[0].opts.env.SERVICE, '', 'no systemctl in direct mode');
  assert.strictEqual(spawned[0].opts.env.APP_DIR, appDir);
  await new Promise((r) => setTimeout(r, 1700));
  assert.ok(reports.some((p) => p.state === 'installing' && /Installing files/.test(p.detail)));
  assert.ok(reports.some((p) => p.state === 'restarting'));
  assert.strictEqual(exited, 0);
  fs.rmSync(appDir, { recursive: true, force: true });
});

test('checker absorbs the helper result file on boot', () => {
  const stateDir = tmpdir();
  const appDir = tmpdir();
  const mk = () => new HeadlessInstaller({ appDir, stateDir, env: { UPDATE_HELPER_INSTALLED: '1' }, logger: quiet, platform: 'linux' });

  // Success for the version now running: acknowledged once, file removed.
  fs.writeFileSync(path.join(stateDir, RESULT_FILE), JSON.stringify({ status: 'ok', version: 'v11.2.4', previous_version: 'v11.1.1' }));
  let c = new UpdateChecker({ currentVersion: '11.2.4', installer: mk(), logger: quiet, startupDelayMs: 10, setTimeout: () => ({ unref() {} }), setInterval: () => ({ unref() {} }), clearTimeout() {}, clearInterval() {} });
  c.start();
  assert.strictEqual(c.getState().just_upgraded_from, 'v11.1.1');
  assert.ok(!fs.existsSync(path.join(stateDir, RESULT_FILE)));

  // Failure stays visible.
  fs.writeFileSync(path.join(stateDir, RESULT_FILE), JSON.stringify({ status: 'failed', version: 'v11.3.0', error: 'npm install failed' }));
  c = new UpdateChecker({ currentVersion: '11.2.4', installer: mk(), logger: quiet, startupDelayMs: 10, setTimeout: () => ({ unref() {} }), setInterval: () => ({ unref() {} }), clearTimeout() {}, clearInterval() {} });
  c.start();
  assert.strictEqual(c.getState().install.state, 'failed');
  assert.match(c.getState().install.error, /npm install failed/);

  // Stale "running" (older than 30 min) becomes a failure with a hint.
  fs.writeFileSync(path.join(stateDir, RESULT_FILE), JSON.stringify({ status: 'running', version: 'v11.3.0', started_at: '2020-01-01T00:00:00Z' }));
  c = new UpdateChecker({ currentVersion: '11.2.4', installer: mk(), logger: quiet, startupDelayMs: 10, setTimeout: () => ({ unref() {} }), setInterval: () => ({ unref() {} }), clearTimeout() {}, clearInterval() {} });
  c.start();
  assert.strictEqual(c.getState().install.state, 'failed');
  assert.match(c.getState().install.error, /journalctl/);

  fs.rmSync(stateDir, { recursive: true, force: true }); fs.rmSync(appDir, { recursive: true, force: true });
});

test('helper mode: the checker follows upgrade.result to restarting', async () => {
  const stateDir = tmpdir();
  const appDir = tmpdir();
  const installer = new HeadlessInstaller({ appDir, stateDir, env: { UPDATE_HELPER_INSTALLED: '1' }, logger: quiet, platform: 'linux' });
  const { checker, t } = makeChecker({ opts: { installer } });
  await checker.check();
  const inst = await checker.install();
  assert.strictEqual(inst.state, 'requested');
  assert.strictEqual(checker.getState().install_method, 'helper');
  // Root helper reports progress, then success.
  fs.writeFileSync(path.join(stateDir, RESULT_FILE), JSON.stringify({ status: 'running', step: 'Installing dependencies', version: 'v11.3.0' }));
  t.fire('interval');
  assert.strictEqual(checker.getState().install.state, 'installing');
  assert.match(checker.getState().install.detail, /dependencies/);
  fs.writeFileSync(path.join(stateDir, RESULT_FILE), JSON.stringify({ status: 'ok', version: 'v11.3.0' }));
  t.fire('interval');
  assert.strictEqual(checker.getState().install.state, 'restarting');
  fs.rmSync(stateDir, { recursive: true, force: true }); fs.rmSync(appDir, { recursive: true, force: true });
});
