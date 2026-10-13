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
  const isAnswer = type === 'access.remotecall.accepted'
    || (type === 'access.door.unlock' && provider === CALL_PROVIDER && (ev.result == null || ev.result === 'ACCESS'));
  if (!isAnswer) return null;
  const actor = src.actor || {};
  const id = str(actor.id) || str(actor.user_id);
  const name = str(actor.display_name) || str(actor.name) || str(actor.alternate_name);
  // A call forwarded to a phone answers as the phone number; that is not a
  // viewer anyone can pick, so skip it.
  if (!name || /^\+?\d[\d\s-]{6,}$/.test(name)) return null;
  return { id, name };
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
    return e.id ? `id:${e.id}` : `name:${normName(e.name)}`;
  }

  /** Record one viewer. Returns true when the catalog changed. */
  note({ id = null, name, type = null, source }) {
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
    const key = id ? `id:${id}` : `name:${normName(name)}`;
    const prev = this.entries.get(key);
    const next = { id, name, type: type || (prev && prev.type) || null, source: source || (prev && prev.source) || null, last_seen: at };
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

module.exports = { ViewerCatalog, viewersFromDevices, callActorFromSource };
