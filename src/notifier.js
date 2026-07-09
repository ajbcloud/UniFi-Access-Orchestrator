'use strict';

/**
 * Notifier: outbound alerting for the orchestrator.
 *
 * The review flagged "no outbound alerting" as the top day-2 gap: an MSP does
 * not sit watching the dashboard, so a failed deadbolt retract (someone locked
 * out), a jam, a lost controller, or a sustained unlock failure must reach a
 * human out of band. This posts a JSON alert to a configurable local webhook
 * (no cloud dependency required; point it at an on-prem collector or a relay).
 *
 * Config (config.alerts):
 *   enabled: boolean
 *   webhook_url: string
 *   on: string[]            // alert types to send; empty = send all
 *   min_interval_seconds: number  // per-type de-dupe window (default 60)
 *
 * The HTTP sender is injected for testability; it defaults to global fetch.
 * Sends are fire-and-forget so callers on the event path never block.
 */
class Notifier {
  constructor(config = {}, deps = {}) {
    this.log = deps.logger || console;
    this.now = deps.now || (() => Date.now());
    this.sender = deps.sender || defaultSender;
    this.url = config.webhook_url || '';
    this.on = Array.isArray(config.on) ? config.on : [];
    this.minIntervalMs = (config.min_interval_seconds == null ? 60 : config.min_interval_seconds) * 1000;
    this.enabled = !!(config.enabled && this.url);
    this._lastSent = new Map();
    this.stats = { sent: 0, suppressed: 0, failed: 0, last: null };
  }

  notify(alert) {
    if (!this.enabled || !alert || !alert.type) return;
    if (this.on.length && !this.on.includes(alert.type)) return;

    const nowTs = this.now();
    const last = this._lastSent.get(alert.type);
    if (last != null && nowTs - last < this.minIntervalMs) {
      this.stats.suppressed++;
      return;
    }
    this._lastSent.set(alert.type, nowTs);

    const body = Object.assign(
      { source: 'unifi-access-orchestrator', time: new Date().toISOString() },
      alert
    );
    this.stats.last = { type: alert.type, time: body.time };

    Promise.resolve()
      .then(() => this.sender(this.url, body))
      .then(() => { this.stats.sent++; })
      .catch((err) => {
        this.stats.failed++;
        this.log.warn && this.log.warn(`Notifier send failed (${alert.type}): ${err.message}`);
      });
  }

  getStatus() {
    return {
      enabled: this.enabled,
      url_configured: !!this.url,
      types: this.on,
      stats: Object.assign({}, this.stats),
    };
  }
}

async function defaultSender(url, body) {
  if (typeof fetch !== 'function') throw new Error('global fetch unavailable');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

module.exports = Notifier;
