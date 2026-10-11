'use strict';

/**
 * Sustained-condition monitor for connectivity alerting. Polls a boolean
 * check on an interval and fires onDown ONCE after the condition has been
 * continuously down for graceSeconds (so a brief blip never alerts), then
 * fires onUp once when it recovers. A check may return null to mean
 * "not applicable right now" (e.g. no lock is paired, or the event source is
 * not the WebSocket); that resets the monitor without alerting.
 *
 * resumeDownSince continues an outage that began before a process restart:
 * the duration counts from the original start and onDown receives
 * { resumed: true }.
 *
 * Fully injectable for tests: pass now/setIntervalFn/clearIntervalFn, or skip
 * start() entirely and drive _tick() by hand.
 */
class SustainedFlagMonitor {
  constructor({
    name,
    check,                 // () => true (up) | false (down) | null (not applicable)
    onDown,                // (downSeconds) => {}
    onUp,                  // (downSeconds) => {}
    graceSeconds = 60,
    intervalSeconds = 15,
    logger = console,
    now = () => Date.now(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    // ms epoch of an outage carried over from before a process restart (the
    // event-source watchdog restarts the app every hour while the socket stays
    // down). Without it each restart started a fresh outage, so a two-day
    // outage read as hourly "down for 60s" alerts and a recovery that only
    // counted the last hour.
    resumeDownSince = null,
  }) {
    this.name = name;
    this.check = check;
    this.onDown = onDown || (() => {});
    this.onUp = onUp || (() => {});
    this.graceMs = graceSeconds * 1000;
    this.intervalMs = intervalSeconds * 1000;
    this.logger = logger;
    this.now = now;
    this._setInterval = setIntervalFn;
    this._clearInterval = clearIntervalFn;

    this._timer = null;
    this._downSince = null;   // ms epoch of the first down reading, or null
    this._alerted = false;    // onDown fired for the current outage
    this._resumed = false;    // the current outage began before this process
    this._graceFrom = null;   // grace anchor for a resumed outage
    if (Number.isFinite(resumeDownSince) && resumeDownSince > 0) {
      this._downSince = resumeDownSince;
      this._resumed = true;
    }
  }

  // ms epoch the current outage began, or null when up.
  get downSince() {
    return this._downSince;
  }

  start() {
    if (this._timer) return;
    this._timer = this._setInterval(() => this._tick(), this.intervalMs);
    if (this._timer && this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) this._clearInterval(this._timer);
    this._timer = null;
  }

  _reset() {
    this._downSince = null;
    this._alerted = false;
    this._resumed = false;
    this._graceFrom = null;
  }

  _tick() {
    let up;
    try {
      up = this.check();
    } catch (e) {
      // A throwing check means the subsystem is not inspectable; treat as
      // not-applicable rather than spamming outage alerts.
      up = null;
    }

    if (up === null || up === undefined) {
      this._reset();
      return;
    }

    const t = this.now();
    if (up) {
      // A resumed outage was already reported by the previous process, so its
      // recovery is announced even if this process never re-alerted.
      if (this._alerted || this._resumed) {
        const downSeconds = this._downSince ? Math.round((t - this._downSince) / 1000) : 0;
        this._safeFire(this.onUp, downSeconds);
      }
      this._reset();
      return;
    }

    // down
    if (this._downSince == null) this._downSince = t;
    // A resumed outage still gets a full grace window in this process, so a
    // socket that reconnects right after the restart never re-alerts. The
    // reported duration counts from the original start either way.
    if (this._resumed && this._graceFrom == null) this._graceFrom = t;
    const anchor = this._graceFrom != null ? this._graceFrom : this._downSince;
    if (!this._alerted && t - anchor >= this.graceMs) {
      this._alerted = true;
      this._safeFire(this.onDown, Math.round((t - this._downSince) / 1000), { resumed: this._resumed });
    }
  }

  _safeFire(fn, downSeconds, info = {}) {
    try {
      fn(downSeconds, info);
    } catch (e) {
      this.logger.warn && this.logger.warn(`${this.name} monitor callback error: ${e.message}`);
    }
  }
}

module.exports = { SustainedFlagMonitor };
