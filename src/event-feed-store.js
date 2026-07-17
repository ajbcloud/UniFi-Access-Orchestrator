'use strict';

const fs = require('fs');

// ---------------------------------------------------------------------------
// Live event feed persistence
//
// The Live Events feed (eventHistory in index.js) is an in-memory ring buffer
// capped at 200 entries. Before this store it started EMPTY on every restart,
// which is exactly what the user noticed when the app bounced. This persists a
// snapshot of that buffer to a small JSON file so the feed survives a restart
// or reload.
//
// Design choices:
//   - Single JSON array (not JSONL): the feed is already bounded to <= max, so
//     a whole-array rewrite never grows unbounded and needs no compaction.
//   - Debounced trailing write: an event burst produces one rewrite, not one
//     per event.
//   - Atomic temp+rename at 0600, mirroring writeConfigFile(), so a crash
//     mid-write cannot truncate the file and the (name/door) contents match the
//     config's owner-only posture.
//   - Best-effort everywhere: a missing/corrupt file loads as empty, and a
//     write failure is logged but never throws into the event path.
// ---------------------------------------------------------------------------

class EventFeedStore {
  constructor({ filePath, max = 200, debounceMs = 3000, logger = console } = {}) {
    this.filePath = filePath;
    this.max = max;
    this.debounceMs = debounceMs;
    this.logger = logger;
    this._timer = null;
    this._pending = null; // the entries array reference to serialize on fire
  }

  // Load the persisted feed. Newest-first, sliced to max. Never throws.
  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.slice(0, this.max);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        this.logger.warn(`Event feed load failed (${e.message}); starting with an empty feed`);
      }
      return [];
    }
  }

  // Debounced persist. Pass the live entries array; the trailing write
  // serializes its state at fire time, so bursts collapse to one write.
  schedule(entries) {
    this._pending = entries;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      const snapshot = this._pending;
      this._pending = null;
      this._writeSync(snapshot);
    }, this.debounceMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  // Synchronous flush for clean shutdown: cancel any pending debounce and write
  // now so a graceful exit loses nothing.
  flush(entries) {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._pending = null;
    this._writeSync(entries);
  }

  _writeSync(entries) {
    if (!Array.isArray(entries)) return;
    try {
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entries.slice(0, this.max)), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      this.logger.warn(`Event feed persist failed: ${e.message}`);
    }
  }
}

module.exports = EventFeedStore;
