#!/usr/bin/env node

'use strict';

const path = require('path');
const fs = require('fs');
const { HarborWatcher } = require('./src/harbor-watcher');
const { BottleRouter } = require('./src/bottle-router');
const { Beachcomber } = require('./src/beachcomber');
const { BottleValidator } = require('./src/bottle-validator');

const VESSEL_DIR = path.join(process.env.HOME || '/tmp', '.openclaw', 'workspace', 'i2i-vessel');
const CONSTRUCT_COORD_DIR = path.join(process.env.HOME || '/tmp', '.openclaw', 'workspace', 'construct-coordination');
const FLEET_BRIDGE_DIR = path.join(process.env.HOME || '/tmp', '.openclaw', 'workspace', 'fleet-bridge');

function printHelp() {
  console.log(`
I2I Bottle Agent — watches the I2I vessel and auto-processes bottles

USAGE:
  node cli.js <command> [options]

COMMANDS:
  daemon              Start continuous mode — watch harbor/ and bottles/,
                      route new bottles, check for stale bottles every 10 min
                      
  beachcomb           One-shot scan — import bottles from
                      construct-coordination/notes/forgemaster/ to harbor/
                      
  validate <file>     Validate a single bottle file
  
  dockcheck           Scan for stale bottles in harbor/ and bottles/
  
  route <file>        Route a single bottle file to construct-coordination
  
  status              Show agent status, stats, and vessel state
  
  reset-log           Reset beachcomber import log
  
  help                Show this help message

OPTIONS:
  --vessel <path>     Override i2i-vessel path
  --construct <path>  Override construct-coordination path
  --bridge <path>     Override fleet-bridge path
  --poll <ms>         Poll interval in ms (default: 5000)
  --stale <ms>        Stale threshold in ms (default: 1800000 = 30 min)
  --verbose           Enable verbose output
`);
}

/**
 * Parse CLI args for options.
 */
function parseOptions(argv) {
  const opts = {
    vesselDir: VESSEL_DIR,
    constructCoordDir: CONSTRUCT_COORD_DIR,
    fleetBridgeDir: FLEET_BRIDGE_DIR,
    pollInterval: 5000,
    staleThresholdMs: 30 * 60 * 1000,
    verbose: false
  };

  for (let i = 3; i < argv.length; i++) {
    switch (argv[i]) {
      case '--vessel':
        opts.vesselDir = argv[++i];
        break;
      case '--construct':
        opts.constructCoordDir = argv[++i];
        break;
      case '--bridge':
        opts.fleetBridgeDir = argv[++i];
        break;
      case '--poll':
        opts.pollInterval = parseInt(argv[++i], 10) || 5000;
        break;
      case '--stale':
        opts.staleThresholdMs = parseInt(argv[++i], 10) || 1800000;
        break;
      case '--verbose':
        opts.verbose = true;
        break;
    }
  }

  return opts;
}

/**
 * DAEMON mode — continuous operation.
 * Watches harbor/ and bottles/, routes new bottles,
 * and periodically runs dock checks.
 */
async function cmdDaemon(opts) {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   I2I Bottle Agent — Daemon Mode        ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  Vessel:     ${opts.vesselDir}`);
  console.log(`  Harbor:     ${path.join(opts.vesselDir, 'harbor')}`);
  console.log(`  Bottles:    ${path.join(opts.vesselDir, 'bottles')}`);
  console.log(`  Construct:  ${opts.constructCoordDir}`);
  console.log(`  Fleet Brdg: ${opts.fleetBridgeDir}`);
  console.log(`  Poll:       ${opts.pollInterval}ms`);
  console.log(`  Stale:      ${opts.staleThresholdMs}ms`);
  console.log('');

  const validator = new BottleValidator({ strict: false });
  const router = new BottleRouter({
    vesselDir: opts.vesselDir,
    constructCoordDir: opts.constructCoordDir,
    fleetBridgeDir: opts.fleetBridgeDir,
    staleThresholdMs: opts.staleThresholdMs,
    verbose: opts.verbose,
    validator
  });

  const watcher = new HarborWatcher({
    vesselDir: opts.vesselDir,
    pollInterval: opts.pollInterval,
    validator,
    verbose: opts.verbose,
    onNewHarborBottle: (bottle, filePath) => {
      console.log(`\n[Daemon] 📥 Incoming bottle from harbor:`);
      console.log(`  Subject: ${bottle.headers['$subject'] || '(no subject)'}`);
      console.log(`  From: ${bottle.headers['FROM']} → To: ${bottle.headers['TO']}`);
      console.log(`  Type: ${bottle.headers['TYPE']}`);
      router.routeIncoming(bottle, filePath);
    },
    onNewOutgoingBottle: (bottle, filePath) => {
      console.log(`\n[Daemon] 📤 Outgoing bottle from bottles/:`);
      console.log(`  Subject: ${bottle.headers['$subject'] || '(no subject)'}`);
      console.log(`  From: ${bottle.headers['FROM']} → To: ${bottle.headers['TO']}`);
      console.log(`  Type: ${bottle.headers['TYPE']}`);
      router.routeOutgoing(bottle, filePath);
    }
  });

  watcher.start();

  // Periodic dock check (every 10 minutes)
  const dockCheckTimer = setInterval(() => {
    const stale = router.dockCheck();
    if (stale.length > 0) {
      console.log(`\n[Daemon] 🐌 ${stale.length} stale bottle(s) found`);
      // Auto-route stale bottles
      for (const s of stale) {
        console.log(`[Daemon] Auto-routing stale: ${path.basename(s.file)}`);
        try {
          const raw = fs.readFileSync(s.file, 'utf8');
          const { parseBottle } = require('./src/harbor-watcher');
          const bottle = parseBottle(raw, s.file);
          router.route(bottle, s.file);
        } catch (err) {
          console.error(`[Daemon] Error routing stale bottle: ${err.message}`);
        }
      }
    }
  }, 10 * 60 * 1000); // 10 min

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[Daemon] Shutting down...');
    watcher.stop();
    clearInterval(dockCheckTimer);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n[Daemon] Terminated');
    watcher.stop();
    clearInterval(dockCheckTimer);
    process.exit(0);
  });

  console.log('[Daemon] ✅ Running. Press Ctrl+C to stop.');
  console.log('');

  // Keep alive
  return new Promise(() => {});
}

/**
 * BEACHCOMB mode — one-shot scan.
 */
function cmdBeachcomb(opts) {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   I2I Bottle Agent — Beachcomb Mode     ║');
  console.log('╚══════════════════════════════════════════╝');

  const validator = new BottleValidator({ strict: false });
  const beachcomber = new Beachcomber({
    vesselDir: opts.vesselDir,
    constructCoordDir: opts.constructCoordDir,
    validator,
    verbose: opts.verbose
  });

  const forgemasterDir = path.join(opts.constructCoordDir, 'notes', 'forgemaster');
  if (!fs.existsSync(forgemasterDir)) {
    console.log(`\n[Beachcomb] No forgemaster notes directory at ${forgemasterDir}`);
    console.log('[Beachcomb] Nothing to beachcomb.');
    return;
  }

  const existingHarbor = fs.readdirSync(path.join(opts.vesselDir, 'harbor'))
    .filter(f => f.endsWith('.md'));
  console.log(`\n[Beachcomb] Harbor has ${existingHarbor.length} existing .md file(s)`);
  console.log(`[Beachcomb] Scanning: ${forgemasterDir}`);

  const results = beachcomber.beachcomb({ bidirectional: true });

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  Beachcomb Complete                     ║`);
  console.log(`╚══════════════════════════════════════════╝`);
  console.log(`  Scanned:     ${beachcomber.stats.scanned} files`);
  console.log(`  Imported:    ${beachcomber.stats.imported} bottles`);
  console.log(`    → harbor:  ${results.harbor.length}`);
  console.log(`    → bottles: ${results.bottles.length}`);
  console.log(`  Skipped:     ${beachcomber.stats.skipped}`);
  console.log(`  Errors:      ${beachcomber.stats.errors}`);
}

/**
 * VALIDATE mode — check a single bottle file.
 */
function cmdValidate(file, opts) {
  if (!file) {
    console.error('Usage: node cli.js validate <file>');
    process.exit(1);
  }

  const validator = new BottleValidator({ strict: true });

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`Cannot read ${file}: ${err.message}`);
    process.exit(1);
  }

  const { parseBottle } = require('./src/harbor-watcher');
  const bottle = parseBottle(raw, file);
  const result = validator.validate(bottle);

  console.log(`\nBottle: ${path.basename(file)}`);
  console.log('────────');
  console.log(`  I2I Marker:  ${bottle.headers['$marker'] || '❌ MISSING'}`);
  console.log(`  Subject:     ${bottle.headers['$subject'] || '(none)'}`);
  console.log(`  FROM:        ${bottle.headers['FROM'] || '❌'}`);
  console.log(`  TO:          ${bottle.headers['TO'] || '❌'}`);
  console.log(`  TIMESTAMP:   ${bottle.headers['TIMESTAMP'] || '❌'}`);
  console.log(`  TYPE:        ${bottle.headers['TYPE'] || '❌'}`);
  console.log(`  INTEGRITY:   ${bottle.headers['INTEGRITY'] || '(not set)'}`);
  console.log(`  Body length: ${(bottle.body || '').length} chars`);
  console.log('');

  if (result.valid) {
    console.log('✅ Bottle is VALID');
  } else {
    console.log('❌ Bottle is INVALID:');
    for (const err of result.errors) {
      console.log(`   ❌ ${err}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log('⚠ Warnings:');
    for (const w of result.warnings) {
      console.log(`   ⚠ ${w}`);
    }
  }
}

/**
 * DOCKCHECK mode.
 */
function cmdDockCheck(opts) {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   I2I Bottle Agent — Dock Check         ║');
  console.log('╚══════════════════════════════════════════╝');

  const validator = new BottleValidator({ strict: false });
  const router = new BottleRouter({
    vesselDir: opts.vesselDir,
    constructCoordDir: opts.constructCoordDir,
    fleetBridgeDir: opts.fleetBridgeDir,
    staleThresholdMs: opts.staleThresholdMs,
    verbose: opts.verbose,
    validator
  });

  const stale = router.dockCheck();
  if (stale.length === 0) {
    console.log('\n✅ All bottles are fresh — dock is clean.');
  } else {
    console.log(`\n🐌 Found ${stale.length} stale bottle(s):`);
    for (const s of stale) {
      const ageMin = Math.round(s.age / 60000);
      const ageHrs = (s.age / 3600000).toFixed(1);
      console.log(`  📄 ${path.basename(s.file)}`);
      console.log(`     Source: ${s.source}`);
      console.log(`     Age: ${ageMin} min (${ageHrs} hrs)`);
      console.log(`     From: ${s.bottle.headers['FROM'] || '?'} → To: ${s.bottle.headers['TO'] || '?'}`);
      console.log('');
    }
  }
}

/**
 * ROUTE mode — route a single bottle file.
 */
function cmdRoute(file, opts) {
  if (!file) {
    console.error('Usage: node cli.js route <file>');
    process.exit(1);
  }

  const validator = new BottleValidator({ strict: false });
  const router = new BottleRouter({
    vesselDir: opts.vesselDir,
    constructCoordDir: opts.constructCoordDir,
    fleetBridgeDir: opts.fleetBridgeDir,
    verbose: opts.verbose,
    validator
  });

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`Cannot read ${file}: ${err.message}`);
    process.exit(1);
  }

  const { parseBottle } = require('./src/harbor-watcher');
  const bottle = parseBottle(raw, file);

  if (!bottle.headers['$marker']) {
    console.error(`File is not an I2I bottle: no [I2I:BOTTLE:...] marker found`);
    process.exit(1);
  }

  console.log(`\nRouting: ${path.basename(file)}`);
  console.log(`  ${bottle.headers['FROM']} → ${bottle.headers['TO']}`);
  console.log(`  Type: ${bottle.headers['TYPE']}`);

  const result = router.route(bottle, file);
  if (result) {
    console.log(`✅ Routed to: ${path.relative(opts.constructCoordDir, result)}`);
  } else {
    console.error('❌ Routing failed');
    process.exit(1);
  }
}

/**
 * STATUS mode.
 */
function cmdStatus(opts) {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   I2I Bottle Agent — Status             ║');
  console.log('╚══════════════════════════════════════════╝');

  const vesselDir = opts.vesselDir;
  const harborDir = path.join(vesselDir, 'harbor');
  const bottlesDir = path.join(vesselDir, 'bottles');
  const forgemasterDir = path.join(opts.constructCoordDir, 'notes', 'forgemaster');
  const oracle2Dir = path.join(opts.constructCoordDir, 'notes', 'oracle2');

  const status = {
    agent: {
      version: require('./package.json').version,
      mode: 'idle'
    },
    vessel: {
      path: vesselDir,
      exists: fs.existsSync(vesselDir)
    },
    directories: {
      harbor: { path: harborDir, exists: fs.existsSync(harborDir) },
      bottles: { path: bottlesDir, exists: fs.existsSync(bottlesDir) },
      forgemasterNotes: { path: forgemasterDir, exists: fs.existsSync(forgemasterDir) },
      oracle2Notes: { path: oracle2Dir, exists: fs.existsSync(oracle2Dir) },
      fleetBridge: { path: opts.fleetBridgeDir, exists: fs.existsSync(opts.fleetBridgeDir) }
    },
    bottleCounts: {}
  };

  // Count bottles in each directory
  for (const [key, dir] of [['harbor', harborDir], ['bottles', bottlesDir],
    ['forgemaster-notes', forgemasterDir], ['oracle2-notes', oracle2Dir]]) {
    try {
      const files = fs.readdirSync(dir);
      const mdFiles = files.filter(f => f.endsWith('.md'));
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      const i2iBottles = mdFiles.filter(f => {
        try {
          return /^\[I2I:BOTTLE:/.test(fs.readFileSync(path.join(dir, f), 'utf8').split('\n')[0]);
        } catch (_) { return false; }
      });
      status.bottleCounts[key] = {
        total: files.length,
        markdown: mdFiles.length,
        json: jsonFiles.length,
        i2iBottles: i2iBottles.length
      };
    } catch (_) {
      status.bottleCounts[key] = { total: 0, markdown: 0, json: 0, i2iBottles: 0 };
    }
  }

  // Check fleet bridge
  try {
    const bridgeExists = fs.existsSync(path.join(opts.fleetBridgeDir, 'src', 'fleet-bridge.js'));
    status.fleetBridgeReady = bridgeExists;
  } catch (_) {
    status.fleetBridgeReady = false;
  }

  console.log(JSON.stringify(status, null, 2));
}

/**
 * RESET-LOG mode.
 */
function cmdResetLog(opts) {
  const beachcomber = new Beachcomber({
    vesselDir: opts.vesselDir,
    constructCoordDir: opts.constructCoordDir
  });
  beachcomber.resetLog();
}

/**
 * Entry point.
 */
async function main() {
  const argv = process.argv;
  const cmd = argv[2];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  const opts = parseOptions(argv);

  switch (cmd) {
    case 'daemon':
      await cmdDaemon(opts);
      break;
    case 'beachcomb':
      cmdBeachcomb(opts);
      break;
    case 'validate':
      cmdValidate(argv[3], opts);
      break;
    case 'dockcheck':
      cmdDockCheck(opts);
      break;
    case 'route':
      cmdRoute(argv[3], opts);
      break;
    case 'status':
      cmdStatus(opts);
      break;
    case 'reset-log':
      cmdResetLog(opts);
      break;
    default:
      console.error(`Unknown command: "${cmd}". Run 'node cli.js help' for usage.`);
      process.exit(1);
  }
}

main().catch(err => {
  console.error(`[I2I-Bottle-Agent] Fatal: ${err.message}`);
  process.exit(1);
});
