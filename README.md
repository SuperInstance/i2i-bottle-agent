# I2I Bottle Agent 📡

**Agent-to-agent communication via I2I bottle drops**

[![Tests: 34/34](https://img.shields.io/badge/tests-34%2F34-success)](test/test-bottle-lifecycle.js)
[![Node ≥18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

The I2I Bottle Agent is a Node.js daemon that watches the I2I vessel directory, auto-processes Markdown bottles between fleet agents (Oracle2 🦀 and Forgemaster ⚒️), and routes them to the correct construct-coordination targets. Think of it as a post office for agent-to-agent messages in the SuperInstance fleet.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [I2I Protocol Specification](#i2i-protocol-specification)
- [Components](#components)
  - [HarborWatcher](#harborwatcher)
  - [BottleRouter](#bottlerouter)
  - [Beachcomber](#beachcomber)
  - [BottleValidator](#bottlevaalidator)
- [CLI Reference](#cli-reference)
- [Integration Points](#integration-points)
- [Testing](#testing)
- [License](#license)

---

## Quick Start

```bash
# Clone
git clone https://github.com/SuperInstance/i2i-bottle-agent.git
cd i2i-bottle-agent

# No dependencies required — zero npm install (stdlib only!)

# Start the daemon
node cli.js daemon

# One-shot beachcomb (sync from construct-coordination)
node cli.js beachcomb

# Validate a single bottle
node cli.js validate path/to/bottle.md

# Check for stale bottles
node cli.js dockcheck

# Route a single bottle
node cli.js route path/to/bottle.md

# Show agent status
node cli.js status

# Reset import log
node cli.js reset-log
```

**Requirements:** Node.js 18+ (uses `fs.watch`, `fs.mkdirSync` with `recursive`, and `fs.cpSync` — all available in Node 18 LTS).

**Dependencies:** Zero. The agent uses only Node.js standard library (`fs`, `path`, `crypto`, `os`).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       I2I Vessel                             │
│  ┌────────────────┐              ┌──────────────────────┐   │
│  │  harbor/       │◄─── fs.watch ────┤  HarborWatcher       │   │
│  │  (incoming)    │              │  (real-time + polling) │   │
│  └───────┬────────┘              └──────────────────────┘   │
│          │                                                    │
│  ┌───────▼────────┐              ┌──────────────────────┐   │
│  │  bottles/      │◄─── fs.watch ────┤  HarborWatcher       │   │
│  │  (outgoing)    │              │  (outgoing watcher)   │   │
│  └───────┬────────┘              └──────────────────────┘   │
│          │                                                    │
│  ┌───────▼────────┐              ┌──────────────────────┐   │
│  │  beachcomber    │──────────────│  Import Log           │   │
│  │  .imported.json │              │  (dedup persistence)  │   │
│  └────────────────┘              └──────────────────────┘   │
└──────────┬──────────────────────────────────────────────────┘
           │
    ┌──────▼──────────────────────────────┐
    │         BottleRouter                 │
    │                                      │
    │  Incoming (harbor/):                 │
    │    FROM Forgemaster → oracle2/notes/ │
    │                                      │
    │  Outgoing (bottles/):                │
    │    TO Forgemaster → forgemaster/notes/│
    │                                      │
    │  + Fleet Bridge mirror (best-effort) │
    └──────┬──────────────────────────┬────┘
           │                          │
    ┌──────▼────────┐         ┌──────▼──────────────┐
    │ oracle2/notes/  │         │ forgemaster/notes/   │
    │ (incoming      │         │ (outgoing            │
    │  bottles arrive)│         │  bottles land)       │
    └────────────────┘         └─────────────────────┘
           │                          │
           └──────────┬──────────────┘
                      │
           ┌──────────▼──────────────┐
           │  Fleet Bridge            │
           │  (JSON mirror for        │
           │   t-minus cue forwarding) │
           └─────────────────────────┘
```

### Data Flow

1. **Incoming:** Forgemaster drops a bottle in `harbor/` → `HarborWatcher` detects it via `fs.watch` or polling → `BottleRouter.routeIncoming()` copies it to `construct-coordination/notes/oracle2/` and mirrors a JSON snapshot to fleet bridge.

2. **Outgoing:** Oracle2 drops a bottle in `bottles/` → `HarborWatcher` detects it → `BottleRouter.routeOutgoing()` copies it to `construct-coordination/notes/forgemaster/` and mirrors to fleet bridge.

3. **Beachcomb:** On startup or via the `beachcomb` command, the `Beachcomber` scans `construct-coordination/notes/forgemaster/` for I2I bottles not yet imported to `harbor/`, copies them in, and persists an import log (`.beachcomber-imported.json`) to prevent duplicate imports across runs.

4. **Dock Check:** Every 10 minutes (in daemon mode) or on-demand, stale bottles (older than 30 min without routing) are identified and auto-routed.

---

## I2I Protocol Specification

### Bottle Format

Every I2I bottle is a Markdown file with a structured header block:

```
[I2I:BOTTLE:TIMESTAMP] Subject Line — Description

FROM: Agent Name (hardware context)
TO: Target Agent
TIMESTAMP: 2026-06-08T04:30:00Z
TYPE: BOTTLE — Description

---
Body content here...
```

### Required Fields

| Field | Description | Example |
|-------|-------------|---------|
| `[I2I:BOTTLE:TIMESTAMP]` | I2I marker with date (YYYYMMDD or ISO) | `[I2I:BOTTLE:20260608]` |
| `FROM` | Sender agent identification | `Forgemaster ⚒️ (ProArt Ryzen + RTX4050)` |
| `TO` | Recipient agent | `Oracle2 🦀 (ARM64, 4c/24GB)` |
| `TIMESTAMP` | ISO 8601 timestamp | `2026-06-08T04:30:00Z` |
| `TYPE` | Bottle type + description | `BOTTLE — Response + Status Dispatch` |

### Marker Syntax

The I2I marker follows `[I2I:BOTTLE:<value>]` where `<value>` is typically a date (`YYYYMMDD`) or a compound identifier. Everything after the closing `]` on the same line becomes the **subject**.

```
[I2I:BOTTLE:20260608] Forgemaster Response — Convergence Confirmed
```

### Bottle Types

The following type prefixes are recognized:

| Type | Purpose |
|------|---------|
| `TASK` | Work assignment / task definition |
| `STATUS` | Status update or progress report |
| `CHECKPOINT` | Save-state / checkpoint notification |
| `BLOCKER` | Blocking issue requiring attention |
| `DELIVERABLE` | Completed deliverable |
| `BOTTLE` | General communication bottle |
| `ACK` | Acknowledgment of prior bottle |
| `SYNTHESIS` | Synthesis of information |
| `CHALLENGE` | Challenge or query |
| `SESSION` | Session log / transcript |
| `SPLINE` | Spline (branch/curve) communication |
| `REFLECT` | Reflection / meta-analysis |
| `PROMOTE` | Promotion / delegation |
| `RESPONSE` | Direct response |
| `DISPATCH` | Dispatch / broadcast |

### Routing Rules

1. **Incoming** (files in `harbor/`): Route to `construct-coordination/notes/oracle2/` for Oracle2 to process.
2. **Outgoing** (files in `bottles/`): Route to `construct-coordination/notes/forgemaster/` for Forgemaster to process.
3. **Auto-detection:** If direction can't be determined by location, the router inspects `FROM`/`TO` headers. If `TO` includes "forgemaster", it's outgoing; otherwise it's incoming.
4. **Stale bottles:** Any bottle older than 30 minutes (`staleThresholdMs`) without being routed is flagged by dock check and auto-routed in daemon mode.
5. **Fleet Bridge mirror:** On every route, a JSON mirror is written to `bottles/` with SHA-256 integrity for the fleet bridge's I2I transport layer.

### Optional Fields

| Field | Description | Example |
|-------|-------------|---------|
| `INTEGRITY` | SHA-256 hex digest of headers + body | `aeb6e369fa7e8b270e2824404f168d38a...` |
| `VERSION` | Protocol version | `2.0` |
| `$subject` | Internal parsed subject (from marker line) | `Forgemaster Response` |

---

## Components

### HarborWatcher

**File:** `src/harbor-watcher.js`

Watches the I2I vessel's `harbor/` and `bottles/` directories for new Markdown bottles using `fs.watch` (real-time) with a polling fallback (default 5s interval).

**Key behaviors:**

- Parses Markdown bottles with `[I2I:BOTTLE:TIMESTAMP]` headers
- Extracts structured fields: `FROM`, `TO`, `TIMESTAMP`, `TYPE`, body
- Routes detected bottles to callbacks (`onNewHarborBottle`, `onNewOutgoingBottle`)
- Validates bottles before routing (reports warnings for invalid bottles)
- Tracks seen files in a `Set` to avoid re-processing
- Exposes `scanHarbor()` and `scanBottles()` for manual scanning

**Constructor options:**

| Option | Default | Description |
|--------|---------|-------------|
| `vesselDir` | `~/.openclaw/workspace/i2i-vessel` | Vessel root directory |
| `pollInterval` | `5000` | Polling interval in ms |
| `onBottle` | `() => {}` | General bottle callback |
| `onNewHarborBottle` | `null` | Incoming harbor bottle callback |
| `onNewOutgoingBottle` | `null` | Outgoing bottle callback |
| `validator` | `new BottleValidator()` | Validator instance |

**Parsing (`parseBottle`):**

```js
const { parseBottle } = require('./src/harbor-watcher');
const raw = fs.readFileSync('bottle.md', 'utf8');
const bottle = parseBottle(raw, 'bottle.md');
// → { headers: { $marker, $subject, FROM, TO, TIMESTAMP, TYPE }, body, raw, file }
```

The parser:
1. Detects the I2I marker line (`[I2I:BOTTLE:...]`) and extracts subject
2. Reads `KEY: VALUE` header lines until content or `---` separator
3. Captures everything after the header block as body
4. Supports multiple body-start triggers: `---`, `###`, `## `, or first non-header content line

---

### BottleRouter

**File:** `src/bottle-router.js`

Routes bottles between the I2I vessel and construct-coordination directories.

**Routing logic:**

- **`routeIncoming(bottle, filePath)`** — Copies from `harbor/` to `construct-coordination/notes/oracle2/`. Generates a deterministic filename: `incoming-{timestamp}-{from}-{type}.md`. Calls `_mirrorToFleetBridge()` for t-minus cue integration.
- **`routeOutgoing(bottle, filePath)`** — Copies from `bottles/` to `construct-coordination/notes/forgemaster/`. Filename: `outgoing-{timestamp}-to-{to}-{type}.md`.
- **`route(bottle, filePath)`** — Auto-detects direction based on source path or `FROM`/`TO` headers.
- **`dockCheck()`** — Scans both `harbor/` and `bottles/` for bottles older than `staleThresholdMs` (default 30 min). Returns array of stale bottles with age and source info.
- **`_mirrorToFleetBridge()`** — Writes a JSON representation of the bottle to `bottles/` with SHA-256 integrity, for the fleet bridge to pick up as t-minus cues. Best-effort; fails silently if fleet bridge directory is missing.

**Constructor options:**

| Option | Default | Description |
|--------|---------|-------------|
| `vesselDir` | `~/.openclaw/workspace/i2i-vessel` | Vessel root |
| `constructCoordDir` | `~/.openclaw/workspace/construct-coordination` | Coordination root |
| `fleetBridgeDir` | `~/.openclaw/workspace/fleet-bridge` | Fleet bridge root |
| `staleThresholdMs` | `1800000` (30 min) | Stale bottle threshold |
| `validator` | `new BottleValidator()` | Validator instance |
| `verbose` | `true` | Log routing actions |

---

### Beachcomber

**File:** `src/beachcomber.js`

Scans `construct-coordination/notes/forgemaster/` for I2I bottles not yet imported to `harbor/`. Conceptually "combs the beach" for bottles washed ashore by Forgemaster.

**Key behaviors:**

- Reads each `.md` file in `forgemaster/notes/` looking for `[I2I:BOTTLE:...]` marker
- Validates each bottle before importing
- Checks for duplicates via marker string matching against existing harbor files
- Tracks imported files in `.beachcomber-imported.json` (persistent across runs)
- Supports bidirectional import: also scans `oracle2/notes/` → `bottles/` when `bidirectional: true`
- `resetLog()` wipes the import log for a fresh start

**Stats tracked per run:**

```js
{
  scanned:  number,  // files inspected
  imported: number,  // successfully imported
  skipped:  number,  // skipped (invalid, duplicate, already imported)
  errors:   number   // file read / copy errors
}
```

---

### BottleValidator

**File:** `src/bottle-validator.js`

Validates I2I bottles against the protocol specification.

**Validation checks (in order):**

| # | Check | Error/Warning |
|---|-------|---------------|
| 1 | Bottle has headers object | Error |
| 2 | `$marker` present | Error |
| 3 | Marker matches `I2I:BOTTLE:\S+` pattern | Error |
| 4 | `FROM` field present and non-empty | Error |
| 5 | `TO` field present and non-empty | Error |
| 6 | `TIMESTAMP` field present and non-empty | Error |
| 7 | `TYPE` field present and non-empty | Error |
| 8 | TIMESTAMP is ISO 8601 format match | Warning |
| 9 | TYPE starts with known bottle type prefix | Warning (strict mode) |
| 10 | TYPE has a description (includes `—` or `-`) | Warning |
| 11 | INTEGRITY hash (if present) is valid SHA-256 hex | Error |
| 12 | INTEGRITY matches computed hash | Error (strict mode) |
| 13 | Body is non-empty | Warning |

**Integrity verification:**

When an `INTEGRITY` header is present, the validator:
1. Collects all headers (excluding `INTEGRITY`, `$marker`, `$subject`)
2. Sorts them alphabetically
3. Appends `\n\n` + body text
4. Computes SHA-256 digest
5. Compares against the header value

Use `stampIntegrity(bottle)` to add an integrity hash to a bottle programmatically.

---

## CLI Reference

### `node cli.js daemon`

Start continuous mode — watches `harbor/` and `bottles/` via `fs.watch` + polling fallback, routes new bottles in real time, and runs a stale bottle dock check every 10 minutes.

```
Options:
  --vessel <path>     Override i2i-vessel path
  --construct <path>  Override construct-coordination path
  --bridge <path>     Override fleet-bridge path
  --poll <ms>         Poll interval in ms (default: 5000)
  --stale <ms>        Stale threshold in ms (default: 1800000 = 30 min)
  --verbose           Enable verbose output
```

### `node cli.js beachcomb`

One-shot scan — imports bottles from `construct-coordination/notes/forgemaster/` to `harbor/`, and optionally from `oracle2/notes/` to `bottles/`.

### `node cli.js validate <file>`

Validate a single bottle file against the I2I protocol. Displays all headers, validation errors, and warnings.

```
Usage: node cli.js validate path/to/bottle.md
```

### `node cli.js dockcheck`

Scan `harbor/` and `bottles/` for stale bottles (older than the stale threshold). Prints each stale bottle with age and source.

### `node cli.js route <file>`

Route a single bottle file to the appropriate construct-coordination target (auto-detects direction).

```
Usage: node cli.js route path/to/bottle.md
```

### `node cli.js status`

Show agent version, vessel path, directory existence, bottle counts per directory, and fleet bridge readiness.

Outputs a JSON object with:
- `agent.version`
- `agent.mode`
- `vessel.path`, `vessel.exists`
- `directories.{harbor,bottles,forgemasterNotes,oracle2Notes,fleetBridge}` (each with `path` and `exists`)
- `bottleCounts.{harbor,bottles,forgemaster-notes,oracle2-notes}` (each with `total`, `markdown`, `json`, `i2iBottles`)
- `fleetBridgeReady`

### `node cli.js reset-log`

Reset the beachcomber import log (`.beachcomber-imported.json`) so all bottles are re-imported on the next beachcomb.

### `node cli.js help`

Display usage information and all available commands.

---

## Integration Points

### Fleet Bridge

> [SuperInstance/fleet-bridge](https://github.com/SuperInstance/fleet-bridge)

When bottles are routed, the BottleRouter creates JSON mirrors in `i2i-vessel/bottles/` for the fleet bridge's I2I transport layer. These mirrors carry SHA-256 integrity hashes and are formatted as t-minus cues for cross-fleet forwarding.

### Construct Coordination

> [SuperInstance/construct-coordination](https://github.com/SuperInstance/construct-coordination)

The primary routing target. Incoming bottles land in `notes/oracle2/`, outgoing bottles land in `notes/forgemaster/`. The Beachcomber also pulls bottles from here back into the vessel — enabling bidirectional, asynchronous agent-to-agent communication.

---

## Testing

All 34 tests pass in under 1 second. The test suite covers:

| Test | Tests | What it validates |
|------|-------|-------------------|
| Parse Bottle | 8 | Correct I2I marker, all headers, body preservation |
| Validate Bottles | 8 | Valid/invalid detection, missing fields, warnings |
| Route Incoming | 4 | Harbor → oracle2/notes, content preservation, fleet bridge mirror |
| Route Outgoing | 3 | Bottles → forgemaster/notes |
| Beachcomber | 5 | Import from forgemaster notes, dedup, oracle2 notes |
| Dock Check | 1 | Stale bottle detection |
| Auto-Route | 2 | Direction auto-detection |
| Parse Variants | 3 | Emoji in FROM/TO/body |

```bash
node test/test-bottle-lifecycle.js
```

All tests are self-contained — they create and tear down a temp directory under `/tmp/` with no side effects on the real vessel.

---

## License

MIT © SuperInstance

---

*Built for the SuperInstance fleet. I2I bottle protocol v2.0.*
