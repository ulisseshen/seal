# Changelog

All notable changes to SEAL are documented in this file.

## [0.4.0] — 2026-04-28 — "SEAL stops digging"

Emergency safety release. On 2026-04-28 the launchd service kept respawning
the runner after every `seal stop`, which combined with a failing `codex`
CLI loop produced **4452 failed codex calls in a single afternoon**, burning
API credits and creating duplicate task execution / race conditions. This
release adds the safety mechanisms that should have been there from day one.

### Added
- **Single-instance lock** in `src/runner.js` — refuses to start when another
  runner holds `~/.config/seal/run/runner.pid`. Stale locks (PID dead) are
  cleaned up automatically. Logging prefix: `[seal:lock]`.
- **Circuit breaker** (`src/circuit-breaker.js`) — generic per-name breaker
  that opens after 3 consecutive failures with a 30-minute cooldown. Wired
  into `brain/proposer.js` and `brain/onboard.js` around every `codex` /
  `claude` call. Logging prefix: `[circuit-breaker:NAME]`.
- **Hard daily proposal cap** (`MAX_PROPOSALS_PER_DAY = 3`) in
  `brain/proposer.js`, querying `date(delivered_at) = date('now')` so the
  cap survives clock skew and rolling-window edge cases. Belt-and-suspenders
  alongside the existing 24h fatigue gate.
- **`seal status`** CLI subcommand showing the runner lock, circuit-breaker
  state, and running/pending/firing/done-today task counts. Designed to
  answer "why isn't SEAL doing anything?" without grepping the runner log.

### Changed
- **launchd plist** (`com.ulisseshen.seal.plist`) — `KeepAlive` set to
  `false`. The runner used to auto-restart on `Crashed=true`, which in
  combination with the codex failure loop produced the respawn storm.
  `RunAtLoad=true` is preserved so SEAL still comes back after a reboot;
  stop/start during a session is now manual via `seal stop` / `seal start`.

### Philosophy
SEAL is autonomous, but autonomous systems with infinite-retry loops and
no concurrency guards turn into runaway processes. Every external CLI call
goes through a circuit breaker; every long-lived process holds a lock; and
the supervisor (launchd) trusts our own lifecycle rather than papering over
crashes.

## [0.3.0] — 2026-04-10 — "SEAL sees"

The Eye opens. SEAL now passively observes your git activity — branches, commits, merges, pushes, tags — and surfaces them in a live dashboard. No inference, no proposals, no LLM calls. Pure mechanical observation.

### Added
- `events` table (append-only, 90-day retention) and `watched_repos` table in SQLite
- `EventBus` with three-tier subscription granularity (all / source / kind)
- `Observer` abstract base class for future observers (calendar, shell, file)
- `GitObserver` — ingests git hooks via `POST /api/observe/git`, drains an offline IPC queue, and runs a 5-minute fallback scraper for repos where hooks aren't installed
- Dashboard **Workspaces** tab: add a parent folder, multi-select repos to watch, synchronous git hook install with backup of pre-existing user hooks
- Dashboard **Events** tab: filterable live tail of the events table, 5-second polling (no WebSockets)
- Nightly event retention loop (purges events older than 90 days)
- `node:test` infrastructure (`npm test`) with 41 passing tests across the new modules

### Philosophy
This release is scoped exclusively to the Eye. There is no brain (pattern detection comes in v0.4.0), no hands (proposals/skills come in v0.5.0+). The Eye exists to see — nothing more.

## [0.2.0] — 2026-04

The "brain + channels" milestone. SEAL grew a memory layer, token compression, a flow engine, safety primitives, and a web dashboard — plus Discord, Telegram, and Gmail IMAP ingestion.

### Added
- MemPalace memory layer with automatic prefetch/sync
- RTK (Rust Token Killer) integration for 60–90% token compression
- Flow engine with YAML adapters and memory-only classification
- Sandbox profiles and capability policies with audit log
- `pr-watcher` and `azure-pr-review` sensors (git worktree isolation)
- Discord channel, Telegram bot ingestion, Gmail IMAP polling
- Web dashboard (port 3457) with task lists and config editor
- Launchd plist template for opt-in auto-start service
- OpenClaw-style lifecycle replies across every channel

### Fixed
- Recurring task execution pipeline
- Sandbox allowlist for Homebrew Cellar and Claude runtime writes
- Cron recurrence parsed in local timezone
- Telegram token resolution from env var and `.secrets` file
