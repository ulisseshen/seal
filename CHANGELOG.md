# Changelog

All notable changes to SEAL are documented in this file.

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
