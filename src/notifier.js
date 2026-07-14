'use strict';

/**
 * Notifier: outbound alerting for the orchestrator.
 *
 * The review flagged "no outbound alerting" as the top day-2 gap: an MSP does
 * not sit watching the dashboard, so a failed deadbolt retract (someone locked
 * out), a jam, a lost controller, or a sustained unlock failure must reach a
 * human out of band. Three channels, any subset enabled, no cloud dependency
 * required:
 *   webhook  generic JSON POST (on-prem collector, ntfy-style relay)
 *   chat     Slack or Teams incoming webhook (payload formatted per service)
 *   email    SMTP via nodemailer (an OPTIONAL dependency: an install without
 *            it still runs, the channel just reports itself unavailable)
 *
 * Config (config.alerts):
 *   enabled: boolean          // master switch for all channels
 *   webhook_url: string       // generic channel (back-compat, unchanged)
 *   chat: { type: 'slack'|'teams', webhook_url }
 *   email: { smtp_host, smtp_port, smtp_user, smtp_password, smtp_secure,
 *            from, to: [] }   // smtp_password named to match the config
 *                             // redaction regex, so GET /api/config hides it
 *   on: string[]              // alert types to send; empty = send all
 *   min_interval_seconds: number  // per-type de-dupe window (default 60)
 *
 * De-dupe stays GLOBAL per alert type (one decision for all channels), same
 * semantics the single-channel version had. Senders are injected for tests;
 * sends are fire-and-forget so callers on the event path never block.
 */

// Plain-language severity shipped with every payload so receivers can route
// without knowing our type strings.
const SEVERITY = Object.freeze({
  deadbolt_retract_failed: 'critical',
  deadbolt_lock_failed: 'critical',
  deadbolt_jammed: 'critical',
  deadbolt_no_transport: 'critical',
  cascade_failed: 'warning',
  deadbolt_lock_offline: 'warning',
  deadbolt_low_battery: 'warning',
  controller_disconnected: 'warning',
  deadbolt_lock_online: 'info',
  controller_reconnected: 'info',
});

class Notifier {
  constructor(config = {}, deps = {}) {
    this.log = deps.logger || console;
    this.now = deps.now || (() => Date.now());
    this.sender = deps.sender || defaultSender;       // webhook + chat HTTP POST
    this.mailer = deps.mailer || null;                // test seam; lazy nodemailer otherwise
    this.url = config.webhook_url || '';
    this.chat = config.chat && config.chat.webhook_url ? {
      type: config.chat.type === 'teams' ? 'teams' : 'slack',
      url: config.chat.webhook_url,
    } : null;
    const em = config.email || {};
    this.email = (em.smtp_host && em.from && Array.isArray(em.to) && em.to.length) ? {
      host: em.smtp_host,
      port: em.smtp_port || 587,
      secure: !!em.smtp_secure,
      user: em.smtp_user || null,
      password: em.smtp_password || null,
      from: em.from,
      to: em.to,
    } : null;
    this.on = Array.isArray(config.on) ? config.on : [];
    this.minIntervalMs = (config.min_interval_seconds == null ? 60 : config.min_interval_seconds) * 1000;
    const anyChannel = !!(this.url || this.chat || this.email);
    this.enabled = !!(config.enabled && anyChannel);
    this._lastSent = new Map();
    this._transport = null; // cached nodemailer transport
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

    const severity = SEVERITY[alert.type] || 'warning';
    const body = Object.assign(
      { source: 'unifi-access-orchestrator', severity, time: new Date().toISOString() },
      alert
    );
    this.stats.last = { type: alert.type, time: body.time };

    // Fan out to every configured channel; each send succeeds or fails on its
    // own so one dead channel cannot silence the others.
    if (this.url) this._deliver(alert.type, () => this.sender(this.url, body));
    if (this.chat) {
      const payload = this.chat.type === 'teams' ? formatTeams(body) : formatSlack(body);
      this._deliver(alert.type, () => this.sender(this.chat.url, payload));
    }
    if (this.email) this._deliver(alert.type, () => this._sendEmail(body));
  }

  _deliver(type, fn) {
    Promise.resolve()
      .then(fn)
      .then(() => { this.stats.sent++; })
      .catch((err) => {
        this.stats.failed++;
        this.log.warn && this.log.warn(`Notifier send failed (${type}): ${err.message}`);
      });
  }

  async _sendEmail(body) {
    const transport = this._getTransport();
    const subject = `[${body.severity}] ${body.type} (UniFi Access Orchestrator)`;
    const lines = Object.entries(body)
      .filter(([k]) => k !== 'source')
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    await transport.sendMail({
      from: this.email.from,
      to: this.email.to.join(', '),
      subject,
      text: lines.join('\n'),
    });
  }

  // nodemailer is an OPTIONAL dependency, mirroring the zwave-js pattern:
  // lazy-required only when the email channel is actually used, so installs
  // without it still boot and the failure is a clear per-send log line.
  _getTransport() {
    if (this._transport) return this._transport;
    if (this.mailer) {
      this._transport = this.mailer;
      return this._transport;
    }
    let nodemailer;
    try {
      nodemailer = require('nodemailer'); // eslint-disable-line global-require
    } catch (err) {
      throw new Error('email channel configured but nodemailer is not installed (reinstall the app, or npm install nodemailer)');
    }
    this._transport = nodemailer.createTransport({
      host: this.email.host,
      port: this.email.port,
      secure: this.email.secure,
      auth: this.email.user ? { user: this.email.user, pass: this.email.password } : undefined,
    });
    return this._transport;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      url_configured: !!this.url,
      chat_configured: !!this.chat,
      email_configured: !!this.email,
      types: this.on,
      stats: Object.assign({}, this.stats),
    };
  }
}

// Slack incoming webhooks want { text }; keep it one skimmable line with the
// detail underneath.
function formatSlack(body) {
  const head = `${severityEmoji(body.severity)} *${body.type}* (${body.severity})`;
  const detail = body.detail ? `\n${body.detail}` : '';
  return { text: `${head}${detail}\n_${body.time} via UniFi Access Orchestrator_` };
}

// Teams incoming webhooks accept the legacy MessageCard shape.
function formatTeams(body) {
  return {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: body.severity === 'critical' ? 'D93025' : body.severity === 'warning' ? 'F4B400' : '188038',
    summary: `${body.type} (${body.severity})`,
    title: `${body.type} (${body.severity})`,
    text: body.detail || body.type,
    sections: [{ facts: [
      { name: 'time', value: body.time },
      { name: 'source', value: body.source },
    ] }],
  };
}

function severityEmoji(sev) {
  if (sev === 'critical') return ':rotating_light:';
  if (sev === 'warning') return ':warning:';
  return ':white_check_mark:';
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
