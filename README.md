# SEAL

**Discipline. Execution. No excuses.**

> **Shadow. Eye. Brain. Hands.**
> *It acts like me, but it is not me.*

SEAL is an autonomous Tech-Lead assistant. It watches your git activity, notices the patterns you repeat, drafts safe automations, asks you once, and then handles every future similar thing on its own. It also routes unknown data — an email, a message, a chat line — into a *"I don't recognize this, teach me"* loop that turns into a reusable handler after a single conversation.

```bash
seal start              # runner + dashboard in the background
seal open               # http://localhost:3333
# That's it. Use your machine. SEAL watches and proposes.
```

## The four parts

| Part | What it is | What it does |
|------|------------|--------------|
| 👤 **Shadow** | The identity | Follows you silently. Mirrors your shape. Never acts without your nod. |
| 👁️ **Eye** | Observers | Sees what you do (git hooks, shell, file events) and what arrives for you (email, chat, calendar). |
| 🧠 **Brain** | Detector + LLM | Notices patterns. Interprets inputs. Drafts plans. **Never decides alone.** |
| 🖐️ **Hands** | Skill Factory + Flow Engine | Runs the automations you approved. Sandboxed. Every run is traceable to an approval. |

The ethical rule — *"it acts like me, but it is not me"* — is what separates SEAL from every other agent framework. SEAL learns, drafts, and executes on your behalf, but every output is labeled, every action traces back to an explicit approval, and nothing irreversible happens without you clicking a button once.

## The two loops

### Observe — "SEAL notices what I do"

```
 git hooks → events → patterns → proposals → [approve once] → skill → future auto-runs
```

- **v0.3.0 "SEAL sees"** — passive observation. Git hooks installed per repo, events persisted 90 days, no inference.
- **v0.4.0 "SEAL notices"** — sequence detector (`A → B within 10m`) and naming detector (branch/tag regex library).
- **v0.5.0 "SEAL proposes"** — LLM drafts a shell/flow automation for patterns past the confidence threshold. Five decisions: approve + save / approve once / modify / deny / suppress. Max 3 per day. 7-day TTL.
- **v0.6.0 "SEAL remembers"** — approved proposals become persistent skills under `~/.config/seal/skills/<name>/`. Invoke from CLI, dashboard, or chat.
- **v0.7.0 "SEAL follows steps"** — skills can be declarative YAML flows instead of shell scripts. Step types: `llm.ask`, `shell.run`, `ask_user.prompt`, `set.<key>`.

### Ingest — "SEAL asks what to do with this"

```
 email/chat/event → handler match? → yes: run. no: LLM interprets → TL teaches once → handler born
```

- **v0.10.0 "SEAL asks back"** — data arriving at SEAL that no handler matches is parked in an `ingest_queue`. The LLM drafts a complete handler proposal (match criteria + `flow.yaml`). You approve once, the handler skill is born, and every future similar event runs through it automatically.

Both loops go through the same **Brain → Permission Gate → Hands** pipeline. The Permission Gate is a human clicking a button. Once. No escalation ladder.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ulisseshen/seal/main/install.sh | bash
```

The installer:

- Clones the repo to `~/projects/seal` (or `$SEAL_INSTALL_DIR`)
- Runs `npm install`
- Installs [RTK](https://github.com/rtk-ai/rtk) (token compression) via brew or curl
- Installs [MemPalace](https://github.com/milla-jovovich/mempalace) optionally (native SQLite FTS5 memory layer is the default)
- Copies the `/seal` skill into Claude Code, Codex, Antigravity, and Cursor runtimes it detects
- **Symlinks `seal` into `/usr/local/bin` (or `~/.local/bin`)** — a real binary, not a shell alias
- Scrubs any prior SEAL shell aliases from your `.zshrc` / `.bashrc`

## Quickstart

```bash
# 1. Configure a chat provider (interactive menu, or use flags)
seal setup                              # interactive
seal setup provider gemini --token X    # token-based
seal setup provider codex --login       # delegates to codex login
seal setup status                       # summary

# 2. Start the services in the background
seal start                              # runner + dashboard
seal ps                                 # verify both are running
seal open                               # http://localhost:3333

# 3. Give the Eye something to watch
#    → Dashboard → Workspaces tab → "Add workspace" → pick a git folder
#    (installs git hooks so commits/branches/tags flow into the events table)

# 4. Poke the ingest loop without waiting for real events
#    → Dashboard → Ingest tab → "drop test data" form
```

SEAL is now watching. As you work, the detector builds up patterns. Every ~15 minutes the proposer looks at what's ready, drafts up to 3 proposals per day, and drops them in the **Proposals** tab with approve / deny / modify buttons. Approved proposals become skills you can invoke from `seal run <name>`.

## CLI command surface

```
Daemon
  seal start [runner|dashboard]       start background services (default: both)
  seal stop  [runner|dashboard]       stop background services
  seal restart [runner|dashboard]     stop + start
  seal ps                             show running services + PIDs
  seal logs [runner|dashboard] [-f]   tail service logs
  seal open                           open the dashboard in the browser

Setup
  seal setup                          interactive menu
  seal setup status                   show configured providers/channels
  seal setup provider <name>          interactive token / select default
  seal setup provider <name> --token X [--model Y]
  seal setup provider codex --login   delegate to `codex login`
  seal setup provider <name> --remove
  seal setup channel <name> --set key=value

Skills
  seal skills                         list installed skills
  seal run <name> [args...]           invoke a skill
```

## Chat providers

SEAL supports five LLM backends behind a single interface — chat, proposal drafting, and ingest teaching all use the same abstraction:

| Provider | Auth | Notes |
|----------|------|-------|
| **Claude** | `claude /login` | Delegates to the Claude Code CLI. Default model: `claude-opus-4-6`. |
| **Codex** | `seal setup provider codex --login` | Delegates to the `codex login` CLI. Default: `gpt-5`. |
| **Gemini** | `seal setup provider gemini --token <key>` | HTTP SSE against the Google Generative Language API. Default: `gemini-2.5-pro`. 1M context is the natural fit for the Brain's watcher role. |
| **OpenAI** | `seal setup provider openai --token <sk-...>` | HTTP SSE against `/v1/chat/completions`. Default: `gpt-4.1-mini`. |
| **Ollama** | `seal setup provider ollama --host http://...` | Local NDJSON stream. No credentials. Default: `llama3.1`. |

API keys live in the **macOS Keychain** (service `seal`) or a `chmod 600` fallback at `~/.config/seal/secrets.json`. They are never written into `chat-config.json` or any world-readable file.

## Dashboard

`seal open` launches the dashboard at `http://localhost:3333`. Tabs:

- **Missions** — the existing task queue (tasks, reminders, rituals, deadlines, decisions, people).
- **Channels** — notification targets (Telegram, Discord, Slack, system).
- **Chat** — live streaming chat against any configured provider. Markdown rendering, SQLite persistence, provider switcher.
- **Logs** — execution log of every task run.
- **Calendar** — 7-day view of scheduled tasks.
- **Workspaces** — git repos SEAL is watching. Native folder picker, one-click hook install.
- **Events** — live read-only tail of the events table (git commits, branches, tags, merges, pushes).
- **Patterns** — detected sequence + naming patterns with confidence scores. "Scan now" button.
- **Proposals** — LLM-drafted automations awaiting your approval. Five decision buttons.
- **Skills** — installed library. Per-skill run form, run history, counters.
- **Ingest** — unknown data queue, LLM interpretation, drafted handler, approve-to-create.

## Storage layout

```
~/.config/seal/
  tasks.db           SQLite (tasks, events, patterns, proposals, decisions,
                     skills, handler_matchers, ingest_queue, memories, chat_messages)
  secrets.json       fallback secret store (macOS uses Keychain instead)
  chat-config.json   {provider, model, system_prompt}
  channels.json      notification channel config
  ingest.json        inbound channel config (telegram/whatsapp/discord/gmail)
  run/               PID files for running daemons
  logs/              daemon log files
  skills/<name>/     installed skills
    ├── skill.json
    ├── script.sh      or flow.yaml
    ├── README.md
    └── runs.jsonl
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          SEAL (seal binary)                      │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ Observers│  │   Brain  │  │ Skill Factory│  │  Dashboard  │ │
│  │  (Eye)   │─▶│ Detector │─▶│  + Flow Eng. │◀─┤ + REST API  │ │
│  │          │  │ Proposer │  │    (Hands)   │  │             │ │
│  │ git.js   │  │ Ingest   │  │              │  │ Express     │ │
│  │ + hooks  │  │          │  │              │  │             │ │
│  └────┬─────┘  └─────┬────┘  └──────┬───────┘  └──────┬──────┘ │
│       │              │              │                  │        │
│       └──────────────┴──────────────┴──────────────────┘        │
│                            │                                     │
│  ┌─────────────────────────┴───────────────────────────────┐    │
│  │                    SQLite (tasks.db)                    │    │
│  │  events · patterns · proposals · decisions · skills     │    │
│  │  handler_matchers · ingest_queue · memories (FTS5)      │    │
│  │  chat_messages (FTS5) · watched_repos · tasks           │    │
│  └─────────────────────────────────────────────────────────┘    │
│                            │                                     │
│  ┌─────────────────────────┴───────────────────────────────┐    │
│  │              Provider Abstraction (unified stream API)  │    │
│  │   Claude · Codex · Gemini · OpenAI · Ollama             │    │
│  └──────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

## Requirements

- **Node.js** 18+
- **An AI coding CLI** (optional) — Claude Code, Codex, Antigravity, or Cursor — if you want `/seal` skill invocation from inside an assistant
- **macOS** for full notification + Keychain support (Linux: degraded notifications, file-based secret fallback)
- **`sqlite3`** CLI — only needed by the legacy `/seal` skill; the daemon uses `better-sqlite3` natively
- Optional: **RTK** for token compression on task execution
- Optional: **`ffmpeg` + `whisper-cli`** for voice-note transcription

## Memory layer

SEAL's Brain pulls context before every task using a three-layer recall:

- **Pinned memories** — typed (`user` / `feedback` / `project` / `reference`) from Claude Code's frontmatter pattern, always loaded for the task's project
- **FTS5 memory search** — top-5 semantic-ish matches over the `memories` table, porter-stemmed
- **FTS5 chat recall** — top-3 matches over the persistent chat history

The sync side writes task outcomes into `memory_scratch` as daily ephemeral notes. A future dreaming sweep consolidates recurring scratch into durable memories — the OpenClaw pattern.

## Task types (v0.2.0, still supported)

| Type | Description | Auto-executes? |
|------|-------------|----------------|
| `task` | Something Claude should do (with prompt) | Yes — via `claude -p` |
| `note` | Memory-only — idea, evaluation, context | No — stored for reference |
| `reminder` | Something you need to remember | No — fires notification |
| `ritual` | Recurring task or reminder | Yes — recalculates next run |
| `deadline` | Project deadline or freeze | No — fires notification |
| `person` | Info about a team member | No — searchable context |
| `decision` | Architectural or team decision | No — searchable context |

## Notification levels

| Level | What happens | Can be ignored? |
|-------|-------------|-----------------|
| `silent` | Logs to SQLite only | Yes |
| `sound` | macOS notification + sound | Yes |
| `sticky` | Persistent notification + terminal bell | Harder |
| `nuclear` | Alert dialog + voice announcement | Blocks until clicked |
| `supernova` | Nuclear, but re-fires every 5 minutes until acknowledged | **No** |

## Standing on the shoulders of

- **[Claude Code](https://code.claude.com)** — typed-frontmatter memory pattern (user / feedback / project / reference)
- **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** — prefetch-before-turn / sync-after-turn memory lifecycle, capacity-forced consolidation
- **[OpenClaw](https://github.com/openclaw/openclaw)** — daily-notes → durable promotion ("dreaming sweep")
- **[MemPalace](https://github.com/milla-jovovich/mempalace)** — verbatim memory with vector search (SEAL's native FTS5 layer replaces the Python subprocess)
- **[RTK](https://github.com/rtk-ai/rtk)** — token compression for CLI output
- **[Extreme Ownership](https://echelonfront.com/extreme-ownership/)** — the leadership philosophy behind the name

> *"There are no bad teams, only bad leaders."* — Jocko Willink

## Supported runtimes

| Runtime | Status |
|---------|--------|
| Claude Code | Supported |
| Codex | Supported |
| Antigravity | Supported |
| Cursor | Supported |

## License

MIT
