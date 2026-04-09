# SEAL

**Discipline. Execution. No excuses.**

Your second brain for tech leadership — an autonomous agent that captures, orchestrates, executes, remembers, and learns.

> **You think, SEAL does. You forget, SEAL remembers. You sleep, SEAL works.**

SEAL is not a todo list. It's an autonomous agent built on AI coding CLIs that acts as your operational brain — capturing bugs from team chats, creating tasks in your issue tracker, reviewing PRs autonomously, managing context across sessions, and learning from every interaction.

```bash
# Paste a team chat with a bug report:
/seal "People, a column visibility persistence broke in the order screen..."
# → Extracts bug details, creates Azure DevOps task, assigns to the right dev

# Automated PR review with re-review loop:
# SEAL watches PRs, reviews, votes, watches for new commits, re-reviews
seal-run  # starts the autonomous runner

# Memory — just throw things at it:
/seal evaluate eCharts vs fl_chart for unified chart visuals
/seal decision: we chose Riverpod over Bloc for state management
/seal person: João is on vacation April 7-14
```

## Core pillars

### 1. Capture — understand any input
Paste a Slack thread, describe a bug, mention an idea — SEAL classifies it and routes to the right action. Bug report? Creates a task in Azure DevOps. Idea? Stores as memory. Automation? Schedules execution.

### 2. Orchestrate — flow engine with pluggable adapters
YAML-defined workflows (inspired by [OpenClaw](https://github.com/openclaw/openclaw)'s Lobster) with platform-agnostic adapters. The same PR review flow works on Azure DevOps, GitHub, or GitLab — just swap the adapter.

```yaml
# flows/code-review.yaml
steps:
  - discover → find open PRs
  - review → run /smart-review
  - decide → approve or request changes
  - watch → monitor for new commits
  - re-review → delta review against previous findings
  - notify → alert the dev
```

### 3. Execute — autonomous parallel sessions
Spawns `claude -p` sessions with scoped permissions. Up to 4 concurrent tasks. Smart scheduling with cron, one-time, or loop-until-done patterns.

### 4. Remember — persistent cross-session memory
Integrated with [MemPalace](https://github.com/milla-jovovich/mempalace) for verbatim storage with vector search. 96.6% recall on LongMemEval. Every conversation, decision, and context is stored and findable — not summarized away.

### 5. Learn — self-improving skills
Inspired by [Hermes Agent](https://github.com/NousResearch/hermes-agent)'s self-improving loop. After completing complex tasks, SEAL refines its skills. Memory prefetch/sync on every turn. User modeling that builds understanding over time.

### 6. Optimize — token-aware execution
Native [RTK](https://github.com/rtk-ai/rtk) integration compresses CLI output by 60-90% before it hits the LLM context. Sessions last 3x longer. Lower costs. Better reasoning from less noise.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    SEAL Agent                        │
│                                                      │
│  ┌────────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │  MemPalace │  │   RTK    │  │   Flow Engine    │ │
│  │  (memory)  │  │ (tokens) │  │   (workflows)    │ │
│  └─────┬──────┘  └────┬─────┘  └────────┬─────────┘ │
│        │               │                 │           │
│  verbatim store   compress CLI    YAML pipelines     │
│  vector recall    89% savings    step orchestration   │
│  170 tokens       3x sessions    conditional logic    │
│        │               │                 │           │
│  ┌─────┴───────────────┴─────────────────┴─────────┐ │
│  │              Adapters (pluggable)                 │ │
│  │  Azure DevOps · GitHub · GitLab · Bitbucket      │ │
│  └──────────────────────┬───────────────────────────┘ │
│                         │                             │
│  ┌──────────────────────┴───────────────────────────┐ │
│  │           SEAL Runner (always-on daemon)          │ │
│  │  SQLite/Turso · Cron · Policy · Sandbox · Notify │ │
│  └──────────────────────────────────────────────────┘ │
│                         │                             │
│  ┌──────────────────────┴───────────────────────────┐ │
│  │              Communication Channels               │ │
│  │  Telegram · WhatsApp · Discord · Email · Voice   │ │
│  └──────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

## Skill orchestration

SEAL knows your project's skills. When it detects a bug report, it calls `/smart-create-task-azure`. When it finds an open PR, it calls `/smart-review`. It's your brain routing to the right tool.

| Input pattern | SEAL action |
|--------------|-------------|
| Bug report / chat paste | Save note + create Azure DevOps task |
| "review PR #123" | Run `/smart-review` with flow engine |
| "avaliar eCharts" | Save as memory-only note |
| "run tests every morning" | Schedule executable task |
| "remind me 1:1 with Ana" | Schedule recurring notification |

## PR review flow

The crown jewel. SEAL reviews PRs autonomously with a re-review loop:

1. **Discover** — finds open PRs you haven't reviewed
2. **Review** — runs your review skill (smart-review, flutter-review, etc.)
3. **Decide** — no blockers? Approve. Blockers? Request changes.
4. **Comment** — posts findings as inline thread comments
5. **Watch** — monitors PR for new commits (polls every 5 min)
6. **Re-review** — when dev pushes, re-analyzes with delta context
7. **Resolve** — if previous findings are fixed, resolves threads and approves
8. **Notify** — alerts the dev at every step

Same flow works on Azure DevOps, GitHub, and GitLab — just change the adapter.

## Notification levels

| Level | What happens | Can be ignored? |
|-------|-------------|-----------------|
| `silent` | Logs to SQLite only | Yes |
| `sound` | macOS notification + sound | Yes |
| `sticky` | Persistent notification + terminal bell | Harder |
| `nuclear` | Alert dialog + voice announcement | Blocks until clicked |
| `supernova` | Nuclear, but re-fires every 5 minutes until acknowledged | **No** |

## Task types

| Type | Description | Auto-executes? |
|------|-------------|----------------|
| `task` | Something Claude should do (with prompt) | Yes — via `claude -p` |
| `note` | Memory-only — idea, evaluation, context | No — stored for reference |
| `reminder` | Something you need to remember | No — fires notification |
| `ritual` | Recurring task or reminder | Yes — recalculates next run |
| `deadline` | Project deadline or freeze | No — fires notification |
| `person` | Info about a team member | No — searchable context |
| `decision` | Architectural or team decision | No — searchable context |

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ulisseshen/seal/main/install.sh | bash
```

## Requirements

- **Node.js** 18+
- **An AI coding CLI** — Claude Code, Codex, Antigravity, or Cursor
- **Claude Max plan** recommended for parallel execution
- **macOS** for full notification support (Linux: degraded notifications)
- **sqlite3** CLI
- Optional: **RTK** (`brew install rtk-ai/tap/rtk`) for token optimization
- Optional: **MemPalace** for persistent memory
- Optional: **ffmpeg** + **whisper-cli** for voice transcription

## Communication channels

| Channel | How it works |
|---------|-------------|
| **Telegram** | Bot via @BotFather |
| **WhatsApp** | Baileys (WhatsApp Web) |
| **Discord** | Bot via Developer Portal |
| **Email** | Gmail IMAP or Cloudflare Worker |
| **Voice notes** | Auto-transcribed via whisper-cli |
| **Claude Code** | `/seal` skill |

## Supported runtimes

| Runtime | Status |
|---------|--------|
| Claude Code | Supported |
| Codex | Supported |
| Antigravity | Supported |
| Cursor | Supported |

## Standing on the shoulders of

- **[OpenClaw](https://github.com/openclaw/openclaw)** — Flow engine (Lobster) and adapter architecture
- **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** — Self-improving skills, memory prefetch/sync, user modeling
- **[MemPalace](https://github.com/milla-jovovich/mempalace)** — Verbatim memory with vector search (96.6% recall)
- **[RTK](https://github.com/rtk-ai/rtk)** — Token compression for CLI output (60-90% reduction)
- **[Extreme Ownership](https://echelonfront.com/extreme-ownership/)** — The leadership philosophy behind the name

> *"There are no bad teams, only bad leaders."* — Jocko Willink

## License

MIT
