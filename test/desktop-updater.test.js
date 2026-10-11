'use strict';

// The packaged desktop app must never download or install an update on its
// own: it runs a building's doors. A check only reports; the Upgrade click
// downloads, then quits into the installer. Drives electron/updater.js with
// stubbed electron and electron-updater modules (each test file runs in its
// own process under node --test, so the stubs cannot leak).

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const fake = new EventEmitter();
fake.calls = { check: 0, download: 0, quitAndInstall: 0 };
fake.nextVersion = '11.2.7';
fake.checkForUpdates = async () => {
  fake.calls.check++;
  const updateInfo = { version: fake.nextVersion, releaseDate: '2026-10-11T00:00:00Z' };
  fake.emit('update-available', updateInfo);
  return { updateInfo, isUpdateAvailable: true };
};
fake.downloadUpdate = async () => {
  fake.calls.download++;
  fake.emit('update-downloaded', { version: fake.nextVersion });
};
fake.quitAndInstall = () => { fake.calls.quitAndInstall++; };

function stub(name, exports) {
  const p = require.resolve(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('electron', { app: { isPackaged: true }, dialog: {}, shell: {} });
stub('electron-updater', { autoUpdater: fake });

const updater = require('../electron/updater');

let backend = null;
updater.initAutoUpdater({
  service: { setUpdateBackend: (b) => { backend = b; }, getUpdateChecker: () => null },
  getMainWindow: () => null,
  setQuitting: () => {},
});

test('the desktop backend is installed (Windows/Linux path)', () => {
  assert.ok(backend && backend.supportsInstall, 'desktop backend in place');
});

test('auto download and install-on-quit are both off', () => {
  assert.strictEqual(fake.autoDownload, false);
  assert.strictEqual(fake.autoInstallOnAppQuit, false);
});

test('a check reports the release but downloads nothing', async () => {
  const reports = [];
  backend.attach((r) => reports.push(r));
  const rel = await backend.check();
  assert.strictEqual(rel.version, '11.2.7');
  assert.strictEqual(fake.calls.download, 0, 'no download from a check');
  assert.deepStrictEqual(reports, [], 'no downloading/failed banner from a check');
});

test('clicking Upgrade downloads and then installs', async () => {
  const reports = [];
  const first = await backend.install('v11.2.7', (r) => reports.push(r));
  assert.strictEqual(first.state, 'downloading');
  await new Promise((r) => setTimeout(r, 800)); // download resolves, then the 600ms restart delay
  assert.strictEqual(fake.calls.download, 1);
  assert.strictEqual(fake.calls.quitAndInstall, 1, 'restarts into the installer after the click');
  assert.ok(reports.some((r) => r.state === 'installing'));
});

test('a failed download after a click reports failed once', async () => {
  // Fresh module state is not needed: the previous install left phase
  // 'installing', so use a new backend instance through a fresh require.
  delete require.cache[require.resolve('../electron/updater')];
  const u2 = require('../electron/updater');
  let b2 = null;
  u2.initAutoUpdater({ service: { setUpdateBackend: (b) => { b2 = b; } } });
  fake.downloadUpdate = async () => {
    const err = new Error('Cannot download, status 404');
    fake.emit('error', err);
    throw err;
  };
  const reports = [];
  await b2.check();
  await b2.install('v11.2.7', (r) => reports.push(r));
  await new Promise((r) => setTimeout(r, 50));
  const failed = reports.filter((r) => r.state === 'failed');
  assert.strictEqual(failed.length, 1);
  assert.match(failed[0].error, /404/);
});

test('installer names have no spaces, so the update feed and the uploaded file agree', () => {
  // electron-builder writes latest.yml with spaces turned into dashes, while
  // the release upload turns them into dots; any space means a 404 on Upgrade.
  const build = require('../package.json').build;
  for (const target of ['nsis', 'appImage', 'dmg']) {
    const name = build[target] && build[target].artifactName;
    assert.ok(name, `${target}.artifactName is set`);
    assert.ok(!/\s/.test(name), `${target}.artifactName has no spaces: ${name}`);
  }
  assert.strictEqual(build.nsis.artifactName, 'UniFi-Access-Orchestrator-Setup-${version}.${ext}');
});
