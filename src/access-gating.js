'use strict';

/**
 * Access gating for keypad-PIN sync, kept pure so it is testable without the
 * app. Product rule: a user only gets a keypad code on a deadbolt whose
 * associated UniFi door their UniFi access allows them to open. The door a
 * deadbolt is gated on is its existing deadbolt_rules[lockId].trigger_door;
 * "who may open which door" comes from each user's UniFi access policies
 * (GET /users?expand[]=access_policy).
 *
 * SAFETY KEYSTONE: revocation must never fire on uncertainty. When access
 * data is unavailable or a user's policy references a door group we could not
 * expand, the verdict is 'unknown', and 'unknown' never denies. Only a
 * confirmed denial (data present AND complete for that user AND the lock's
 * door not in their allowed set) blocks or revokes. An API hiccup must never
 * mass-wipe keypad codes.
 */

const deadboltRules = require('./deadbolt-rules');

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
 * Classify a user's access to each lock in lockList.
 * @param {string} userId
 * @param {Array}  lockList        [{lock_id, ...}]
 * @param {object} deadboltRulesCfg config.deadbolt_rules
 * @param {object} access          from buildAccess()
 * @returns {Array<{lock_id, verdict, door}>}
 */
function classifyLocksForUser(userId, lockList, deadboltRulesCfg, access) {
  return (lockList || []).map((l) => {
    const rule = deadboltRules.rulesForLock(deadboltRulesCfg, l.lock_id);
    const name = (rule && rule.trigger_door) || null;
    const id = (rule && rule.trigger_door_id) || null;
    // Prefer the stored door id (rename-proof), keep the name for display.
    return { lock_id: l.lock_id, verdict: doorAccessVerdict(access, userId, { id, name }), door: name };
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
  classifyLocksForUser,
  WRITE_VERDICTS,
  REVOKE_VERDICTS,
  PROVISION_VERDICTS,
};
