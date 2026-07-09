'use strict';

const fs = require('fs');
const path = require('path');

/**
 * CaptureSession: a labeled, full-fidelity recorder for raw UniFi events.
 *
 * Purpose: pin down the payload shapes the docs do not cover (what a
 * Double-Badge Override / Lock Now emits, whether a custom `extra` echoes back)
 * without a bench. An operator (or a Cowork handoff) starts a capture, performs
 * one gesture, and reads back exactly what came over the wire.
 *
 * It is inert until start() is called, so it has no effect on normal operation.
 * When fed from the UniFi client's raw tap it sees ALL events, including the
 * telemetry the rules engine filters out, which is the point.
 */
class CaptureSession {
  constructor(opts = {}) {
    this.max = opts.max || 1000;
    this.dir = opts.dir || null;
    this.active = false;
    this.label = null;
    this.events = [];
    this.file = null;
  }

  start(label) {
    this.active = true;
    this.label = label || 'capture';
    this.events = [];
    this.file = null;
    if (this.dir) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        const safe = String(this.label).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40) || 'capture';
        this.file = path.join(this.dir, `capture_${safe}.jsonl`);
        fs.writeFileSync(this.file, '');
      } catch (e) {
        this.file = null;
      }
    }
    return this.status();
  }

  stop() {
    this.active = false;
    return this.status();
  }

  setLabel(label) {
    if (label) this.label = label;
    return this.status();
  }

  add(event) {
    if (!this.active) return;
    const rec = {
      t: new Date().toISOString(),
      label: this.label,
      event_type: (event && (event.event || event.type)) || 'unknown',
      event,
    };
    this.events.push(rec);
    if (this.events.length > this.max) this.events.shift();
    if (this.file) {
      try { fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); } catch (e) { /* best effort */ }
    }
  }

  list(limit) {
    const n = limit || 200;
    return this.events.slice(-n);
  }

  status() {
    return {
      active: this.active,
      label: this.label,
      count: this.events.length,
      file: this.file,
      max: this.max,
    };
  }
}

module.exports = CaptureSession;
