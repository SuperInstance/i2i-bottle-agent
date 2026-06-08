'use strict';

const fs = require('fs');
const path = require('path');
const { parseBottle } = require('./harbor-watcher');
const { BottleValidator } = require('./bottle-validator');

const DEFAULT_CONSTRUCT_COORD = path.join(process.env.HOME || '/tmp', '.openclaw', 'workspace', 'construct-coordination');
const DEFAULT_VESSEL = path.join(process.env.HOME || '/tmp', '.openclaw', 'workspace', 'i2i-vessel');

/**
 * Beachcomber — Combs through construct-coordination/notes/forgemaster/
 * for bottles that haven't been imported to i2i-vessel/harbor/ yet.
 *
 * "Bottles on the beach" = notes dropped by Forgemaster into construct-coordination
 * that need to be pulled into the I2I vessel as harbor bottles.
 */
class Beachcomber {
  constructor(opts = {}) {
    this.constructCoordDir = opts.constructCoordDir || DEFAULT_CONSTRUCT_COORD;
    this.vesselDir = opts.vesselDir || DEFAULT_VESSEL;
    this.harborDir = path.join(this.vesselDir, 'harbor');
    this.bottlesDir = path.join(this.vesselDir, 'bottles');
    this.forgemasterNoteDir = path.join(this.constructCoordDir, 'notes', 'forgemaster');
    this.oracle2NoteDir = path.join(this.constructCoordDir, 'notes', 'oracle2');
    this.validator = opts.validator || new BottleValidator();
    this.verbose = opts.verbose !== false;

    // Track imported bottles to avoid duplicates across runs
    this._importedLog = path.join(this.vesselDir, '.beachcomber-imported.json');
    this._imported = this._loadImported();

    this.stats = {
      scanned: 0,
      imported: 0,
      skipped: 0,
      errors: 0
    };
  }

  /**
   * Load the set of already-imported file basenames.
   */
  _loadImported() {
    try {
      const raw = fs.readFileSync(this._importedLog, 'utf8');
      return new Set(JSON.parse(raw));
    } catch (_) {
      return new Set();
    }
  }

  /**
   * Save imported file basenames.
   */
  _saveImported() {
    try {
      fs.writeFileSync(this._importedLog, JSON.stringify([...this._imported]), 'utf8');
    } catch (err) {
      console.error(`[Beachcomber] Cannot save imported log: ${err.message}`);
    }
  }

  /**
   * Initialize directories.
   */
  init() {
    for (const dir of [this.harborDir, this.forgemasterNoteDir, this.oracle2NoteDir]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        throw new Error(`Beachcomber: cannot create ${dir}: ${err.message}`);
      }
    }
    return this;
  }

  /**
   * Check if a file looks like an I2I bottle by reading its header.
   * @param {string} filePath
   * @returns {boolean}
   */
  _isBottleFile(filePath) {
    try {
      const firstLine = fs.readFileSync(filePath, 'utf8').split('\n')[0];
      return /^\[I2I:BOTTLE:/.test(firstLine);
    } catch (_) {
      return false;
    }
  }

  /**
   * Check if a bottle already exists in harbor/ by matching content hash.
   * @param {object} bottle - parsed bottle
   * @returns {boolean}
   */
  _existsInHarbor(bottle) {
    const marker = bottle.headers['$marker'];
    const timestamp = bottle.headers['TIMESTAMP'];
    const from = bottle.headers['FROM'];

    // Quick check: look for files with matching marker in harbor
    try {
      const harborFiles = fs.readdirSync(this.harborDir);
      for (const file of harborFiles) {
        if (!file.endsWith('.md')) continue;
        const existingRaw = fs.readFileSync(path.join(this.harborDir, file), 'utf8');
        if (existingRaw.includes(marker)) return true;
      }
    } catch (_) { /* ignore */ }

    return false;
  }

  /**
   * Import a bottle from a file into harbor/.
   * Copies the file and returns the harbor path.
   *
   * @param {string} filePath - path to source file (from construct-coordination/notes/forgemaster/)
   * @returns {string|null} harbor destination path, or null
   */
  importBottle(filePath) {
    const basename = path.basename(filePath);

    // Skip already-imported
    if (this._imported.has(basename)) {
      if (this.verbose) {
        console.log(`[Beachcomber] ⏭ Already imported: ${basename}`);
      }
      this.stats.skipped++;
      return null;
    }

    // Verify it's a real I2I bottle
    if (!this._isBottleFile(filePath)) {
      return null;
    }

    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      console.error(`[Beachcomber] Cannot read ${filePath}: ${err.message}`);
      this.stats.errors++;
      return null;
    }

    const bottle = parseBottle(raw, filePath);

    // Validate
    const result = this.validator.validate(bottle);
    if (!result.valid) {
      if (this.verbose) {
        console.warn(`[Beachcomber] ⚠ Skipping invalid bottle ${basename}:`);
        for (const err of result.errors) {
          console.warn(`  ❌ ${err}`);
        }
      }
      this.stats.skipped++;
      return null;
    }

    // Check for duplicates
    if (this._existsInHarbor(bottle)) {
      if (this.verbose) {
        console.log(`[Beachcomber] ⏭ Duplicate in harbor: ${basename}`);
      }
      this._imported.add(basename);
      this._saveImported();
      return null;
    }

    // Copy to harbor
    const harborPath = path.join(this.harborDir, basename);
    try {
      fs.copyFileSync(filePath, harborPath);
      this._imported.add(basename);
      this._saveImported();
      this.stats.imported++;
      if (this.verbose) {
        console.log(`[Beachcomber] 🌊 Imported bottle to harbor: ${basename}`);
      }
      return harborPath;
    } catch (err) {
      console.error(`[Beachcomber] Failed to import ${basename}: ${err.message}`);
      this.stats.errors++;
      return null;
    }
  }

  /**
   * Scan both directions:
   * - forgemaster/notes/ → harbor/ (incoming from Forgemaster to Oracle2)
   * - Also optionally scan oracle2/notes/ → bottles/ (outgoing from Oracle2 to Forgemaster)
   *
   * @param {object} opts
   * @param {boolean} opts.bidirectional - also scan oracle2 notes (default false)
   * @returns {{ harbor: string[], bottles: string[] }} paths imported
   */
  beachcomb(opts = {}) {
    this.init();
    this.stats = { scanned: 0, imported: 0, skipped: 0, errors: 0 };

    const results = { harbor: [], bottles: [] };

    // Scan forgemaster notes → harbor/
    if (fs.existsSync(this.forgemasterNoteDir)) {
      try {
        const files = fs.readdirSync(this.forgemasterNoteDir);
        this.stats.scanned += files.length;

        for (const file of files) {
          const filePath = path.join(this.forgemasterNoteDir, file);
          if (fs.statSync(filePath).isDirectory()) continue;
          const imported = this.importBottle(filePath);
          if (imported) {
            results.harbor.push(imported);
          }
        }
      } catch (err) {
        console.error(`[Beachcomber] Error scanning ${this.forgemasterNoteDir}: ${err.message}`);
        this.stats.errors++;
      }
    } else {
      if (this.verbose) {
        console.log(`[Beachcomber] forgemaster notes dir not found: ${this.forgemasterNoteDir}`);
      }
    }

    // Optionally scan oracle2 notes → bottles/
    if (opts.bidirectional && fs.existsSync(this.oracle2NoteDir)) {
      try {
        const files = fs.readdirSync(this.oracle2NoteDir);
        for (const file of files) {
          const filePath = path.join(this.oracle2NoteDir, file);
          if (fs.statSync(filePath).isDirectory()) continue;
          if (!this._isBottleFile(filePath)) continue;

          const basename = path.basename(filePath);
          if (this._imported.has(basename)) {
            if (this.verbose) console.log(`[Beachcomber] ⏭ Already imported: ${basename}`);
            continue;
          }

          const raw = fs.readFileSync(filePath, 'utf8');
          const bottle = parseBottle(raw, filePath);
          const result = this.validator.validate(bottle);
          if (!result.valid) {
            this.stats.skipped++;
            continue;
          }

          // Copy to bottles/
          const bottlePath = path.join(this.bottlesDir, basename);
          try {
            fs.copyFileSync(filePath, bottlePath);
            this._imported.add(basename);
            this.stats.imported++;
            results.bottles.push(bottlePath);
            if (this.verbose) {
              console.log(`[Beachcomber] 🌊 Imported bottle to bottles/: ${basename}`);
            }
          } catch (err) {
            console.error(`[Beachcomber] Failed to import oracle2 bottle: ${err.message}`);
          }
        }
      } catch (err) {
        console.error(`[Beachcomber] Error scanning oracle2 notes: ${err.message}`);
      }
    }

    this._saveImported();

    if (this.verbose) {
      console.log(`[Beachcomber] 📊 Summary: scanned=${this.stats.scanned}, imported=${this.stats.imported}, skipped=${this.stats.skipped}, errors=${this.stats.errors}`);
    }

    return results;
  }

  /**
   * Completely reset the imported log (re-import everything next run).
   */
  resetLog() {
    this._imported = new Set();
    this._saveImported();
    console.log('[Beachcomber] Reset import log — will re-import all bottles');
  }
}

module.exports = { Beachcomber };
