'use strict';

/**
 * Missed-trigger accounting (pure, unit-testable).
 *
 * While the WebSocket to the controller is down, no access event reaches this
 * app, so a badge-in or doorbell answer at a trigger door runs no cascade. The
 * controller still records every entry in its own system log. After the
 * connection comes back, the caller fetches that log for the gap and passes
 * the hits here; what comes back is the list of entries that would have been
 * handed to the automation and never were.
 *
 * Nothing here unlocks anything. Running a cascade minutes or hours after the
 * badge-in would open interior doors for nobody, so a missed trigger is only
 * ever recorded.
 *
 * Hit shape (POST /api/v1/developer/system/logs, topic door_openings):
 *   { '@timestamp', _source: { actor: { id, display_name, type },
 *     authentication: { credential_provider } | null,
 *     event: { type, result, published (epoch ms), display_message, log_key },
 *     target: [ { type: 'door' | 'reason_code' | ..., id, display_name } ] } }
 */

const REMOTE_PROVIDER = 'REMOTE_THROUGH_UAH';
// An entry the orchestrator itself caused within this window after a missed
// candidate means the app did receive and act on it (the gap edges are only
// accurate to a few seconds), so the candidate is not reported.
const HANDLED_WINDOW_MS = 30 * 1000;

function normName(s) {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

function normalizeHit(hit) {
  const src = (hit && hit._source) || {};
  const ev = src.event || {};
  const actor = src.actor || {};
  const targets = Array.isArray(src.target) ? src.target : [];
  const door = targets.find((t) => t && t.type === 'door') || {};
  const reason = targets.find((t) => t && t.type === 'reason_code');
  let at = Number(ev.published);
  if (!Number.isFinite(at) || at <= 0) at = Date.parse(hit && hit['@timestamp']);
  return {
    at: Number.isFinite(at) ? at : null,
    type: ev.type || '',
    result: ev.result || '',
    message: ev.display_message || '',
    door: door.display_name || door.alternate_name || '',
    doorId: door.id || null,
    actor: actor.display_name || actor.alternate_name || '',
    actorId: actor.id || null,
    actorType: actor.type || '',
    provider: (src.authentication && src.authentication.credential_provider) || '',
    reasonCode: reason ? (reason.display_name || reason.id || null) : null,
  };
}

/**
 * @param {object[]} hits             raw system-log hits for the gap
 * @param {object}   o
 * @param {string[]} o.triggerDoors   doors that have at least one trigger
 * @param {string}   [o.selfActorName] the orchestrator's actor name
 * @param {number}   o.from           gap start, epoch ms
 * @param {number}   o.until          gap end, epoch ms
 * @returns {object[]} missed entries, oldest first
 */
function findMissedTriggers(hits, { triggerDoors = [], selfActorName = 'Access Orchestrator', from, until } = {}) {
  const doors = new Set(triggerDoors.map(normName).filter(Boolean));
  const self = normName(selfActorName);
  const all = (Array.isArray(hits) ? hits : []).map(normalizeHit).filter((e) => e.at != null);

  // The app's own unlocks, by door, so an entry it already acted on is not
  // reported as missed.
  const selfUnlocks = all.filter((e) => normName(e.actor) === self);

  const missed = all.filter((e) => {
    if (e.at < from || e.at > until) return false;
    if (!doors.has(normName(e.door))) return false;
    if (!/^access\.door\.unlock/.test(e.type)) return false;
    if (e.result && e.result !== 'ACCESS') return false;      // a denial triggers nothing
    if (normName(e.actor) === self) return false;              // our own cascade unlocks
    // A device (motion sensor, exit button) opening the door is not a trigger.
    if (e.actorType && e.actorType !== 'user' && e.actorType !== 'visitor') return false;
    // Handled after all: the app unlocked something right after this entry.
    return !selfUnlocks.some((s) => s.at >= e.at && s.at - e.at <= HANDLED_WINDOW_MS);
  });

  return missed
    .sort((a, b) => a.at - b.at)
    .map((e) => Object.assign(e, {
      how: e.provider === REMOTE_PROVIDER
        ? 'remote unlock (doorbell answer or app)'
        : (e.provider ? e.provider.toLowerCase().replace(/_/g, ' ') : 'credential'),
    }));
}

// Door names that carry at least one trigger in door_flows.
function triggerDoorsFromFlows(doorFlows) {
  const out = [];
  for (const [name, flow] of Object.entries(doorFlows || {})) {
    if (!flow) continue;
    const triggers = Array.isArray(flow.triggers) ? flow.triggers : [];
    // The legacy flat shape ({ retract, cascade } on the door) is one trigger.
    if (triggers.length || flow.retract || flow.cascade) out.push(name);
  }
  return out;
}

module.exports = { findMissedTriggers, triggerDoorsFromFlows, normalizeHit, HANDLED_WINDOW_MS };
