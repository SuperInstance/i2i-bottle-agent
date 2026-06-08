'use strict';

const fs = require('fs');
const path = require('path');
const { BottleValidator } = require('./bottle-validator');

const DEFAULT_VESSEL = path.join(process.env.HOME || '/tmp', '.openclaw', 'workspace', 'i2i-vessel');

/**
 * Parse a Markdown bottle file into structured { headers, body }.
 * Supports both [I2I:BOTTLE:TIMESTAMP] lines and KEY: VALUE headers.
 */
function parseBottle(raw, filePath) {
  const lines = raw.split('\n');
  const headers = {};
  let bodyStart = -1;
  let subject = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect I2I bottle marker: [I2I:BOTTLE:TIMESTAMP] Subject
    const markerMatch = line.match(/^\[(I2I:BOTTLE:\S+)\]\s*(.*)$/);
    if (markerMatch) {
      headers['$marker'] = markerMatch[1];
      subject = markerMatch[2];
      headers['$subject'] = subject;
      continue;
    }

    // Detect KEY: VALUE headers (before the --- separator)
    const headerMatch = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (headerMatch && bodyStart === -1) {
      headers[headerMatch[1]] = headerMatch[2].trim();
      continue;
    }

    // Detect separator line (--- or ### ) — anything after is body
    if (line.match(/^---/) || line.match(/^###/) || line.match(/^## /)) {
      if (bodyStart === -1) {
        bodyStart = i + 1;
      }
      continue;
    }

    // If we've seen content that's not a header and not a separator, switch to body
    if (bodyStart === -1 && line.trim() !== '' && !line.match(/^\[/) && !line.match(/^[A-Z_]+:/)) {
      bodyStart = i;
    }
  }

  const body = bodyStart >= 0 ? lines.slice(bodyStart).join('\n') : '';

  return {
    headers,
    body: body.trim(),
    raw,
    file: filePath || null,
    subject
  };
}

/**
 * Harbor Watcher — watches i2i-vessel/harbor/ for incoming bottles.
 * Uses fs.watch for real-time file events, with a poll-based fallback.
 */
class HarborWatcher {
  constructor(opts = {}) {
    this.vesselDir = opts.vesselDir || DEFAULT_VESSEL;
    this.harborDir = path.join(this.vesselDir, 'harbor');
    this.bottlesDir = path.join(this.vesselDir, 'bottles');
    this.onBottle = opts.onBottle || (() => {});
    this.onError = opts.onError || ((err) => console.error(`[HarborWatcher] Error: ${err.message}`));
    this.pollInterval = opts.pollInterval || 5000;
    this.validator = opts.validator || new BottleValidator();
    this._watcher = null;
    this._pollTimer = null;
    this._running = false;
    this._seen = new Set();

    // Callback hooks
    this.onNewHarborBottle = opts.onNewHarborBottle || null;
    this.onNewOutgoingBottle = opts.onNewOutgoingBottle || null;
  }

  /**
   * Initialize directories.
   */
  init() {
    for (const dir of [this.harborDir, this.bottlesDir]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        throw new Error(`HarborWatcher: cannot create ${dir}: ${err.message}`);
      }
    }
    return this;
  }

  /**
   * Seed the "seen" set with current files.
   */
  seedSeen() {
    this._seen = new Set();
    for (const dir of [this.harborDir, this.bottlesDir]) {
      try {
        for (const f of fs.readdirSync(dir)) {
          this._seen.add(f);
        }
      } catch (_) { /* ignore */ }
    }
  }

  /**
   * Start watching the harbor directory.
   * Uses fs.watch for real-time events.
   */
  start() {
    if (this._running) return;
    this._running = true;

    this.init();
    this.seedSeen();

    console.log(`[HarborWatcher] Watching ${this.harborDir} and ${this.bottlesDir}`);

    // Primary: fs.watch on harbor
    try {
      this._watcher = fs.watch(this.harborDir, (eventType, filename) => {
        if (!filename) return;
        const filePath = path.join(this.harborDir, filename);
        this._processFile(filePath, 'harbor');
      });
    } catch (err) {
      console.warn(`[HarborWatcher] fs.watch failed on harbor, falling back to polling: ${err.message}`);
    }

    // Also watch bottles/ for outgoing
    try {
      this._bottleWatcher = fs.watch(this.bottlesDir, (eventType, filename) => {
        if (!filename) return;
        const filePath = path.join(this.bottlesDir, filename);
        this._processFile(filePath, 'bottles');
      });
    } catch (err) {
      console.warn(`[HarborWatcher] fs.watch failed on bottles: ${err.message}`);
    }

    // Fallback: poll-based check
    this._pollTimer = setInterval(() => {
      this._pollCheck('harbor');
      this._pollCheck('bottles');
    }, this.pollInterval);

    console.log(`[HarborWatcher] Polling every ${this.pollInterval}ms`);
  }

  /**
   * Poll a directory for new files.
   */
  _pollCheck(dir) {
    const dirPath = dir === 'harbor' ? this.harborDir : this.bottlesDir;
    let files;
    try {
      files = fs.readdirSync(dirPath);
    } catch (_) { return; }

    for (const file of files) {
      if (this._seen.has(file)) continue;
      this._seen.add(file);
      const filePath = path.join(dirPath, file);
      this._processFile(filePath, dir);
    }
  }

  /**
   * Process a single file: parse, validate, route.
   */
  _processFile(filePath, source) {
    // Only process .md files for I2I bottles
    if (!filePath.endsWith('.md') && !filePath.endsWith('.bottle')) return;

    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.onError(new Error(`Cannot read ${filePath}: ${err.message}`));
      }
      return;
    }

    const bottle = parseBottle(raw, filePath);

    // Validate
    const result = this.validator.validate(bottle);
    if (!result.valid) {
      console.warn(`[HarborWatcher] ⚠ Invalid bottle ${path.basename(filePath)}:`);
      for (const err of result.errors) {
        console.warn(`  ❌ ${err}`);
      }
      for (const warn of result.warnings) {
        console.warn(`  ⚠ ${warn}`);
      }
    }

    if (!bottle.headers['$marker']) {
      // Not an I2I bottle, skip
      return;
    }

    console.log(`[HarborWatcher] 📡 Picked up bottle: ${path.basename(filePath)}`);
    console.log(`  From: ${bottle.headers['FROM'] || '?'} → To: ${bottle.headers['TO'] || '?'}`);
    console.log(`  Type: ${bottle.headers['TYPE'] || '?'}`);
    console.log(`  Valid: ${result.valid ? '✅' : '⚠'}`);

    // Route based on source
    if (source === 'harbor') {
      // Incoming from Forgemaster — route to Oracle2 notice
      if (this.onNewHarborBottle) {
        this.onNewHarborBottle(bottle, filePath);
      }
    } else if (source === 'bottles') {
      // Outgoing to Forgemaster — route to construct-coordination
      if (this.onNewOutgoingBottle) {
        this.onNewOutgoingBottle(bottle, filePath);
      }
    }

    // General callback
    this.onBottle(bottle, filePath, source);
  }

  /**
   * Stop watching.
   */
  stop() {
    this._running = false;
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
    if (this._bottleWatcher) {
      this._bottleWatcher.close();
      this._bottleWatcher = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    console.log('[HarborWatcher] Stopped');
  }

  /**
   * Manually scan harbor/ for existing bottles.
   * @returns {Array<object>} parsed bottles
   */
  scanHarbor() {
    return this._scanDir(this.harborDir, 'harbor');
  }

  /**
   * Manually scan bottles/ for existing bottles.
   * @returns {Array<object>} parsed bottles
   */
  scanBottles() {
    return this._scanDir(this.bottlesDir, 'bottles');
  }

  /**
   * Scan a directory for I2I bottles.
   */
  _scanDir(dirPath, source) {
    const bottles = [];
    let files;
    try {
      files = fs.readdirSync(dirPath);
    } catch (_) { return bottles; }

    for (const file of files) {
      if (!file.endsWith('.md') && !file.endsWith('.bottle')) continue;
      const filePath = path.join(dirPath, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const bottle = parseBottle(raw, filePath);
        if (bottle.headers['$marker']) {
          bottle.source = source;
          bottles.push(bottle);
        }
      } catch (err) {
        this.onError(new Error(`Cannot scan ${filePath}: ${err.message}`));
      }
    }

    return bottles;
  }
}

module.exports = { HarborWatcher, parseBottle };
