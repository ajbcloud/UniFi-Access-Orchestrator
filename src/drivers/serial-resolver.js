'use strict';

const fs = require('fs');

/**
 * Durable identification of the Z-Wave USB stick, so a Windows COM renumber
 * (COM3 becomes COM5 after a reboot, a re-plug, or a hub change) or a Linux
 * ttyUSB shuffle does not strand the connector on a dead port.
 *
 * The app stores a bare serial_path (e.g. "COM3") plus, once a driver has
 * started cleanly, a serial_identity captured from the stick's USB descriptors
 * (serial number, VID, PID). When the saved path no longer names a live port,
 * this module re-finds the SAME physical stick by that identity and reports the
 * port it moved to. The manager then reopens that port and the config heals to
 * it, with no operator action.
 *
 * resolve() is deliberately PURE (ports in, verdict out) so every matching rule
 * is unit-tested without hardware. listPorts()/resolveLive() are the only impure
 * parts: they lazy-require serialport (which ships with zwave-js and is absent
 * from non-deadbolt builds) and, on Linux, follow a saved /dev/serial/by-* link
 * to the tty it currently points at so a stable by-id path still counts as a
 * match instead of being "healed" onto a volatile ttyUSBn.
 */

// The Zooz ZST39 (and most Z-Wave sticks) is a Silicon Labs CP210x USB-to-UART
// bridge, USB vendor id 10c4. Single source of truth for the dashboard's
// "likely Z-Wave stick" hint AND the resolver's last-resort match when no
// identity has been captured yet.
const SILABS_VID = '10c4';

function nonEmpty(v) {
  return v != null && String(v).trim() !== '';
}

function lc(v) {
  return String(v == null ? '' : v).toLowerCase();
}

// True when a port looks like a Z-Wave controller. Imported by the serial-ports
// endpoint so the hint and the resolver can never disagree.
function isLikelyZwave(port) {
  if (!port) return false;
  if (lc(port.vendor_id) === SILABS_VID) return true;
  return /silicon|cp210/.test(`${lc(port.manufacturer)} ${lc(port.pnp_id)}`);
}

// serialport's PortInfo uses camelCase; the rest of the app (config + the
// /api/deadbolt/serial-ports response) is snake_case. Normalize once here.
function normalizePort(p) {
  return {
    path: p.path,
    manufacturer: p.manufacturer || null,
    serial_number: p.serialNumber || null,
    pnp_id: p.pnpId || null,
    vendor_id: p.vendorId || null,
    product_id: p.productId || null,
  };
}

function portsWithSerial(ports, serial) {
  const want = lc(serial);
  return ports.filter((p) => nonEmpty(p.serial_number) && lc(p.serial_number) === want);
}

// On Linux, prefer the stable /dev/serial/by-id name when the port carries one,
// matching config.deadbolt.example.json's recommendation, so a heal lands on a
// durable path rather than a ttyUSBn that will shuffle again on the next boot.
function preferStablePath(port) {
  if (port && nonEmpty(port.pnp_id) && String(port.path).startsWith('/dev/tty')) {
    return `/dev/serial/by-id/${port.pnp_id}`;
  }
  return port.path;
}

/**
 * Decide which live port is the configured stick. PURE.
 *
 *   saved   { serial_path, serial_identity? } from config.devices.zwave
 *   ports   normalized port list (from listPorts())
 *   options { savedRealpath } - the tty a Linux by-* saved path currently points
 *           at, so a stable saved path matches the volatile enumerated path
 *
 * returns { path, matched_by, changed, candidates }
 *   path        port to open, or null when nothing matched conclusively
 *   matched_by  'path' | 'serial_number' | 'vid_pid' | null
 *   changed     true when path differs from the saved path (a heal happened)
 *   candidates  ports considered when the answer is ambiguous or empty, so the
 *               UI and logs can say "found two sticks" / "found nothing"
 */
function resolve(saved = {}, ports = [], options = {}) {
  const savedPath = saved.serial_path || '';
  const identity = saved.serial_identity || null;
  const list = Array.isArray(ports) ? ports : [];
  const savedReal = options.savedRealpath || null;

  // Does the saved path still name a live port, directly or through a Linux
  // by-* symlink? A path hit means the OS kept the port where we left it.
  const pathHit = savedPath && list.find((p) => p.path === savedPath
    || (savedReal && p.path === savedReal)
    || (nonEmpty(p.pnp_id) && savedPath === `/dev/serial/by-id/${p.pnp_id}`));

  // Rule 1 - exact saved path. Trust it, UNLESS a captured identity proves a
  // DIFFERENT stick is now squatting on that path (the stick was swapped, or the
  // OS handed the old name to another device). Then fall through to identity.
  if (pathHit) {
    const squatting = identity && nonEmpty(identity.serial_number)
      && nonEmpty(pathHit.serial_number)
      && lc(pathHit.serial_number) !== lc(identity.serial_number);
    if (!squatting) {
      return { path: savedPath, matched_by: 'path', changed: false, candidates: [pathHit] };
    }
  }

  // Rule 2 - same USB serial number, matched uniquely. This is what survives a
  // COM renumber. Uniqueness guards clone sticks that all report e.g. "0001":
  // more than one hit is ambiguous, so we refuse to guess.
  if (identity && nonEmpty(identity.serial_number)) {
    const hits = portsWithSerial(list, identity.serial_number);
    if (hits.length === 1) {
      const path = preferStablePath(hits[0]);
      return { path, matched_by: 'serial_number', changed: path !== savedPath, candidates: hits };
    }
    if (hits.length > 1) {
      return { path: null, matched_by: null, changed: false, candidates: hits };
    }
  }

  // Rule 3 - same VID/PID, matched uniquely. Use the captured identity's ids
  // when present, otherwise the CP210x heuristic. Two matching sticks is
  // ambiguous; never guess between them.
  const vid = identity && nonEmpty(identity.vendor_id) ? identity.vendor_id : SILABS_VID;
  const pid = identity && nonEmpty(identity.product_id) ? identity.product_id : null;
  let vpHits = list.filter((p) => lc(p.vendor_id) === lc(vid) && (!pid || lc(p.product_id) === lc(pid)));
  if (!vpHits.length) vpHits = list.filter(isLikelyZwave);
  if (vpHits.length === 1) {
    const path = preferStablePath(vpHits[0]);
    return { path, matched_by: 'vid_pid', changed: path !== savedPath, candidates: vpHits };
  }

  // Nothing conclusive. Hand back whatever we looked at so callers can explain.
  return { path: null, matched_by: null, changed: false, candidates: vpHits.length ? vpHits : list };
}

// Follow a saved /dev/serial/by-* path to the device it points at right now, so
// resolve() can treat a healthy stable path as a match. Impure (touches the fs),
// kept out of resolve() on purpose. Windows/macOS paths just return null.
function savedRealpath(serialPath) {
  if (!serialPath || !serialPath.startsWith('/dev/')) return null;
  try {
    return fs.realpathSync(serialPath);
  } catch (e) {
    return null;
  }
}

// Enumerate the machine's serial ports. Returns { available, ports, error }.
// available:false means this build has no serialport (non-deadbolt install).
async function listPorts() {
  let SerialPort;
  try {
    ({ SerialPort } = require('serialport')); // eslint-disable-line global-require
  } catch (e) {
    return { available: false, ports: [], error: 'Z-Wave support is not installed in this build' };
  }
  try {
    const raw = await SerialPort.list();
    return { available: true, ports: raw.map(normalizePort) };
  } catch (e) {
    return { available: true, ports: [], error: e.message };
  }
}

// Impure convenience used by the manager's resolveSerial dep and the endpoint:
// list the live ports, resolve the saved config against them, and return the
// verdict alongside the raw port list. Never throws.
async function resolveLive(saved = {}) {
  const listed = await listPorts();
  if (!listed.available) {
    return { available: false, error: listed.error, ports: [], verdict: null };
  }
  const verdict = resolve(saved, listed.ports, { savedRealpath: savedRealpath(saved.serial_path) });
  return { available: true, error: listed.error || null, ports: listed.ports, verdict };
}

// Build the serial_identity to persist from the port a driver just opened.
// Returns null for a port with no useful USB descriptors (nothing to remember).
function identityFromPort(port, updatedAt) {
  if (!port) return null;
  if (!nonEmpty(port.serial_number) && !nonEmpty(port.vendor_id) && !nonEmpty(port.product_id)) {
    return null;
  }
  return {
    serial_number: port.serial_number || null,
    vendor_id: port.vendor_id || null,
    product_id: port.product_id || null,
    last_path: port.path || null,
    updated_at: updatedAt || null,
  };
}

// True when `identity` already records the same stick as `port` (ignoring the
// updated_at timestamp), so callers can skip a no-op config write.
function identityMatchesPort(identity, port) {
  if (!identity || !port) return false;
  const fresh = identityFromPort(port);
  if (!fresh) return false;
  return lc(identity.serial_number) === lc(fresh.serial_number)
    && lc(identity.vendor_id) === lc(fresh.vendor_id)
    && lc(identity.product_id) === lc(fresh.product_id)
    && lc(identity.last_path) === lc(fresh.last_path);
}

module.exports = {
  SILABS_VID,
  isLikelyZwave,
  normalizePort,
  resolve,
  savedRealpath,
  listPorts,
  resolveLive,
  identityFromPort,
  identityMatchesPort,
};
