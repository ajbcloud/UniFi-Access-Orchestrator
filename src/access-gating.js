'use strict';

/**
 * Access gating for keypad-PIN sync, kept pure so it is testable without the
 * app. Product rule: a user only gets a keypad code on a deadbolt whose
 * triggering UniFi door(s) their UniFi access allows them to open. A lock's
 * gating doors are the doors with a retract edge to it in door_flows
 * (door-centric model; a lock may be triggered by SEVERAL doors, and being
 * allowed on ANY of them grants keypad eligibility - the union rule). "Who
 * may open which door" comes from each user's UniFi access policies
 * (GET /users?expand[]=access_policy).
 *
 * SAFETY KEYSTONE: revocation must never fire on uncertainty. When access
 * data is unavailable or a user's policy references a door group we could not
 * expand, the verdict is 'unknown', and 'unknown' never denies. Only a
 * confirmed denial (data present AND complete for that user AND the user
 * denied on EVERY known gating door) blocks or revokes. An API hiccup must
 * never mass-wipe keypad codes.
 */

const doorFlows = require('./door-flows');

/**
 * Parse UniFi access-policy data into per-user allowed door-id sets.
 *
 * @param {Array}  users       [{id, access_policies:[{resources:[{type,id}]}]}]
 *                             as returned by GET /users?expand[]=access_policy
 * @param {object} doorGroups  Map/obj: doorGroupId -> Set/array of door ids
 *                             (to expand 'door_group' resources). May be empty.
 * @returns {{ allowedDoorsByUser: Map<string,Set<string>>,
 *            completeByUser: Map<string,boolean> }}
 *   completeByUser is false for a user whose policy referenced a resource we
 *   could not resolve to concrete door ids (unknown type, or a door_group not
 *   present in doorGroups) - those users fail OPEN downstream.
 */
function parseAccessPolicies(users, doorGroups) {
  const groupToDoors = doorGroups instanceof Map ? doorGroups : new Map(Object.entries(doorGroups || {}));
  const allowedDoorsByUser = new Map();
  const completeByUser = new Map();
  let groupsReferenced = false; // any user grants access through a door_group
  for (const user of users || []) {
    if (!user || !user.id) continue;
    const doors = new Set();
    let complete = true;
    const policies = Array.isArray(user.access_policies) ? user.access_policies : [];
    for (const policy of policies) {
      const resources = (policy && Array.isArray(policy.resources)) ? policy.resources : [];
      for (const res of resources) {
        if (!res) continue;
        if (res.type === 'door') {
          if (res.id) doors.add(String(res.id));
          else complete = false;
        } else if (res.type === 'door_group') {
          groupsReferenced = true;
          const members = groupToDoors.get(String(res.id));
          if (members) for (const d of members) doors.add(String(d));
          else complete = false; // group we could not expand -> fail open
        } else {
          // Unknown resource type (e.g. a future "all doors" shape): we
          // cannot enumerate it, so treat this user's view as incomplete.
          complete = false;
        }
      }
    }
    allowedDoorsByUser.set(String(user.id), doors);
    completeByUser.set(String(user.id), complete);
  }
  return { allowedDoorsByUser, completeByUser, groupsReferenced };
}

/**
 * Normalize the inputs a verdict needs into one object.
 *
 * @param {object} opts
 * @param {boolean} opts.available            access-policy data usable
 * @param {Map|object} opts.doorsByName       door name -> door id
 * @param {Map} opts.allowedDoorsByUser       userId -> Set(doorId)
 * @param {Map} opts.completeByUser           userId -> bool
 */
function buildAccess(opts) {
  const o = opts || {};
  const doorsByName = o.doorsByName instanceof Map
    ? o.doorsByName
    : new Map(Object.entries(o.doorsByName || {}));
  const doorsById = o.doorsById instanceof Map
    ? o.doorsById
    : new Map(Object.entries(o.doorsById || {}));
  return {
    available: !!o.available,
    doorsByName,
    doorsById, // door id -> name; used to confirm a rule's trigger_door_id still exists
    allowedDoorsByUser: o.allowedDoorsByUser instanceof Map ? o.allowedDoorsByUser : new Map(),
    completeByUser: o.completeByUser instanceof Map ? o.completeByUser : new Map(),
  };
}

/**
 * Verdict for one user against one gating door. The door is given either as a
 * bare name (back-compat) or as a { id, name } spec. A stored door id is
 * preferred and survives a rename, with the name kept as a fallback and for
 * display, so a door rename in UniFi no longer silently un-gates a lock.
 * @returns {'allowed'|'denied'|'ungated'|'unknown'}
 *   ungated: the lock has no gating door -> today's "all users" behavior.
 *   unknown: cannot decide safely -> callers fail OPEN (never revoke).
 */
function doorAccessVerdict(access, userId, door) {
  const spec = (door && typeof door === 'object') ? door : { id: null, name: door || null };
  const name = spec.name || null;
  const id = spec.id != null ? String(spec.id) : null;
  if (!id && !name) return 'ungated';
  if (!access || !access.available) return 'unknown';
  let doorId = null;
  if (id && access.doorsById && access.doorsById.has(id)) doorId = id; // confirmed id wins
  if (!doorId && name) {
    const byName = access.doorsByName.get(name);
    if (byName) doorId = String(byName); // fall back to the name lookup
  }
  if (!doorId) return 'unknown'; // id not confirmed and name not discovered / renamed
  if (access.completeByUser.get(String(userId)) === false) return 'unknown';
  const allowed = access.allowedDoorsByUser.get(String(userId));
  return allowed && allowed.has(doorId) ? 'allowed' : 'denied';
}

/**
 * UNION verdict for one user against a lock's full set of gating doors.
 * A lock triggered by several doors admits a user who is allowed on ANY of
 * them. Collapse rules (in precedence order):
 *   no doors            -> 'ungated'  (no trigger doors = serves everyone)
 *   any door 'allowed'  -> 'allowed'
 *   else any 'unknown'  -> 'unknown'  (fail OPEN - never deny on uncertainty)
 *   else                -> 'denied'   (denied on EVERY known gating door)
 *
 * THE SAFETY-CRITICAL CONTRACT: every consumer - including the automatic
 * reconcile-on-sync revoker - receives THIS collapsed verdict, never a
 * per-door one. Feeding a single door's 'denied' into the revoke planner
 * would silently wipe codes for users allowed through another door.
 * For a single-door lock this is exactly doorAccessVerdict.
 *
 * @param {Array<{id,name}|string>} doors the lock's gating doors
 * @returns {'allowed'|'denied'|'ungated'|'unknown'}
 */
function doorAccessVerdictUnion(access, userId, doors) {
  const list = Array.isArray(doors) ? doors : [];
  if (!list.length) return 'ungated';
  let sawUnknown = false;
  for (const door of list) {
    const v = doorAccessVerdict(access, userId, door);
    if (v === 'allowed') return 'allowed';
    if (v === 'unknown' || v === 'ungated') sawUnknown = true; // malformed spec fails open
  }
  return sawUnknown ? 'unknown' : 'denied';
}

/**
 * Classify a user's access to each lock in lockList against door_flows.
 * @param {string} userId
 * @param {Array}  lockList     [{lock_id, ...}]
 * @param {object} doorFlowsCfg config.door_flows
 * @param {object} access       from buildAccess()
 * @returns {Array<{lock_id, verdict, doors}>} doors = display names (may be
 *   empty = ungated); verdict is the collapsed union verdict.
 */
function classifyLocksForUser(userId, lockList, doorFlowsCfg, access) {
  return (lockList || []).map((l) => {
    const gatingDoors = doorFlows.gatingDoorsForLock(doorFlowsCfg, l.lock_id);
    return {
      lock_id: l.lock_id,
      verdict: doorAccessVerdictUnion(access, userId, gatingDoors),
      doors: gatingDoors.map((d) => d.name),
    };
  });
}

// Which verdicts each caller acts on (single source of truth for the policy).
const WRITE_VERDICTS = new Set(['allowed', 'ungated', 'unknown']); // fail open
const REVOKE_VERDICTS = new Set(['denied']);                        // only sure denials
const PROVISION_VERDICTS = new Set(['allowed', 'ungated']);         // additive; defer unknown

module.exports = {
  parseAccessPolicies,
  buildAccess,
  doorAccessVerdict,
  doorAccessVerdictUnion,
  classifyLocksForUser,
  WRITE_VERDICTS,
  REVOKE_VERDICTS,
  PROVISION_VERDICTS,
};
