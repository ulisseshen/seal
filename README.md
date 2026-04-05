# SEAL

**Discipline. Execution. No excuses.**

An autonomous task runner for Tech Leads, Engineering Managers, and management teams — built on [Claude Code](https://claude.ai/code).

SEAL helps you manage your daily leadership routine: schedule code reviews, track team deadlines, automate recurring checks, and never miss a critical reminder. Save tasks from any Claude Code session — SEAL structures them, schedules execution via `claude -p`, runs them in parallel, and notifies you with alerts you can't ignore.

```bash
# In any Claude Code session:

# Team management
/seal remind me to review João's PR by Friday
/seal MUST prepare sprint retro notes by Thursday 3pm
/seal decision: we chose Riverpod over Bloc for state management

# Automated checks
/seal run tests on all Flutter projects every morning at 8am
/seal check CI status every 30 minutes until it passes
/seal run dart analyze on mobile-app after every deploy freeze

# Daily leadership
/seal remind me 1:1 with Ana every Tuesday at 10am
/seal track: deploy freeze starts April 10
/seal list
```

## What SEAL does

- **Leadership memory** — Save decisions, team context, deadlines, and recurring rituals. Search them anytime.
- **Autonomous execution** — Spawns `claude -p` sessions with auto-generated meta-prompts and scoped tool permissions
- **Parallel** — Up to 4 concurrent Claude sessions (Max plan), leaving 1 slot for your interactive session
- **Smart scheduling** — One-time, recurring (cron), or loop-until-done tasks with date awareness
- **Unignorable reminders** — 5 notification levels from silent to supernova (re-fires every 5 minutes until acknowledged)
- **Team-aware** — Track people, projects, deadlines, and decisions across your entire portfolio
- **Claude Code skill** — `/seal` slash command auto-detects project, tools, schedule, and priority from natural language

## Notification levels

| Level | What happens | Can be ignored? |
|-------|-------------|-----------------|
| `silent` | Logs to SQLite only | Yes |
| `sound` | macOS notification + sound | Yes |
| `sticky` | Persistent notification + terminal bell | Harder |
| `nuclear` | Alert dialog + voice announcement | Blocks until clicked |
| `supernova` | Nuclear, but re-fires every 5 minutes until acknowledged | **No** |

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ulisseshen/seal/main/install.sh | bash
```

Or manually:

```bash
git clone https://github.com/ulisseshen/seal.git ~/projects/seal
cd ~/projects/seal && npm install

# Install the Claude Code skill
mkdir -p ~/.claude/skills/seal
cp skill/SKILL.md ~/.claude/skills/seal/SKILL.md

# Add aliases to your shell
echo '
# SEAL — Autonomous Tech Lead Task Runner
alias seal="cd ~/projects/seal"
alias seal-run="cd ~/projects/seal && node src/runner.js"
alias cds="claude --dangerously-skip-permissions"
' >> ~/.zshrc

source ~/.zshrc
```

## Usage

### Save tasks and reminders

```bash
# Automated code tasks
/seal run dart analyze on print_widget              # one-time, runs immediately
/seal run tests on valenty tomorrow at 9am          # scheduled
/seal run lint fix on mage every Monday at 8am      # recurring (cron)
/seal check CI every 30 minutes until it passes     # loop until done

# Leadership reminders
/seal remind me 1:1 with Ana every Tuesday at 10am  # recurring ritual
/seal remind me to deploy by Friday                 # nuclear notification
/seal MUST review security audit by Wednesday       # supernova — cannot be ignored

# Team knowledge
/seal decision: moved to monorepo, approved by CTO  # searchable decision log
/seal person: João is on vacation April 7-14        # team context
/seal deadline: Q2 OKR review on April 30           # deadline tracking
```

### Manage tasks

```bash
/seal list                    # show active tasks
/seal search João             # search by person, project, or keyword
/seal done João PR review     # mark as complete
/seal ack deploy reminder     # acknowledge a firing supernova
/seal history                 # show completed tasks
```

### Start the runner

```bash
# In a separate terminal:
seal-run

# Or run in background:
nohup node ~/projects/seal/src/runner.js > /tmp/seal.log 2>&1 &
```

### Run Claude autonomously

```bash
# Start Claude with full autonomous permissions (any directory):
cds
```

## How it works

```
You (Claude Code):
  /seal "run tests on valenty tomorrow at 9am"
      │
      ▼
  Claude structures it:
    type: task
    summary: "Run tests on valenty"
    execute_at: 2026-04-05T09:00:00
    prompt: "Run all Flutter tests and report results"
    project: ~/projects/valenty
    allowed_tools: ["Bash","Read","Glob","Grep"]
    permission_mode: auto
      │
      ▼
  Saved to SQLite (~/.config/seal/tasks.db)
      │
      ▼
SEAL Runner (polling every 30s):
  Is it time? → Yes
  Slots available? → Yes (4 max, 1 running)
      │
      ▼
  claude -p "Run all Flutter tests..." \
    --project ~/projects/valenty \
    --permission-mode auto \
    --allowedTools Bash,Read,Glob,Grep
      │
      ▼
  Result saved to SQLite
  Notification sent (if high priority)
```

## Architecture

```
~/projects/seal/
├── src/
│   ├── runner.js       # Main polling loop (tasks + reminders + supernova)
│   ├── executor.js     # Spawns claude -p with meta-prompts, parallel execution
│   ├── db.js           # SQLite schema, queries, task management
│   └── notify.js       # 5-level notification system (silent → supernova)
├── skill/
│   └── SKILL.md        # Claude Code / Codex / Antigravity skill
├── skills/
│   └── cursor/
│       └── seal.mdc    # Cursor rule
├── install.sh          # One-line installer (auto-detects runtimes)
└── package.json

~/.config/seal/
└── tasks.db            # SQLite database (auto-created on first run)

# Skills installed per runtime (by install.sh):
~/.claude/skills/seal/SKILL.md                    # Claude Code
~/.agents/skills/seal/SKILL.md                    # Codex
~/.gemini/antigravity/skills/seal/SKILL.md        # Antigravity
~/.cursor/rules/seal.mdc                          # Cursor
```

## Supported runtimes

| Runtime | Skill location | Status |
|---------|---------------|--------|
| Claude Code | `~/.claude/skills/seal/SKILL.md` | Supported |
| Codex | `~/.agents/skills/seal/SKILL.md` | Supported |
| Antigravity | `~/.gemini/antigravity/skills/seal/SKILL.md` | Supported |
| Cursor | `~/.cursor/rules/seal.mdc` | Supported |

The install script auto-detects which runtimes you have and installs the skill for each one.

## Requirements

- **Node.js** 18+
- **An AI coding CLI** — Claude Code, Codex, Antigravity, or Cursor (at least one)
- **Claude Max plan** recommended for parallel execution (4 concurrent sessions)
- **macOS** for full notification support (Linux: notifications degrade to terminal bell)
- **sqlite3** CLI for the `/seal` skill to read/write the task database

### For persistent reminders (supernova)

The SEAL runner daemon must be running in a background terminal for persistent reminders to fire. Without it, tasks are saved but won't execute or notify.

```bash
# Start the runner (keep this terminal open):
seal-run

# Or run as a background process:
nohup node ~/projects/seal/src/runner.js > /tmp/seal.log 2>&1 &

# Or set up as a launchd service (macOS):
# See docs/launchd.md (coming soon)
```

### For task execution

SEAL spawns `claude -p` to execute tasks autonomously. This requires:
- The **Claude Code CLI** installed and authenticated (`claude --version`)
- Your configured **MCP servers**, **skills**, and **tools** work as-is — SEAL runs on your machine, so everything Claude Code can access, SEAL can access
- `--permission-mode auto` is used by default — Claude's safety classifier evaluates each action before executing

## Task types

| Type | Description | Auto-executes? |
|------|-------------|----------------|
| `task` | Something Claude should do | Yes — via `claude -p` |
| `reminder` | Something you need to remember | No — fires notification |
| `ritual` | Recurring task or reminder | Yes — recalculates next run |
| `deadline` | Project deadline or freeze | No — fires notification |
| `person` | Info about a team member | No — searchable context |
| `decision` | Architectural or team decision | No — searchable context |

## Safety

- Tasks use `--permission-mode auto` by default — Claude's safety classifier evaluates each action
- Client projects can be forced to read-only tools
- Each task gets scoped `--allowedTools` based on what it needs
- Results capped at 50KB per task
- 30-minute timeout per task execution
- Max 4 concurrent sessions (configurable)

## Who is SEAL for?

- **Tech Leads** juggling multiple projects, PRs, and team members
- **Engineering Managers** tracking deadlines, decisions, and 1:1s
- **Senior Engineers** running automated checks across repos
- **Anyone** who manages a team and codes — and needs both to work without dropping balls

## Inspired by

The name SEAL comes from the Navy SEALs leadership philosophy — discipline, ownership, and relentless execution. Inspired by [Extreme Ownership](https://echelonfront.com/extreme-ownership/) by Jocko Willink and Leif Babin.

> *"There are no bad teams, only bad leaders."* — Jocko Willink

## License

MIT
