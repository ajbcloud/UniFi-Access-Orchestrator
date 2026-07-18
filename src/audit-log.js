'use strict';

/**
 * Tamper-evident audit log for sensitive PIN operations.
 *
 * Every admin-gated action (a PIN add/change/delete, an admin-PIN change) is
 * appended as one JSON line to audit-log.jsonl in the config dir (0600). Each
 * entry carries the SHA-256 of the previous entry, forming a hash chain: an
 * edited or deleted line breaks the chain from that point on, so after-the-fact
 * tampering is detectable even by someone with file access.
 *
 * IDENTITY LIMIT: the app has a single shared admin credential and no
 * per-technician login, so `actor` is a role label ('admin'/'user'/'system'),
 * not a person. The chain proves WHAT happened and that the record is intact; it
 * cannot prove WHO among the technicians did it.
 */

const fs = require('fs');
const crypto = require('crypto');

// Deterministic serialization of the entry fields that are covered by the hash
// (everything except the hash itself), so recomputation is stable.
function canonicalPayload(entry) {
  return JSON.stringify({
    seq: entry.seq,
    ts: entry.ts,
    actor: entry.actor,
    action: entry.action,
    target: entry.target,
    detail: entry.detail,
    prev: entry.prev,
  });
}

// Pure: the chain hash for an entry given the previous entry's hash.
function chainHash(entry) {
  return crypto.createHash('sha256').update(canonicalPayload(entry)).digest('hex');
}

function readAllLines(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return [];
  }
  return raw.split('\n').filter((l) => l.trim() !== '');
}

function parseEntries(filePath) {
  const out = [];
  for (const line of readAllLines(filePath)) {
    try { out.push(JSON.parse(line)); } catch (_) { out.push({ __unparsable: line }); }
  }
  return out;
}

// Append one audit entry, chaining it to the last line already on disk. `ts` is
// injectable for tests; defaults to now. Best-effort: an append failure is
// logged by the caller, never allowed to break the underlying action.
function appendEntry(filePath, { actor, action, target = null, detail = null }, ts) {
  const existing = parseEntries(filePath);
  const last = existing.length ? existing[existing.length - 1] : null;
  const prev = last && typeof last.hash === 'string' ? last.hash : '';
  const seq = existing.length + 1;
  const entry = {
    seq,
    ts: ts || new Date().toISOString(),
    actor: actor || 'unknown',
    action: action || 'unknown',
    target,
    detail,
    prev,
  };
  entry.hash = chainHash(entry);
  // Ensure the file exists 0600 before appending (appendFileSync's mode only
  // applies on create, and only the first writer would set it otherwise).
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', { mode: 0o600 });
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
  return entry;
}

// Return the most recent `limit` entries (oldest-first within the slice).
function readEntries(filePath, limit = 200) {
  const all = parseEntries(filePath).filter((e) => !e.__unparsable);
  return limit > 0 ? all.slice(-limit) : all;
}

// Walk the whole file and confirm every entry's stored hash matches a fresh
// recomputation and links to the prior entry. Returns { ok, count, brokenAt }.
// brokenAt is the 1-based seq of the first bad entry, or null when intact.
function verifyChain(filePath) {
  const entries = parseEntries(filePath);
  let prev = '';
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.__unparsable || typeof e.hash !== 'string') {
      return { ok: false, count: entries.length, brokenAt: i + 1 };
    }
    if (e.prev !== prev) return { ok: false, count: entries.length, brokenAt: i + 1 };
    const recomputed = chainHash(e);
    if (recomputed !== e.hash) return { ok: false, count: entries.length, brokenAt: i + 1 };
    prev = e.hash;
  }
  return { ok: true, count: entries.length, brokenAt: null };
}

module.exports = {
  chainHash,
  appendEntry,
  readEntries,
  verifyChain,
};
