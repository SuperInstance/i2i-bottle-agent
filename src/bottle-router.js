'use strict';

const fs = require('fs');
const path = require('path');
const { BottleValidator } = require('./bottle-validator');

const DEFAULT_VESSEL = path.join(process.env.HOME || '/tmp', '.openclaw', 'workspace', 'i2i-vessel');
const DEFAULT_FLEET_BRIDGE = path.join(process.env.HOME || '/tmp', '.openclaw', 'workspace', 'fleet-bridge');
const DEFAULT_CONSTRUCT_COORD = path.join(process.env.HOME || '/tmp', '.openclaw', 'workspace', 'construct-coordination');

/**
 * Bottle Router — routes bottles between I2I vessel and construct-coordination.
 *
 * Routing rules:
 * - Incoming (harbor/): bottles FROM Forgemaster → copy to construct-coordination/notes/oracle2/
 * - Outgoing (bottles/): bottles TO Forgemaster → copy to construct-coordination/notes/forgemaster/
 * - Dock check: identify stale bottles (older than threshold, not yet processed)
 * - Can forward bottles to fleet bridge for t-minus cue integration
 */
class BottleRouter {
  constructor(opts = {}) {
    this.vesselDir = opts.vesselDir || DEFAULT_VESSEL;
    this.harborDir = path.join(this.vesselDir, 'harbor');
    this.bottlesDir = path.join(this.vesselDir, 'bottles');
    this.fleetBridgeDir = opts.fleetBridgeDir || DEFAULT_FLEET_BRIDGE;
    this.constructCoordDir = opts.constructCoordDir || DEFAULT_CONSTRUCT_COORD;
    this.staleThresholdMs = opts.staleThresholdMs || 30 * 60 * 1000; // 30 min default
    this.validator = opts.validator || new BottleValidator();
    this.verbose = opts.verbose !== false;

    // Routing stats
    this.stats = {
      harborRouted: 0,
      bottlesRouted: 0,
      staleFound: 0,
      errors: 0
    };
  }

  /**
   * Ensure routing target directories exist.
   */
  init() {
    const targets = [
      path.join(this.constructCoordDir, 'notes', 'oracle2'),
      path.join(this.constructCoordDir, 'notes', 'forgemaster')
    ];
    for (const dir of targets) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        console.error(`[BottleRouter] Cannot create ${dir}: ${err.message}`);
      }
    }
    return this;
  }

  /**
   * Route an incoming harbor bottle to construct-coordination/notes/oracle2/.
   * These are bottles FROM Forgemaster that Oracle2 should process.
   *
   * @param {object} bottle - parsed I2I bottle
   * @param {string} filePath - original file path
   * @returns {string|null} destination path, or null on failure
   */
  routeIncoming(bottle, filePath) {
    const targetDir = path.join(this.constructCoordDir, 'notes', 'oracle2');
    this.init();

    // Generate a filename based on bottle metadata
    const timestamp = (bottle.headers['TIMESTAMP'] || Date.now().toISOString())
      .replace(/[T:Z.]/g, '-')
      .replace(/--+/g, '-')
      .replace(/-$/, '');
    const from = (bottle.headers['FROM'] || 'unknown').replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const type = (bottle.headers['TYPE'] || 'bottle').split(/[ —–\-]/)[0].toLowerCase();
    const filename = `incoming-${timestamp}-${from}-${type}.md`;
    const destPath = path.join(targetDir, filename);

    try {
      // Copy the bottle to construct-coordination
      if (filePath) {
        fs.copyFileSync(filePath, destPath);
      } else {
        // Reconstruct from parsed bottle
        const content = this._reconstructBottle(bottle);
        fs.writeFileSync(destPath, content, 'utf8');
      }
      this.stats.harborRouted++;
      if (this.verbose) {
        console.log(`[BottleRouter] 📥 Routed harbor bottle → ${path.relative(this.constructCoordDir, destPath)}`);
      }

      // Optionally notify fleet bridge by placing a JSON mirror
      this._mirrorToFleetBridge(bottle, 'oracle2');

      return destPath;
    } catch (err) {
      this.stats.errors++;
      console.error(`[BottleRouter] Error routing incoming bottle: ${err.message}`);
      return null;
    }
  }

  /**
   * Route an outgoing bottles/ bottle to construct-coordination/notes/forgemaster/.
   * These are bottles TO Forgemaster that need to be forwarded.
   *
   * @param {object} bottle - parsed I2I bottle
   * @param {string} filePath - original file path
   * @returns {string|null} destination path, or null on failure
   */
  routeOutgoing(bottle, filePath) {
    const targetDir = path.join(this.constructCoordDir, 'notes', 'forgemaster');
    this.init();

    const timestamp = (bottle.headers['TIMESTAMP'] || Date.now().toISOString())
      .replace(/[T:Z.]/g, '-')
      .replace(/--+/g, '-')
      .replace(/-$/, '');
    const to = (bottle.headers['TO'] || 'unknown').replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const type = (bottle.headers['TYPE'] || 'bottle').split(/[ —–\-]/)[0].toLowerCase();
    const filename = `outgoing-${timestamp}-to-${to}-${type}.md`;
    const destPath = path.join(targetDir, filename);

    try {
      if (filePath) {
        fs.copyFileSync(filePath, destPath);
      } else {
        const content = this._reconstructBottle(bottle);
        fs.writeFileSync(destPath, content, 'utf8');
      }
      this.stats.bottlesRouted++;
      if (this.verbose) {
        console.log(`[BottleRouter] 📤 Routed outgoing bottle → ${path.relative(this.constructCoordDir, destPath)}`);
      }

      // Mirror to fleet bridge for t-minus cue forwarding
      this._mirrorToFleetBridge(bottle, 'forgemaster');

      return destPath;
    } catch (err) {
      this.stats.errors++;
      console.error(`[BottleRouter] Error routing outgoing bottle: ${err.message}`);
      return null;
    }
  }

  /**
   * Mirror bottle to fleet bridge for t-minus cue integration.
   * Writes a JSON mirror to fleet-bridge's I2I transport area.
   */
  _mirrorToFleetBridge(bottle, targetAgent) {
    try {
      const fleetBridgeSrc = path.join(this.fleetBridgeDir, 'src');
      if (!fs.existsSync(fleetBridgeSrc)) return;

      const jsonBottle = {
        id: `bottle-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: bottle.headers['TYPE'] ? bottle.headers['TYPE'].split(/[ —–\-]/)[0] : 'BOTTLE',
        from: bottle.headers['FROM'] || 'unknown',
        to: bottle.headers['TO'] || targetAgent,
        timestamp: bottle.headers['TIMESTAMP'] || new Date().toISOString(),
        subject: bottle.headers['$subject'] || '',
        body: bottle.body ? bottle.body.slice(0, 500) : ''
      };

      const bottleDir = path.join(this.vesselDir, 'bottles');
      const jsonFilename = `${Date.now()}-mirror-${targetAgent}.json`;
      const jsonPath = path.join(bottleDir, jsonFilename);

      // Stamp integrity
      const { integrity, ...hashBody } = jsonBottle;
      const crypto = require('crypto');
      const integrityVal = crypto.createHash('sha256')
        .update(JSON.stringify(hashBody, Object.keys(hashBody).sort()), 'utf8')
        .digest('hex');
      jsonBottle.integrity = integrityVal;

      fs.writeFileSync(jsonPath, JSON.stringify(jsonBottle, null, 2), 'utf8');
      if (this.verbose) {
        console.log(`[BottleRouter] 🔄 Mirrored to fleet bridge: ${jsonFilename}`);
      }
    } catch (err) {
      // Fleet bridge mirroring is best-effort
      if (this.verbose) {
        console.warn(`[BottleRouter] Mirror to fleet bridge skipped: ${err.message}`);
      }
    }
  }

  /**
   * Reconstruct a Markdown bottle from a parsed bottle object.
   */
  _reconstructBottle(bottle) {
    const lines = [];

    // Marker line
    const marker = bottle.headers['$marker'] || `I2I:BOTTLE:${new Date().toISOString().slice(0, 10)}`;
    const subject = bottle.headers['$subject'] || '';
    lines.push(`[${marker}] ${subject}`);
    lines.push('');

    // Headers (skip internal $ fields)
    for (const [key, value] of Object.entries(bottle.headers)) {
      if (key.startsWith('$')) continue;
      if (key === 'INTEGRITY') {
        lines.push(`${key}: ${value}`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    }

    lines.push('');
    lines.push('---');
    lines.push('');

    // Body
    if (bottle.body) {
      lines.push(bottle.body);
    }

    return lines.join('\n');
  }

  /**
   * Perform a dock check — scan for stale bottles.
   * A bottle is stale if it's been in the directory longer than staleThresholdMs
   * and hasn't been routed (no corresponding file in construct-coordination).
   *
   * @returns {Array<{ bottle: object, source: string, age: number }>} stale bottles
   */
  dockCheck() {
    const stale = [];
    const now = Date.now();

    for (const source of ['harbor', 'bottles']) {
      const dirPath = source === 'harbor' ? this.harborDir : this.bottlesDir;
      let files;
      try {
        files = fs.readdirSync(dirPath);
      } catch (_) { continue; }

      for (const file of files) {
        if (!file.endsWith('.md') && !file.endsWith('.bottle')) continue;
        const filePath = path.join(dirPath, file);
        try {
          const stat = fs.statSync(filePath);
          const age = now - stat.mtimeMs;
          if (age > this.staleThresholdMs) {
            const raw = fs.readFileSync(filePath, 'utf8');
            const { parseBottle } = require('./harbor-watcher');
            const bottle = parseBottle(raw, filePath);
            if (bottle.headers['$marker']) {
              stale.push({ bottle, source, age, file: filePath });
            }
          }
        } catch (err) {
          // Skip unreadable files
        }
      }
    }

    if (stale.length > 0) {
      this.stats.staleFound += stale.length;
      if (this.verbose) {
        console.log(`[BottleRouter] 🐌 Found ${stale.length} stale bottle(s):`);
        for (const s of stale) {
          const ageMin = Math.round(s.age / 60000);
          console.log(`  - ${path.basename(s.file)} (${ageMin} min old, source: ${s.source})`);
        }
      }
    }

    return stale;
  }

  /**
   * Route a bottle to construct-coordination, auto-detecting direction.
   * @param {object} bottle - parsed I2I bottle
   * @param {string} filePath - original file path
   */
  route(bottle, filePath) {
    const from = bottle.headers['FROM'] || '';
    const to = bottle.headers['TO'] || '';
    const sourceFromHarbor = filePath && filePath.includes('/harbor/');
    const sourceFromBottles = filePath && filePath.includes('/bottles/');

    if (sourceFromHarbor || (from && from.toLowerCase().includes('forgemaster'))) {
      return this.routeIncoming(bottle, filePath);
    } else if (sourceFromBottles || (to && to.toLowerCase().includes('forgemaster'))) {
      return this.routeOutgoing(bottle, filePath);
    }

    // Fallback: guess by direction
    if (to && to.toLowerCase().includes('forgemaster')) {
      return this.routeOutgoing(bottle, filePath);
    }
    return this.routeIncoming(bottle, filePath);
  }
}

module.exports = { BottleRouter };
