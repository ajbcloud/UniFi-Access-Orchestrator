'use strict';

// ---------------------------------------------------------------------------
// Event-source watchdog decision logic (pure, unit-testable)
//
// The process-level watchdog used to restart the whole app whenever no ACCESS
// EVENT had arrived for the timeout window. That conflated "quiet" with
// "broken": a healthy, connected controller with no door traffic (overnight, a
// low-traffic door) was force-restarted roughly every hour, wiping the live
// feed and all in-memory state.
//
// This module judges the EVENT SOURCE's health instead. In websocket mode that
// is inbound-frame liveness (lastWsInboundAt), which the client already
// refreshes on any message/ping/pong/open — so a reachable-but-quiet controller
// keeps it fresh and never trips. Only a source that genuinely cannot
// establish or deliver lets the staleness grow past the thresholds.
//
// Two-stage escalation, least-disruptive first:
//   - 'reconnect': after reconnectAfterMs of an unhealthy source, force a fresh
//     in-process event-source connection. Loses nothing in RAM.
//   - 'rebuild': after timeoutMs of continuous unhealth, rebuild the whole
//     controller client in process (fresh HTTP agent, socket and sync state),
//     and again every timeoutMs while it stays down. The app keeps running.
//   - 'restart' replaces 'rebuild' only when allowRestart is set
//     (watchdog.restart_on_outage). A full process restart never helped a
//     controller that is down or unreachable: a two-day outage produced 45
//     hourly restarts and every one hit the same timeout, while each restart
//     cut the Z-Wave link and the live feed. Off by default.
//
// The function holds no state; the caller owns the "already tried a reconnect"
// latch via reconnectAlreadyTried and the returned staleMs.
// ---------------------------------------------------------------------------

/**
 * @param {object} s
 * @param {string} s.mode                  event_source.mode ('websocket' | 'api_webhook' | ...)
 * @param {number} s.now                   Date.now()
 * @param {boolean} s.hasHost              controller host configured
 * @param {number} s.timeoutMs             hard-restart threshold (0/undefined = disabled)
 * @param {number} s.reconnectAfterMs      soft-reconnect threshold (< timeoutMs)
 * @param {number} s.lastWsInboundAt       last inbound WS frame (0 if never connected)
 * @param {number} s.watchdogStartedAt     when the watchdog was (re)armed; first-boot grace anchor
 * @param {string} [s.connectionState]     unifiClient.connectionState (informational)
 * @param {number} s.lastEventTime         last access event / webhook POST time
 * @param {boolean} s.reconnectAlreadyTried caller's latch: a reconnect was already issued this outage
 * @param {boolean} [s.allowRestart]       hard stage restarts the process instead of rebuilding in place
 * @returns {{action: 'ok'|'reconnect'|'rebuild'|'restart', reason: string, staleMs: number}}
 */
function decideWatchdogAction(s) {
  if (!s.timeoutMs || s.timeoutMs <= 0) return { action: 'ok', reason: 'disabled', staleMs: 0 };
  if (!s.hasHost) return { action: 'ok', reason: 'no-controller', staleMs: 0 };
  const hard = s.allowRestart ? 'restart' : 'rebuild';

  if (s.mode === 'websocket') {
    // Before the first connection lastWsInboundAt is 0; anchor the grace window
    // to when the watchdog was armed so a normal boot (socket opens within
    // seconds) never trips, while a configured-but-unreachable controller still
    // escalates after the window (genuinely broken).
    const lastHealthy = s.lastWsInboundAt > 0 ? s.lastWsInboundAt : s.watchdogStartedAt;
    const staleMs = s.now - lastHealthy;
    if (staleMs >= s.timeoutMs) return { action: hard, reason: 'ws-source-unhealthy', staleMs };
    if (staleMs >= s.reconnectAfterMs && !s.reconnectAlreadyTried) {
      return { action: 'reconnect', reason: 'ws-source-stale', staleMs };
    }
    return { action: 'ok', reason: 'ws-healthy', staleMs };
  }

  if (s.mode === 'api_webhook') {
    // No persistent socket to measure; inbound POST arrival is the only signal
    // we have. Keep the arrival-based window but still escalate gently: soft
    // re-register at the window, hard restart only at twice the window.
    // Measured from the later of the last POST and the last (re)arm: a rebuild
    // re-arms the watchdog, so a quiet night gets one rebuild per window
    // instead of one every tick (a restart used to reset both clocks).
    const silentMs = s.now - Math.max(s.lastEventTime || 0, s.watchdogStartedAt || 0);
    if (silentMs >= 2 * s.timeoutMs) return { action: hard, reason: 'webhook-silent-long', staleMs: silentMs };
    if (silentMs >= s.timeoutMs && !s.reconnectAlreadyTried) {
      return { action: 'reconnect', reason: 'webhook-silent', staleMs: silentMs };
    }
    return { action: 'ok', reason: 'webhook-ok', staleMs: silentMs };
  }

  // alarm_manager / unknown: startEventSource has no ingestion branch for these,
  // so there is no source to watch. Stay inert rather than restart forever.
  return { action: 'ok', reason: 'mode-has-no-source', staleMs: 0 };
}

module.exports = { decideWatchdogAction };
