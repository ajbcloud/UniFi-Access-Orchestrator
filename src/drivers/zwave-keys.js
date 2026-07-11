'use strict';

const crypto = require('crypto');

/**
 * Shared Z-Wave security-key handling for the manager, the lock driver, and
 * the pairing flow. Keys live in config at devices.zwave.security_keys as
 * 32-char hex strings (app-managed; generated at first pairing), with the
 * ZWAVE_* environment variables kept as an override/fallback for headless
 * installs that predate in-app pairing.
 *
 * CRITICAL INVARIANT: a key that already exists (config or env) is never
 * regenerated. Changing the S2 keys after a lock is paired orphans the lock
 * (it would need exclusion + re-pairing), so ensureSecurityKeys() only fills
 * gaps and reports what it generated for the caller to persist.
 */

// Config key names (snake_case) -> zwave-js Driver securityKeys option names.
const CLASSIC_KEYS = Object.freeze({
  s2_access_control: 'S2_AccessControl',
  s2_authenticated: 'S2_Authenticated',
  s2_unauthenticated: 'S2_Unauthenticated',
  s0_legacy: 'S0_Legacy',
});

// Env-var names for the classic keys (existing contract, unchanged).
const ENV_NAMES = Object.freeze({
  s2_access_control: 'ZWAVE_S2_ACCESS_CONTROL',
  s2_authenticated: 'ZWAVE_S2_AUTHENTICATED',
  s2_unauthenticated: 'ZWAVE_S2_UNAUTHENTICATED',
  s0_legacy: 'ZWAVE_S0_LEGACY',
});

const HEX_32_RX = /^[0-9a-f]{32}$/i;

function parseHexKey(value, sourceLabel) {
  if (value == null || value === '') return undefined;
  const s = String(value).trim();
  if (!HEX_32_RX.test(s)) {
    throw new Error(`${sourceLabel} must be exactly 32 hex characters (16 bytes)`);
  }
  return Buffer.from(s, 'hex');
}

/**
 * Resolve the security keys with per-key precedence: config
 * (zwCfg.security_keys[name]) first, env fallback. Long Range keys are
 * env-only (no LR hardware in scope; the ZST39 is used in classic mode for
 * the BE469ZP). Returns { classic, longRange, missing } where classic and
 * longRange use the zwave-js option names and missing lists the config names
 * of classic keys that resolved to nothing.
 */
function loadSecurityKeys(zwCfg, env = process.env) {
  const cfgKeys = (zwCfg && zwCfg.security_keys) || {};
  const classic = {};
  const missing = [];
  for (const [cfgName, optName] of Object.entries(CLASSIC_KEYS)) {
    const fromCfg = parseHexKey(cfgKeys[cfgName], `devices.zwave.security_keys.${cfgName}`);
    const fromEnv = fromCfg ? undefined : parseHexKey(env[ENV_NAMES[cfgName]], ENV_NAMES[cfgName]);
    const buf = fromCfg || fromEnv;
    if (buf) classic[optName] = buf;
    else missing.push(cfgName);
  }
  const longRange = {};
  const lrAccess = parseHexKey(env.ZWAVE_LR_S2_ACCESS_CONTROL, 'ZWAVE_LR_S2_ACCESS_CONTROL');
  const lrAuth = parseHexKey(env.ZWAVE_LR_S2_AUTHENTICATED, 'ZWAVE_LR_S2_AUTHENTICATED');
  if (lrAccess) longRange.S2_AccessControl = lrAccess;
  if (lrAuth) longRange.S2_Authenticated = lrAuth;
  return { classic, longRange, missing };
}

/**
 * Ensure a full classic key set exists, generating ONLY the missing ones.
 * Returns { keys: {classic, longRange}, generated } where generated is a
 * map of config-name -> hex string for the caller to persist into
 * devices.zwave.security_keys BEFORE any inclusion runs, or null when
 * nothing needed generating. Never touches existing key material.
 */
function ensureSecurityKeys(zwCfg, env = process.env) {
  const resolved = loadSecurityKeys(zwCfg, env);
  if (resolved.missing.length === 0) {
    return { keys: resolved, generated: null };
  }
  const generated = {};
  for (const cfgName of resolved.missing) {
    const hex = crypto.randomBytes(16).toString('hex');
    generated[cfgName] = hex;
    resolved.classic[CLASSIC_KEYS[cfgName]] = Buffer.from(hex, 'hex');
  }
  resolved.missing = [];
  return { keys: resolved, generated };
}

module.exports = { loadSecurityKeys, ensureSecurityKeys, CLASSIC_KEYS, ENV_NAMES };
