#!/usr/bin/env node

'use strict';

/**
 * Test: I2I Bottle Lifecycle
 *
 * Drops a test bottle, processes it through the agent, and verifies routing.
 * Tests: parsing, validation, routing, beachcombing.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Resolve paths relative to the agent
const AGENT_DIR = path.resolve(__dirname, '..');
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'i2i-bottle-test-'));

const VESSEL_DIR = path.join(TEMP_DIR, 'i2i-vessel');
const CONSTRUCT_DIR = path.join(TEMP_DIR, 'construct-coordination');
const FLEET_BRIDGE_DIR = path.join(TEMP_DIR, 'fleet-bridge');

const HARBOR_DIR = path.join(VESSEL_DIR, 'harbor');
const BOTTLES_DIR = path.join(VESSEL_DIR, 'bottles');
const FORGEMASTER_NOTES = path.join(CONSTRUCT_DIR, 'notes', 'forgemaster');
const ORACLE2_NOTES = path.join(CONSTRUCT_DIR, 'notes', 'oracle2');

const { parseBottle } = require(path.join(AGENT_DIR, 'src', 'harbor-watcher'));
const { BottleValidator } = require(path.join(AGENT_DIR, 'src', 'bottle-validator'));
const { BottleRouter } = require(path.join(AGENT_DIR, 'src', 'bottle-router'));
const { Beachcomber } = require(path.join(AGENT_DIR, 'src', 'beachcomber'));

// Track results
let passed = 0;
let failed = 0;
const results = [];

function assert(condition, message) {
  if (condition) {
    passed++;
    results.push(`  ✅ ${message}`);
  } else {
    failed++;
    results.push(`  ❌ ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
    results.push(`  ✅ ${message} (${JSON.stringify(actual)})`);
  } else {
    failed++;
    results.push(`  ❌ ${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─── Setup ──────────────────────────────────────────────────
function setupDirectories() {
  for (const dir of [HARBOR_DIR, BOTTLES_DIR, FORGEMASTER_NOTES, ORACLE2_NOTES, FLEET_BRIDGE_DIR, path.join(FLEET_BRIDGE_DIR, 'src')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function cleanup() {
  try {
    fs.rmSync(TEMP_DIR, { recursive: true });
  } catch (_) { /* ignore */ }
}

// ─── Test Bottles ──────────────────────────────────────────────

const VALID_HARBOR_BOTTLE = `[I2I:BOTTLE:20260608] Forgemaster Response — Convergence Confirmed

FROM: Forgemaster ⚒️ (ProArt Ryzen + RTX4050)
TO: Oracle2 🦀 (ARM64, 4c/24GB)
TIMESTAMP: 2026-06-08T04:30:00Z
TYPE: BOTTLE — Response + Status Dispatch

---

## Convergence

The stack is aligned. Running integration tests.
`;

const VALID_OUTGOING_BOTTLE = `[I2I:BOTTLE:20260608] Oracle2 Dispatch — Integration Ready

FROM: Oracle2 🦀 (ARM64, 4c/24GB)
TO: Forgemaster ⚒️ (ProArt Ryzen + RTX4050)
TIMESTAMP: 2026-06-08T04:00:00Z
TYPE: BOTTLE — Architectural Dispatch

---

## Wave 3

Integration tests are building. Route this through to Forgemaster.
`;

const INVALID_BOTTLE_NO_MARKER = `FROM: Oracle2
TO: Forgemaster
TIMESTAMP: 2026-06-08T04:00:00Z
TYPE: BOTTLE

---

Missing [I2I:BOTTLE:...] marker.
`;

const INVALID_BOTTLE_MISSING_FIELDS = `[I2I:BOTTLE:20260608] Partial Bottle

FROM: Oracle2
TYPE: BOTTLE

---

Missing TO and TIMESTAMP.
`;

// ─── Test 1: Parse Bottle ──────────────────────────────────
function testParse() {
  results.push('\n📦 Test 1: Parse Bottle');
  results.push('──────────────────────');

  const bottle = parseBottle(VALID_HARBOR_BOTTLE, '/tmp/test.md');
  assert(bottle.headers['$marker'] === 'I2I:BOTTLE:20260608', 'Correct I2I marker');
  assertEqual(bottle.headers['FROM'], 'Forgemaster ⚒️ (ProArt Ryzen + RTX4050)', 'FROM header');
  assertEqual(bottle.headers['TO'], 'Oracle2 🦀 (ARM64, 4c/24GB)', 'TO header');
  assertEqual(bottle.headers['TIMESTAMP'], '2026-06-08T04:30:00Z', 'TIMESTAMP header');
  assertEqual(bottle.headers['TYPE'], 'BOTTLE — Response + Status Dispatch', 'TYPE header');
  assert(bottle.body.includes('## Convergence'), 'Body contains content');
  assert(bottle.body.includes('Running integration tests'), 'Body preserved');
  assertEqual(bottle.headers['$subject'], 'Forgemaster Response — Convergence Confirmed', 'Subject line');
}

// ─── Test 2: Validate Bottles ──────────────────────────────
function testValidate() {
  results.push('\n📦 Test 2: Validate Bottles');
  results.push('──────────────────────────');

  const validator = new BottleValidator({ strict: false });

  // Valid bottle
  const valid = parseBottle(VALID_HARBOR_BOTTLE);
  const validResult = validator.validate(valid);
  assert(validResult.valid, 'Valid bottle passes validation');
  assertEqual(validResult.errors.length, 0, 'No errors for valid bottle');

  // Invalid: no marker
  const noMarker = parseBottle(INVALID_BOTTLE_NO_MARKER);
  const noMarkerResult = validator.validate(noMarker);
  assert(!noMarkerResult.valid, 'Bottle without marker is invalid');
  assert(
    noMarkerResult.errors.some(e => e.includes('Missing I2I bottle marker')),
    'Reports missing marker error'
  );

  // Invalid: missing fields
  const partial = parseBottle(INVALID_BOTTLE_MISSING_FIELDS);
  const partialResult = validator.validate(partial);
  assert(!partialResult.valid, 'Partial bottle is invalid');
  assert(
    partialResult.errors.some(e => e.includes('TO')),
    'Reports missing TO field'
  );
  assert(
    partialResult.errors.some(e => e.includes('TIMESTAMP')),
    'Reports missing TIMESTAMP field'
  );

  // Valid outgoing bottle
  const outgoing = parseBottle(VALID_OUTGOING_BOTTLE);
  const outgoingResult = validator.validate(outgoing);
  assert(outgoingResult.valid, 'Valid outgoing bottle passes validation');
}

// ─── Test 3: Route Harbor Bottle ───────────────────────────
function testRouteHarbor() {
  results.push('\n📦 Test 3: Route Harbor Bottle (Incoming)');
  results.push('───────────────────────────────────────────');

  const validator = new BottleValidator({ strict: false });
  const router = new BottleRouter({
    vesselDir: VESSEL_DIR,
    constructCoordDir: CONSTRUCT_DIR,
    fleetBridgeDir: FLEET_BRIDGE_DIR,
    verbose: false,
    validator
  });

  // Write bottle to harbor
  const harborPath = path.join(HARBOR_DIR, 'test-harbor-bottle.md');
  fs.writeFileSync(harborPath, VALID_HARBOR_BOTTLE, 'utf8');

  const bottle = parseBottle(VALID_HARBOR_BOTTLE, harborPath);
  const dest = router.routeIncoming(bottle, harborPath);

  assert(dest !== null, 'RouteIncoming returns destination path');
  assert(dest.startsWith(ORACLE2_NOTES), 'Routed to oracle2/notes/');

  const destContent = fs.readFileSync(dest, 'utf8');
  assert(destContent.includes(VALID_HARBOR_BOTTLE.trim()), 'Bottle content preserved at destination');

  // Check that fleet bridge mirror was created
  const bottleFiles = fs.readdirSync(BOTTLES_DIR);
  const mirror = bottleFiles.find(f => f.includes('mirror'));
  assert(!!mirror, 'Fleet bridge mirror created in bottles/');
}

// ─── Test 4: Route Outgoing Bottle ─────────────────────────
function testRouteOutgoing() {
  results.push('\n📦 Test 4: Route Outgoing Bottle');
  results.push('────────────────────────────────');

  const validator = new BottleValidator({ strict: false });
  const router = new BottleRouter({
    vesselDir: VESSEL_DIR,
    constructCoordDir: CONSTRUCT_DIR,
    fleetBridgeDir: FLEET_BRIDGE_DIR,
    verbose: false,
    validator
  });

  // Write bottle to bottles/
  const bottlePath = path.join(BOTTLES_DIR, 'test-outgoing-bottle.md');
  fs.writeFileSync(bottlePath, VALID_OUTGOING_BOTTLE, 'utf8');

  const bottle = parseBottle(VALID_OUTGOING_BOTTLE, bottlePath);
  const dest = router.routeOutgoing(bottle, bottlePath);

  assert(dest !== null, 'RouteOutgoing returns destination path');
  assert(dest.startsWith(FORGEMASTER_NOTES), 'Routed to forgemaster/notes/');

  const destContent = fs.readFileSync(dest, 'utf8');
  assert(destContent.includes(VALID_OUTGOING_BOTTLE.trim()), 'Outgoing bottle content preserved');
}

// ─── Test 5: Beachcomber ─────────────────────────────────────
function testBeachcomber() {
  results.push('\n📦 Test 5: Beachcomber — Import from construct-coordination');
  results.push('──────────────────────────────────────────────────────────');

  const validator = new BottleValidator({ strict: false });
  const beachcomber = new Beachcomber({
    vesselDir: VESSEL_DIR,
    constructCoordDir: CONSTRUCT_DIR,
    validator,
    verbose: false
  });

  // Place a bottle in forgemaster notes (as if dropped by Forgemaster)
  const forgemasterBottle = `[I2I:BOTTLE:20260609] Forgemaster Integration Report

FROM: Forgemaster ⚒️ (ProArt Ryzen + RTX4050)
TO: Oracle2 🦀 (ARM64, 4c/24GB)
TIMESTAMP: 2026-06-09T04:45:00Z
TYPE: BOTTLE — Integration Run Complete

---

## RTX4050 Results

Successfully ran all Snail Shell tests. CUDA tensors resolved.
`;

  const srcPath = path.join(FORGEMASTER_NOTES, '20260608-forgemaster-integration.md');
  fs.writeFileSync(srcPath, forgemasterBottle, 'utf8');

  // Also place a non-bottle file (should be skipped)
  fs.writeFileSync(
    path.join(FORGEMASTER_NOTES, 'readme.md'),
    '# Notes\nNot an I2I bottle.\n',
    'utf8'
  );

  const result = beachcomber.beachcomb();

  assert(result.harbor.length === 1, 'One bottle imported to harbor');
  assert(result.bottles.length === 0, 'No bottles imported from oracle2 notes (none placed)');

  // Verify the harbor file exists and has content
  const harborFiles = fs.readdirSync(HARBOR_DIR);
  const imported = harborFiles.find(f => f.includes('forgemaster-integration'));
  assert(!!imported, 'Imported bottle exists in harbor');
  if (imported) {
    const content = fs.readFileSync(path.join(HARBOR_DIR, imported), 'utf8');
    assert(content.includes('Forgemaster'), 'Harbor bottle has Forgemaster content');
  }

  // Second run should skip (already imported)
  const secondResult = beachcomber.beachcomb();
  assert(secondResult.harbor.length === 0, 'Second run skips already-imported bottles');
}

// ─── Test 6: Dock Check ─────────────────────────────────────
function testDockCheck() {
  results.push('\n📦 Test 6: Dock Check — Stale Bottles');
  results.push('──────────────────────────────────────');

  const validator = new BottleValidator({ strict: false });
  const router = new BottleRouter({
    vesselDir: VESSEL_DIR,
    constructCoordDir: CONSTRUCT_DIR,
    fleetBridgeDir: FLEET_BRIDGE_DIR,
    staleThresholdMs: 1, // 1ms — everything is stale
    verbose: false,
    validator
  });

  const stale = router.dockCheck();
  // Should find bottles still in harbor/bottles that exist (from prior tests)
  assert(stale.length > 0, 'Finds stale bottles when threshold is 1ms');
}

// ─── Test 7: Auto-route via Route() ────────────────────────
function testRoute() {
  results.push('\n📦 Test 7: Auto-Route (direction detection)');
  results.push('────────────────────────────────────────────');

  const validator = new BottleValidator({ strict: false });
  const router = new BottleRouter({
    vesselDir: VESSEL_DIR,
    constructCoordDir: CONSTRUCT_DIR,
    fleetBridgeDir: FLEET_BRIDGE_DIR,
    verbose: false,
    validator
  });

  // Test with a new bottle TO Forgemaster (should go to forgemaster notes)
  const toForgemaster = `[I2I:BOTTLE:20260608] Oracle2 Status

FROM: Oracle2 🦀
TO: Forgemaster ⚒️ (ProArt Ryzen + RTX4050)
TIMESTAMP: 2026-06-08T05:00:00Z
TYPE: STATUS — All Good

---

Systems nominal.
`;

  const bottlePath = path.join(BOTTLES_DIR, 'auto-route-test.md');
  fs.writeFileSync(bottlePath, toForgemaster, 'utf8');

  const bottle = parseBottle(toForgemaster, bottlePath);
  const dest = router.route(bottle, bottlePath);
  assert(dest !== null, 'Auto-route succeeds');
  assert(dest.includes('forgemaster'), 'Auto-routes outgoing to forgemaster notes');
}

// ─── Test 8: Parse Variety of Formats ──────────────────────
function testParseVariants() {
  results.push('\n📦 Test 8: Parse Bottle Variants');
  results.push('────────────────────────────────');

  // Test with emoji headers
  const withEmoji = `[I2I:BOTTLE:20260608] Emoji Test

FROM: Oracle2 🦀
TO: Forgemaster ⚒️
TIMESTAMP: 2026-06-08T06:00:00Z
TYPE: TASK — Run Tests

---

Body with emoji 🎉
`;

  const parsed = parseBottle(withEmoji);
  assertEqual(parsed.headers['FROM'], 'Oracle2 🦀', 'FROM with emoji');
  assertEqual(parsed.headers['TO'], 'Forgemaster ⚒️', 'TO with emoji');
  assert(parsed.body.includes('🎉'), 'Body with emoji preserved');
}

// ─── Run All Tests ──────────────────────────────────────────
function runAll() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  I2I Bottle Agent — Test Suite              ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  Temp dir: ${TEMP_DIR}`);
  console.log('');

  setupDirectories();

  testParse();
  testValidate();
  testRouteHarbor();
  testRouteOutgoing();
  testBeachcomber();
  testDockCheck();
  testRoute();
  testParseVariants();

  cleanup();

  console.log('');
  console.log(results.join('\n'));

  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  const total = passed + failed;
  console.log(`║  Results: ${passed}/${total} passed`);
  if (failed === 0) {
    console.log('║  🎉 ALL TESTS PASSED');
  } else {
    console.log(`║  ❌ ${failed} test(s) failed`);
  }
  console.log('╚══════════════════════════════════════════════╝');

  process.exit(failed > 0 ? 1 : 0);
}

runAll();
