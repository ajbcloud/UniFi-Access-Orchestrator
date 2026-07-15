// Pure security helpers, kept out of index.js so they can be unit tested
// without booting the server. No Express or filesystem dependencies here.

const crypto = require('crypto');
const deadboltRules = require('./deadbolt-rules');

// Matches config keys whose values are secrets and must never be returned to a
// client or written to a log in cleartext. pin[_-]?code covers the per-user
// deadbolt keypad codes stored under devices.zwave.locks.<id>.user_codes
// (anchored as pin_code, NOT a bare "pin", so keys like "mapping" or the S2
// pairing "pin" route payloads are unaffected). The digits live in the 0600
// config in cleartext, matching the existing S2-key precedent; redaction
// keeps them out of GET /api/config, PUT round-trips, and diagnostics.
const SECRET_KEY_RX = /(token|secret|password|passphrase|api[_-]?key|private[_-]?key|s2_|s0_|pin[_-]?code)/i;

const REDACTION_MARKER = '***REDACTED***';

// Deep clone of obj with secret-valued leaves replaced by the marker. An empty
// or null secret is left as-is so a caller can still tell the field is unset
// (and so clearing a secret by sending '' still round-trips). Non-string/number
// secret values are replaced too, to avoid leaking structured material.
function redactSecrets(obj, marker = REDACTION_MARKER) {
  if (Array.isArray(obj)) return obj.map((v) => redactSecrets(v, marker));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_KEY_RX.test(k)) {
        out[k] = (v === '' || v == null) ? v : marker;
      } else {
        out[k] = redactSecrets(v, marker);
      }
    }
    return out;
  }
  return obj;
}

// Remove any secret-keyed field still carrying the redaction marker from an
// incoming update, so a UI that echoes the redacted GET response back on save
// cannot overwrite the real stored secret with the placeholder. Mutates and
// returns updates. Walks nested objects/arrays.
function stripRedactedPlaceholders(updates, marker = REDACTION_MARKER) {
  if (Array.isArray(updates)) {
    updates.forEach((v) => stripRedactedPlaceholders(v, marker));
    return updates;
  }
  if (updates && typeof updates === 'object') {
    for (const k of Object.keys(updates)) {
      const v = updates[k];
      if (SECRET_KEY_RX.test(k) && v === marker) {
        delete updates[k];
      } else if (v && typeof v === 'object') {
        stripRedactedPlaceholders(v, marker);
      }
    }
  }
  return updates;
}

const ALLOWED_EVENT_MODES = ['alarm_manager', 'api_webhook', 'websocket'];

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function isValidPort(v) {
  const p = Number(v);
  return Number.isInteger(p) && p >= 1 && p <= 65535;
}

// Shape-validate a PUT /api/config body. Only the fields that carry real risk
// if malformed are checked (a bad port, an unknown event mode, rules that are
// not arrays); anything not listed is allowed through unchanged, matching the
// existing safe-key merge. Returns { ok:true } or { ok:false, error }.
function validateConfigUpdates(updates) {
  if (!isPlainObject(updates)) {
    return { ok: false, error: 'Config must be a JSON object' };
  }

  if (updates.server !== undefined) {
    if (!isPlainObject(updates.server)) return { ok: false, error: 'server must be an object' };
    const s = updates.server;
    if (s.port !== undefined && !isValidPort(s.port)) return { ok: false, error: 'server.port must be an integer 1-65535' };
    if (s.host !== undefined && typeof s.host !== 'string') return { ok: false, error: 'server.host must be a string' };
    if (s.admin_api_key !== undefined && typeof s.admin_api_key !== 'string') return { ok: false, error: 'server.admin_api_key must be a string' };
  }

  if (updates.unifi !== undefined) {
    if (!isPlainObject(updates.unifi)) return { ok: false, error: 'unifi must be an object' };
    if (updates.unifi.port !== undefined && !isValidPort(updates.unifi.port)) return { ok: false, error: 'unifi.port must be an integer 1-65535' };
    if (updates.unifi.host !== undefined && typeof updates.unifi.host !== 'string') return { ok: false, error: 'unifi.host must be a string' };
  }

  if (updates.event_source !== undefined) {
    if (!isPlainObject(updates.event_source)) return { ok: false, error: 'event_source must be an object' };
    const mode = updates.event_source.mode;
    if (mode !== undefined && !ALLOWED_EVENT_MODES.includes(mode)) {
      return { ok: false, error: `event_source.mode must be one of: ${ALLOWED_EVENT_MODES.join(', ')}` };
    }
  }

  for (const key of ['unlock_rules', 'doorbell_rules']) {
    const sub = updates[key];
    if (sub !== undefined) {
      if (!isPlainObject(sub)) return { ok: false, error: `${key} must be an object` };
      if (sub.rules !== undefined && !Array.isArray(sub.rules)) return { ok: false, error: `${key}.rules must be an array` };
    }
  }

  if (updates.doors !== undefined && !isPlainObject(updates.doors)) return { ok: false, error: 'doors must be an object' };
  if (updates.resolver !== undefined && !isPlainObject(updates.resolver)) return { ok: false, error: 'resolver must be an object' };

  if (updates.auto_lock !== undefined) {
    if (!isPlainObject(updates.auto_lock)) return { ok: false, error: 'auto_lock must be an object' };
    if (updates.auto_lock.buttons !== undefined && !Array.isArray(updates.auto_lock.buttons)) {
      return { ok: false, error: 'auto_lock.buttons must be an array' };
    }
  }

  if (updates.cascade_rules !== undefined) {
    const cr = updates.cascade_rules;
    if (!isPlainObject(cr)) return { ok: false, error: 'cascade_rules must be an object' };
    if (cr.rules !== undefined) {
      if (!Array.isArray(cr.rules)) return { ok: false, error: 'cascade_rules.rules must be an array' };
      for (const [i, r] of cr.rules.entries()) {
        if (!isPlainObject(r)) return { ok: false, error: `cascade_rules.rules[${i}] must be an object` };
        if (typeof r.trigger_door !== 'string' || r.trigger_door.length === 0) return { ok: false, error: `cascade_rules.rules[${i}].trigger_door must be a non-empty string` };
        if (!Array.isArray(r.unlock)) return { ok: false, error: `cascade_rules.rules[${i}].unlock must be an array of door names` };
        if (r.debounce_seconds !== undefined && (typeof r.debounce_seconds !== 'number' || r.debounce_seconds < 0)) {
          return { ok: false, error: `cascade_rules.rules[${i}].debounce_seconds must be a non-negative number` };
        }
      }
    }
  }

  if (updates.deadbolt_rules !== undefined) {
    const db = updates.deadbolt_rules;
    if (!isPlainObject(db)) return { ok: false, error: 'deadbolt_rules must be an object' };
    // Two accepted shapes: the legacy FLAT block (validated as one entry) and
    // the per-lock MAP (each value validated as an entry). Mixed payloads
    // (a stale writer spreading the map and adding flat keys) validate both
    // ways; the server normalizes them to the map shape before merging.
    const checkEntry = (e, label) => {
      if (e.lock_id !== undefined && typeof e.lock_id !== 'string') return `${label}lock_id must be a string`;
      if (e.trigger_door !== undefined && typeof e.trigger_door !== 'string') return `${label}trigger_door must be a string`;
      if (e.relock_cooldown_seconds !== undefined && (typeof e.relock_cooldown_seconds !== 'number' || e.relock_cooldown_seconds < 0)) {
        return `${label}relock_cooldown_seconds must be a non-negative number`;
      }
      return null;
    };
    const flatErr = checkEntry(db, 'deadbolt_rules.');
    if (flatErr) return { ok: false, error: flatErr };
    for (const [lockId, entry] of Object.entries(db)) {
      if (deadboltRules.FLAT_KEYS.includes(lockId)) continue; // flat scalar, checked above
      if (!isPlainObject(entry)) return { ok: false, error: `deadbolt_rules.${lockId} must be an object` };
      const err = checkEntry(entry, `deadbolt_rules.${lockId}.`);
      if (err) return { ok: false, error: err };
    }
  }

  if (updates.alerts !== undefined) {
    const al = updates.alerts;
    if (!isPlainObject(al)) return { ok: false, error: 'alerts must be an object' };
    if (al.enabled !== undefined && typeof al.enabled !== 'boolean') return { ok: false, error: 'alerts.enabled must be a boolean' };
    if (al.webhook_url !== undefined && typeof al.webhook_url !== 'string') return { ok: false, error: 'alerts.webhook_url must be a string' };
    if (al.on !== undefined && !Array.isArray(al.on)) return { ok: false, error: 'alerts.on must be an array' };
  }

  if (updates.setup_wizard !== undefined) {
    const sw = updates.setup_wizard;
    if (!isPlainObject(sw)) return { ok: false, error: 'setup_wizard must be an object' };
    if (sw.completed !== undefined && typeof sw.completed !== 'boolean') return { ok: false, error: 'setup_wizard.completed must be a boolean' };
    if (sw.skipped !== undefined && typeof sw.skipped !== 'boolean') return { ok: false, error: 'setup_wizard.skipped must be a boolean' };
    if (sw.last_step !== undefined && typeof sw.last_step !== 'string') return { ok: false, error: 'setup_wizard.last_step must be a string' };
  }

  if (updates.devices !== undefined) {
    if (!isPlainObject(updates.devices)) return { ok: false, error: 'devices must be an object' };
    const zw = updates.devices.zwave;
    if (zw !== undefined) {
      if (!isPlainObject(zw)) return { ok: false, error: 'devices.zwave must be an object' };
      if (zw.enabled !== undefined && typeof zw.enabled !== 'boolean') return { ok: false, error: 'devices.zwave.enabled must be a boolean' };
      if (zw.serial_path !== undefined && typeof zw.serial_path !== 'string') return { ok: false, error: 'devices.zwave.serial_path must be a string' };
      if (zw.locks !== undefined && !isPlainObject(zw.locks)) return { ok: false, error: 'devices.zwave.locks must be an object' };
      if (zw.security_keys !== undefined) {
        if (!isPlainObject(zw.security_keys)) return { ok: false, error: 'devices.zwave.security_keys must be an object' };
        for (const [k, v] of Object.entries(zw.security_keys)) {
          if (typeof v !== 'string') return { ok: false, error: `devices.zwave.security_keys.${k} must be a string` };
        }
      }
    }
  }

  return { ok: true };
}

// Remembers hashes of recently-seen request bodies so an identical (replayed)
// signed webhook can be rejected within a TTL window. Real access events carry
// unique ids/timestamps, so an exact-duplicate body inside the window is a
// replay, not a distinct event. Time and hashing are injectable for tests.
class ReplayGuard {
  constructor({ windowMs = 120000, max = 1000, now = () => Date.now() } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.now = now;
    this.seen = new Map(); // hash -> expiry timestamp
  }

  _hash(body) {
    return crypto.createHash('sha256').update(body == null ? '' : body).digest('hex');
  }

  _prune(t) {
    for (const [h, exp] of this.seen) {
      if (exp <= t) this.seen.delete(h);
    }
    while (this.seen.size > this.max) {
      const oldest = this.seen.keys().next().value;
      this.seen.delete(oldest);
    }
  }

  // Returns true if body was already seen within the window (a replay). A false
  // return records the body so a later identical one is caught.
  isReplay(body) {
    const t = this.now();
    const hash = this._hash(body);
    const exp = this.seen.get(hash);
    if (exp !== undefined && exp > t) return true;
    this.seen.set(hash, t + this.windowMs);
    this._prune(t); // prune after insert so the map never exceeds max
    return false;
  }
}

module.exports = {
  SECRET_KEY_RX,
  REDACTION_MARKER,
  ALLOWED_EVENT_MODES,
  redactSecrets,
  stripRedactedPlaceholders,
  validateConfigUpdates,
  ReplayGuard,
};
