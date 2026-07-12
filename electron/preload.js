/**
 * Preload bridge for the packaged desktop app.
 *
 * Runs before any page script on every load (initial, reload, relaunch), so
 * the dashboard can authenticate to its own local server without ever
 * prompting: the server auto-generates server.admin_api_key on first boot,
 * and the SPA cannot fetch it over HTTP (GET /api/config both requires the
 * key and redacts it). Sandboxed preloads have no fs access, so the values
 * come from the main process over synchronous IPC; main reads config.json
 * fresh on each call, which also covers key rotation, backup restore, and
 * the Reset Configuration relaunch.
 *
 * Remote browsers (Open in Browser) have no bridge and fall back to the
 * in-page key dialog.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orchestratorDesktop', {
  getAdminApiKey: () => {
    try { return ipcRenderer.sendSync('orchestrator:get-admin-api-key') || ''; } catch (e) { return ''; }
  },
  isFirstRun: () => {
    try { return !!ipcRenderer.sendSync('orchestrator:is-first-run'); } catch (e) { return false; }
  },
});
