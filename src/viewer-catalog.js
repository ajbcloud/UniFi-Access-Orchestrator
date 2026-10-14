'use strict';

/**
 * Viewer catalog (pure apart from the optional file store).
 *
 * The intercom viewers that can answer a G3 Intercom call, keyed by their
 * UniFi id so a doorbell trigger keeps matching after a viewer is renamed in
 * the UniFi portal. The name is only a label: it is refreshed from whatever
 * the controller reports last.
 *
 * Three sources feed it, because no single one is guaranteed to list viewers:
 *   - GET /devices (the controller's device list), filtered to viewer types;
 *   - the controller's system log (door_openings): every intercom answer is a
 *     door unlock with credential provider CALL and the viewer as the actor;
 *   - live WebSocket events: access.remotecall.accepted and CALL unlocks.
 * Entries are persisted so a viewer learned from an event survives a restart
 * even when the API token cannot read the system log.
 */

const fs = require('fs');
const { normalizePhone } = require('./door-flows');

const CALL_PROVIDER = 'call';
const VIEWER_RE = /viewer/i;

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function normName(s) {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

// The actor of a call event, from either the WebSocket access.logs.add
// wrapper or a system-log hit (both carry the same _source shape).
function callActorFromSource(src) {
  if (!src || typeof src !== 'object') return null;
  const ev = src.event || {};
  const type = ev.type || '';
  const provider = normName(src.authentication && src.authentication.credential_provider);
  const actor = src.actor || {};
  const id = str(actor.id) || str(actor.user_id);
  const name = str(actor.display_name) || str(actor.name) || str(actor.alternate_name);
  if (!name) return null;
  // A call forwarded to a phone and answered there names the phone number as
  // the actor ("unlocked remotely using phone number ..."), and the unlock may
  // not carry the CALL provider, so a phone-number actor on an unlock counts.
  const phone = normalizePhone(name);
  const granted = ev.result == null || ev.result === 'ACCESS';
  const isAnswer = type === 'access.remotecall.accepted'
    || (type === 'access.door.unlock' && granted && (provider === CALL_PROVIDER || !!phone));
  if (!isAnswer) return null;
  return phone ? { id: null, name: phone, phone } : { id, name };
}

// Flatten GET /devices: the controller returns either a flat array or one
// array per hub. Keep anything that looks like a viewer by type or model.
function viewersFromDevices(data) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    const id = str(v.id) || str(v.unique_id);
    const name = str(v.alias) || str(v.name);
    const kind = [v.type, v.device_type, v.model, v.display_model].filter((x) => typeof x === 'string').join(' ');
    if (id && name && VIEWER_RE.test(kind)) out.push({ id, name, type: str(v.type) || str(v.device_type) || null });
  };
  walk(data);
  return out;
}

class ViewerCatalog {
  constructor({ filePath = null, logger = null, now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.log = logger;
    this.now = now;
    this.entries = new Map(); // key (id or "name:<lower>") -> { id, name, type, source, last_seen }
    this.onChange = null;
  }

  load() {
    if (!this.filePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      for (const e of Array.isArray(raw) ? raw : []) {
        if (e && str(e.name)) this.entries.set(this._key(e), Object.assign({}, e));
      }
    } catch (e) { /* no file yet, or unreadable: start empty */ }
  }

  _save() {
    if (!this.filePath) return;
    try { fs.writeFileSync(this.filePath, JSON.stringify(this.list(), null, 2)); } catch (e) {
      this.log && this.log.warn && this.log.warn(`Could not save viewer list: ${e.message}`);
    }
  }

  _key(e) {
    if (e.phone) return `phone:${e.phone}`;
    return e.id ? `id:${e.id}` : `name:${normName(e.name)}`;
  }

  /** Record one viewer. Returns true when the catalog changed. */
  note({ id = null, name, type = null, source, phone = null }) {
    phone = normalizePhone(phone);
    if (phone) { id = null; name = phone; }
    name = str(name);
    if (!name) return false;
    id = str(id);
    const at = new Date(this.now()).toISOString();
    // A name-only entry is upgraded in place once the same viewer shows up
    // with an id.
    if (id) {
      const nameKey = `name:${normName(name)}`;
      if (this.entries.has(nameKey)) this.entries.delete(nameKey);
    }
    const key = this._key({ id, name, phone });
    const prev = this.entries.get(key);
    const next = { id, name, type: type || (prev && prev.type) || null, source: source || (prev && prev.source) || null, last_seen: at };
    if (phone) next.phone = phone;
    const changed = !prev || prev.name !== next.name || prev.type !== next.type;
    if (changed && prev && prev.name !== name && this.log && this.log.info) {
      this.log.info(`Viewer ${id || ''} renamed on the controller: "${prev.name}" -> "${name}"`);
    }
    this.entries.set(key, next);
    if (changed) {
      this._save();
      if (typeof this.onChange === 'function') this.onChange();
    }
    return changed;
  }

  noteDevices(data) {
    let changed = false;
    for (const v of viewersFromDevices(data)) changed = this.note(Object.assign({ source: 'devices' }, v)) || changed;
    return changed;
  }

  noteLogHits(hits) {
    let changed = false;
    // Oldest first, so the newest name a viewer answered under wins.
    const sorted = (Array.isArray(hits) ? hits : []).slice().sort((a, b) =>
      Number((a && a._source && a._source.event && a._source.event.published) || 0)
      - Number((b && b._source && b._source.event && b._source.event.published) || 0));
    for (const h of sorted) {
      const a = callActorFromSource(h && h._source);
      if (a) changed = this.note(Object.assign({ source: 'system_log' }, a)) || changed;
    }
    return changed;
  }

  /** Learn from a raw WebSocket event. Returns true when the catalog changed. */
  observe(raw) {
    if (!raw || typeof raw !== 'object') return false;
    const type = raw.event || raw.type || '';
    if (type !== 'access.logs.add') return false;
    const a = callActorFromSource(raw.data && raw.data._source);
    return a ? this.note(Object.assign({ source: 'event' }, a)) : false;
  }

  byId(id) {
    return id ? this.entries.get(`id:${id}`) || null : null;
  }

  byName(name) {
    const n = normName(name);
    if (!n) return null;
    for (const e of this.entries.values()) if (normName(e.name) === n) return e;
    return null;
  }

  /** Every entry with this name. The device list and live events can report
   *  one viewer under different ids, so a name may map to more than one. */
  allByName(name) {
    const n = normName(name);
    if (!n) return [];
    return [...this.entries.values()].filter((e) => normName(e.name) === n);
  }

  list() {
    return [...this.entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

// When one name maps to several ids (the device list and live events can
// disagree), prefer the id the events carry, since that is what a call is
// matched on, then the most recently seen.
const SOURCE_RANK = { event: 0, system_log: 1, devices: 2 };
function bestIdFor(catalog, name) {
  const hits = catalog.allByName(name).filter((e) => e.id);
  if (!hits.length) return null;
  hits.sort((a, b) => ((SOURCE_RANK[a.source] ?? 3) - (SOURCE_RANK[b.source] ?? 3))
    || String(b.last_seen || '').localeCompare(String(a.last_seen || '')));
  return hits[0].id;
}

/**
 * Give viewers that were typed in by name their UniFi id, so they become
 * rename-proof without anyone re-picking them. A doorbell trigger that only
 * has the legacy viewer_to_group name map gets a viewers list built from it
 * (every name kept, with an id where the catalog knows the name exactly); an
 * existing name-only entry gets its id filled in. A name the catalog does not
 * know is left as is and still matches by name.
 *
 * Mutates `flows` in place and returns [{ door, name, id }] for each viewer
 * that gained an id. Idempotent.
 */
function upgradeNameOnlyViewers(flows, catalog) {
  const { triggersOf, canonicalizeViewers } = require('./door-flows');
  const upgraded = [];
  for (const [door, flow] of Object.entries(flows || {})) {
    for (const trig of triggersOf(flow)) {
      if (!trig || trig.type !== 'doorbell' || !trig.doorbell) continue;
      const db = trig.doorbell;
      let list;
      if (Array.isArray(db.viewers)) {
        list = canonicalizeViewers(db.viewers);
      } else {
        const names = Object.keys(db.viewer_to_group || {});
        if (!names.length) continue;
        list = names.map((name) => ({ id: null, name }));
      }
      let changed = !Array.isArray(db.viewers) && list.some((v) => !v.id && bestIdFor(catalog, v.name));
      for (const v of list) {
        if (v.id || v.phone || !v.name) continue;
        const id = bestIdFor(catalog, v.name);
        if (!id || list.some((o) => o.id === id)) continue;
        v.id = id;
        upgraded.push({ door, name: v.name, id });
        changed = true;
      }
      if (changed) db.viewers = list;
    }
  }
  return upgraded;
}

module.exports = { ViewerCatalog, viewersFromDevices, callActorFromSource, upgradeNameOnlyViewers };
