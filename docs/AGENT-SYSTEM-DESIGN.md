# SEAL — The Tech Lead's Shadow

> **Design doc status**: Rev 2.4 (Dialogue Router added — 2026-04-10)
> **Product soul**: *Shadow. Eye. Brain. Hands. It acts like me, but it is not me.*
> **Operating mantra**: *Ask carefully once → act confidently forever.*
> **Dialogue principle**: *Gateways are the substrate where every decision happens — not just where data arrives.*
> **Current SEAL version**: v0.2.0
> **Target versions covered**: v0.3.0 → v1.0.0
> **Author**: Architecture session (Claude + Ulisses)
> **Scope**: Evolution from task runner to a consent-first, symmetric-learning assistant (observe + ingest loops)
> **Previous design doc rev**: `AGENT-SYSTEM-DESIGN-v1-archive.md` (shelved — too complex)
> **Rev 2.1 changes**: Added Flow Engine as first-class skill backend (§3.8), Ingest Loop with conversational learning (§3.9), Walkthroughs 6-8, LLM provider config, new v0.7.0 and v0.10.0 releases

> **Note on versioning**: This document describes *design revisions* (Rev 1, Rev 2) which are separate from SEAL's product versions (v0.1.0, v0.2.0, ...). Implementation phases in §7 map to semver releases starting from the current v0.2.0.

---

## The Soul

> **Shadow. Eye. Brain. Hands.**
> **It acts like me, but it is not me.**

SEAL is four parts bound by a single ethical rule:

| Part | What it is | What it does |
|------|------------|--------------|
| 👤 **Shadow** | The identity | Follows the TL silently. Mirrors his shape. Never goes where he wouldn't go. |
| 👁️ **Eye** | Observers + Gateways | Sees what the TL does (git, shell, files). Sees what arrives for him (email, calendar, chat). |
| 🧠 **Brain** | Pattern Detector + LLM | Interprets what the eye sees. Detects patterns. Frames questions. Drafts proposals. **Never decides alone.** |
| 🖐️ **Hands** | Skill Factory + Flow Engine + Executor | The only part that touches the real world. Every action passes through the Permission Gate. |

**The ethical rule** — *"it acts like me, but it is not me"* — is what separates SEAL from every other agent framework:

- SEAL **learns** the TL's patterns ✅ (that's the whole point)
- SEAL **drafts** in his voice ✅ (emails, commit messages, PR reviews)
- SEAL **executes** actions he approved ✅ (via sandboxed skills)
- SEAL **never impersonates** him ❌ (every output is clearly labeled as SEAL)
- Every action is traceable to an approval ✅ (the decisions table is the audit log)
- SEAL is a **reflection**, not a **replacement** ✅

### The mantra, expanded

- **Shadow** exists because SEAL has no independent will. It follows. When the TL turns off, the shadow disappears.
- **Eye** exists because the TL can't be everywhere. SEAL sees the email that arrived at 3am, the commit made on another machine, the meeting that crept onto the calendar.
- **Brain** exists because raw seeing is noise. The brain notices patterns, drafts scripts, interprets ambiguous inputs — *but only to frame a question, never to force an answer.*
- **Hands** exist because knowledge without action is useless. But hands are the most dangerous part, so they're locked behind the Permission Gate. The hands only move when the TL nods.

### The two loops, restated

- **Observe loop** = Eye (watching) → Brain (noticing patterns) → Brain (drafting proposals) → *TL nods* → Hands (skill runs)
- **Ingest loop** = Eye (receiving data) → Brain (interpreting) → Brain (asking the TL) → *TL teaches* → Hands (handler runs)

Both loops go through the same Brain → Gate → Hands pipeline. The difference is just where the Eye was looking.

That's it. Not an agent swarm. Not a multi-model orchestrator. Not OpenClaw. A **shadow with senses, a mind, and supervised hands.**

---

## Why v1 Was Wrong

v1 tried to turn SEAL into OpenClaw: multi-agent registry, DAG task graphs, generator-based orchestrator loops, streaming WebSockets, 10-layer architecture. Every layer justifiable in isolation, but together they describe a **platform**, not a **tool**.

Nanoclaw's philosophy applies here: *"Small enough to understand. Secure by isolation. Built for the individual user."* SEAL should be the same. A single engineer should be able to read the entire codebase in one afternoon and know exactly what it does.

**v2 deletes 70% of v1.** What remains is the part that actually matches how Ulisses works: a Tech Lead who already has his own rhythm, who doesn't need an AI dictating workflows, who needs **leverage** on the things he repeats every week.

---

## 1. The Vision (Deep)

### 1.1 What a Tech Lead Actually Does All Day

- Reviews PRs from the team (same review patterns over and over)
- Cuts releases (same git tag + push + changelog dance)
- Spins up feature branches (always the same `git checkout -b feature/PROJ-X && git pull && rebase`)
- Answers Telegram/email with the same structured responses
- Prepares for recurring 1:1s (opens same files, reviews same notes)
- Deploys (same script with different env flags)
- Investigates bugs (same grep → read → hypothesize loop)

**None of this is glamorous.** None of it needs an AI "thinking". What it needs is an assistant that **notices** the repetition and offers to take it off the plate — *with explicit permission every time*.

### 1.2 The Consent-First Principle

Every existing agent framework (AutoGPT, BabyAGI, OpenClaw, Devin clones) has the same failure mode: **the AI decides, then acts, then asks forgiveness.** The user's job becomes writing "policies" and "deny rules" to stop the AI from doing dumb things.

SEAL inverts this:

> **SEAL proposes. The Tech Lead disposes.**

- SEAL never executes anything it proposed unless explicitly approved.
- Approval is per-proposal, not per-policy-class.
- The Tech Lead can say "approve + remember" to convert a one-time approval into an auto-approved skill.
- The Tech Lead can say "deny + remember" to suppress the same pattern forever.
- No pattern, no matter how obvious, becomes an action without a human nod.

This is slower than full autonomy. It's also **the only way an AI agent ever gets trusted with production work**.

### 1.3 The Two Loops (symmetric learning)

SEAL has two learning loops that share almost all infrastructure but face opposite directions:

```
┌──────────────────────────────────────────────────────────────┐
│                                                                │
│   OBSERVE LOOP (outbound — "automate what I do")              │
│                                                                │
│    TL acts ──► detect pattern ──► propose ──► APPROVE         │
│       ▲                                          │            │
│       │                                          ▼            │
│       └─────────  learn which skills fit  ◄── SKILL           │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│   INGEST LOOP (inbound — "handle what arrives")               │
│                                                                │
│   data arrives ──► known handler? ─yes─► run ──► done         │
│       │                       │                               │
│       │                       no                              │
│       │                       ▼                               │
│       │              SEAL asks TL                             │
│       │              ("what do I do with this?")              │
│       │                       │                               │
│       │                       ▼                               │
│       │              TL teaches ──► APPROVE                   │
│       │                                │                      │
│       │                                ▼                      │
│       └────────────────────────── HANDLER SKILL               │
│                                                                │
└──────────────────────────────────────────────────────────────┘
```

**Key insight**: both loops end at the same place — a **skill** (script or flow) behind a permission gate. The only difference is what triggered the learning:

| Loop | Trigger | Learns from... | Example |
|------|---------|----------------|---------|
| **Observe** | TL did something | Repetition of actions | "You run `git rebase` 4x/week → automate?" |
| **Ingest** | Data arrived | TL's answer to "what now?" | "New email from client — draft reply? create task? ignore?" |

Both loops share the Permission Gate, the Skill Factory, and the Flow Engine. Both produce durable, reusable skills. Both learn by **asking, not assuming**.

That's the **entire architecture**. Everything else in this doc is implementation detail for these two loops.

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                       INPUT SOURCES                            │
│                                                                │
│  OUTBOUND (what TL does)       INBOUND (what arrives for TL)  │
│  ┌────┐ ┌─────┐ ┌──────┐       ┌──────┐ ┌────────┐ ┌────────┐│
│  │ git│ │shell│ │ file │       │ chat │ │  email │ │calendar││
│  │hook│ │ hist│ │ edit │       │(in)  │ │  (in)  │ │ (event)││
│  └─┬──┘ └──┬──┘ └──┬───┘       └───┬──┘ └────┬───┘ └────┬───┘│
└────┼───────┼───────┼───────────────┼─────────┼──────────┼────┘
     │       │       │               │         │          │
     └───┬───┴───────┘               └─────────┴──────────┘
         │                                     │
   activity events                      data events
         │                                     │
         ▼                                     ▼
┌────────────────────┐              ┌──────────────────────────┐
│ OBSERVE LOOP       │              │ INGEST LOOP              │
│                    │              │                          │
│ 1. Pattern Detector│              │ 1. Handler Router        │
│    (5 types)       │              │    Does a skill match    │
│                    │              │    this incoming data?   │
│ 2. Proposal Engine │              │                          │
│    "I noticed X    │              │ 2a. YES → execute handler│
│     3 times, want  │              │     (with ACK first time)│
│     to automate?"  │              │                          │
│                    │              │ 2b. NO → Conversational  │
│ (LLM drafts script │              │     Query                │
│  from pattern)     │              │     "New email from X    │
│                    │              │      asking Y. What      │
│                    │              │      should I do?"       │
│                    │              │     (LLM interprets data │
│                    │              │      and frames options) │
└──────────┬─────────┘              └──────────────┬───────────┘
           │                                       │
           └──────────────────┬────────────────────┘
                              │
                              ▼
            ┌──────────────────────────────────────┐
            │       PERMISSION GATE                 │
            │   (5 responses — the single UI)      │
            │   ✅ once │ 💾 save │ ✏️ modify      │
            │   ❌ deny once  │  🚫 deny + suppress │
            └──────────────────┬───────────────────┘
                               │
                               ▼
            ┌──────────────────────────────────────┐
            │        SKILL FACTORY                  │
            │                                       │
            │  Two backends:                        │
            │  ┌────────────┐  ┌─────────────────┐ │
            │  │ Script (.sh)│  │ Flow (.yaml)    │ │
            │  │ simple,     │  │ multi-step,     │ │
            │  │ linear      │  │ branches,       │ │
            │  │             │  │ retries         │ │
            │  └─────┬───────┘  └────────┬────────┘ │
            │        └────────┬──────────┘          │
            │                 ▼                     │
            │         ~/.config/seal/skills/        │
            └─────────────────┬────────────────────┘
                              │
                              ▼
            ┌──────────────────────────────────────┐
            │        FLOW ENGINE                    │
            │     (reused from SEAL v0.2.0)        │
            │                                       │
            │  Runs scripts and YAML flows via      │
            │  existing executor + sandbox profiles │
            └──────────────────────────────────────┘
```

**Components**: 2 input surfaces → 2 loops → 1 permission gate → 1 factory → 1 execution engine.

The LLM (Claude or Codex, configurable) is called in two places only:
1. **Proposal drafting** (observe loop): pattern → draft script
2. **Data interpretation** (ingest loop): raw data → structured question + action options

It NEVER decides. It NEVER executes. It only drafts and interprets.

---

## 3. Component Deep-Dives

### 3.1 Observers

An Observer is a tiny Node module that watches one source of activity and emits normalized events. The contract:

```javascript
// src/observers/base.js
export class Observer {
  constructor(name, eventBus) {
    this.name = name;
    this.eventBus = eventBus;
  }

  async start() { /* set up watcher */ }
  async stop()  { /* clean up */ }

  emit(event) {
    this.eventBus.emit('observation', {
      source: this.name,
      timestamp: new Date().toISOString(),
      ...event,
    });
  }
}
```

All events land in a single `events` SQLite table (append-only, rotated after 90 days). This is the **raw material** from which patterns are mined.

#### 3.1.1 GitObserver (the most important one)

This is the one the user specifically asked for — **branch and tag pattern detection**.

**How it watches**:
- Installs a `post-checkout`, `post-commit`, `post-merge` git hook in watched repos (hook just writes an event to a named pipe or SEAL HTTP endpoint)
- Fallback: periodic `git log --all --pretty=format:...` scrape every 5 minutes for repos where hooks aren't installed

**What it emits**:

```javascript
// Branch created
{ kind: 'git.branch.created', repo: 'seal', name: 'feature/PROJ-123-add-login', base: 'main' }

// Tag created
{ kind: 'git.tag.created', repo: 'seal', name: 'v1.2.3', ref: 'abc123' }

// Commit made
{ kind: 'git.commit', repo: 'seal', branch: 'feature/PROJ-123', message: 'add login', files: [...] }

// Push
{ kind: 'git.push', repo: 'seal', branch: 'feature/PROJ-123', remote: 'origin' }

// Sequences detected via hook order
{ kind: 'git.sequence', repo: 'seal', steps: [
    { cmd: 'checkout -b feature/PROJ-123' },
    { cmd: 'pull origin main' },
    { cmd: 'rebase main' },
  ]}
```

**Why hooks over polling**: Hooks give real-time, reliable capture. Polling `git reflog` works as fallback but misses context (did the user run `pull` between commits? the reflog can't tell).

#### 3.1.2 CalendarObserver

- Google Calendar webhook (`watch` channels — push notifications, not polling)
- Emits `calendar.event.upcoming` 30min before meetings
- Emits `calendar.event.recurring.detected` when the same title repeats 3+ times

#### 3.1.3 ChannelObserver

Wraps the existing Telegram/Discord/WhatsApp/Email gateways. Emits:
- `channel.message.received` — incoming message
- `channel.message.sent` — outgoing message from user (this is the key one for reaction patterns: "what does the user reply when asked X?")

#### 3.1.4 ShellObserver (opt-in)

Users can opt in by adding a shell hook to `.zshrc`:

```bash
# SEAL shell observer (opt-in)
seal_shell_hook() {
  local cmd="$1"
  if [[ -n "$cmd" ]]; then
    curl -s -X POST http://localhost:3333/api/observe/shell \
      -d "{\"cmd\": \"$cmd\", \"cwd\": \"$PWD\"}" > /dev/null 2>&1 &
  fi
}
# Hooks into preexec (zsh)
preexec_functions+=(seal_shell_hook)
```

Opt-in because this is *highly personal data*. SEAL stores it locally only, never ships it anywhere.

#### 3.1.5 FileObserver (scoped)

Watches specific directories via `fs.watch` — emits `file.edited`, `file.created`, `file.deleted`. Scoped to watched projects only. Useful for detecting patterns like "always edits `CHANGELOG.md` after `package.json`".

---

### 3.2 Pattern Detector

This is where v2 refuses to over-engineer. **No ML. No embeddings. Just five simple pattern types:**

#### 3.2.1 Pattern Types

**1. Sequence Pattern**
> "Within 10 minutes of event A, event B happens, 80% of the time."

Algorithm:
```javascript
for each event A in events table:
  find all events B within 10min after A, same source
  count how often each (A, B) pair occurs
  compute conditional probability P(B | A)
  if P(B | A) > 0.8 AND count(A) >= 3:
    emit sequence pattern { A, B, confidence, support }
```

Example detection:
- Every `git.branch.created` is followed by `git.commit` within 5 minutes → "you always commit right after branching" (boring, skip)
- Every `git.checkout feature/*` is followed by `git pull origin main` then `git rebase main` → **interesting**, propose automation

**2. Temporal Pattern**
> "Every Monday at 9am, event X happens."

Algorithm:
```javascript
for each recurring event (same 'signature'):
  extract timestamps
  fit to cron patterns: hourly, daily, weekly, biweekly
  if a cron pattern matches 80% of occurrences AND count >= 3:
    emit temporal pattern { event, cron, confidence }
```

Example detections:
- Every Friday 4pm: `git tag v*` → propose release skill
- Every Monday 9am: `open ~/projects/seal` → propose workspace warm-up
- Every day 8am: `calendar.event.upcoming` with "standup" → propose standup prep skill

**3. Naming Pattern**
> "Branch names match `feature/PROJ-\d+-.*`"

Algorithm:
```javascript
for each event with a 'name' field (branches, tags, files):
  extract names from recent history (last 50)
  try to fit regex patterns from a small library:
    - feature/<project>-<number>-<desc>
    - hotfix/<desc>
    - release/<semver>
    - v<semver>
    - release-<date>
  if a regex matches 80% of recent names:
    emit naming pattern { field, regex, examples }
```

Example detections:
- Branches match `feature/SEAL-\d+-.*` → SEAL now knows the team's branch convention
- Tags match `v\d+\.\d+\.\d+` → SEAL now knows the release convention
- These become **context for future proposals** ("Want me to create a branch using your convention?")

**4. Reaction Pattern**
> "When someone sends 'X' in Telegram, you reply with 'Y' shape within 5min."

Algorithm:
```javascript
for each incoming message:
  find the user's reply within 5min (if any)
  group by (incoming shape, reply shape) using simple tf-idf
  if the same shape pair appears 3+ times:
    emit reaction pattern { incoming, reply_template }
```

Example: "When someone asks 'status on the release', you always reply with the same structured update template." → SEAL proposes auto-draft (draft-only, never auto-send).

**5. Usage Pattern**
> "You run this command X times per week across multiple projects."

Algorithm:
```javascript
for each shell command:
  normalize (strip args, keep shape)
  count occurrences per week
  if count > 5 AND span > 2 weeks:
    emit usage pattern { cmd_shape, frequency, projects }
```

#### 3.2.2 Pattern Storage

```sql
CREATE TABLE patterns (
  id TEXT PRIMARY KEY,                    -- hash of signature
  kind TEXT NOT NULL,                     -- sequence|temporal|naming|reaction|usage
  signature TEXT NOT NULL,                -- canonical form for dedup
  evidence_count INTEGER DEFAULT 0,       -- how many times observed
  confidence REAL DEFAULT 0.0,            -- 0.0 - 1.0
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  state TEXT DEFAULT 'observing',
    -- observing | proposed | approved | denied | active | retired
  metadata JSON,                          -- kind-specific data
  proposed_at TEXT,
  skill_id TEXT REFERENCES skills(id)
);

CREATE INDEX idx_patterns_state ON patterns(state);
CREATE INDEX idx_patterns_confidence ON patterns(confidence) WHERE state='observing';
```

#### 3.2.3 Detection Triggers

Pattern detector runs:
- **On every event ingest** (fast path): updates counts, bumps confidence
- **Every 15 minutes** (slow path): runs full scan, finds new patterns
- **On demand** via `/seal patterns` command

A pattern reaches the **propose** state when:
```
confidence >= 0.75 AND evidence_count >= 3 AND state == 'observing'
```

---

### 3.3 Proposal Engine

When a pattern crosses the threshold, the Proposal Engine drafts an automation. This is where the LLM finally shows up — and only here.

#### 3.3.1 The Proposal Prompt

```
You are drafting an automation proposal for a Tech Lead.

PATTERN DETECTED:
Kind: {pattern.kind}
Evidence: {evidence_count} occurrences over {time_span}
Signature: {pattern.signature}
Examples:
{formatted_examples}

TASK:
1. Write a shell script (or node/python if more appropriate) that automates this pattern.
2. The script should be parameterized where it makes sense.
3. Write a one-paragraph plain-language explanation of what it does.
4. Identify any risks (data loss, irreversible actions, network calls).
5. Suggest a short invocation name (for /seal <name>).

CONSTRAINTS:
- The Tech Lead will see your output and must approve it before it runs.
- Prefer safety over cleverness. Echo commands before running them.
- Use existing tools the user already has installed (detected: {installed_tools}).
- Do NOT include auto-commit, auto-push, or any destructive default unless the pattern evidence clearly shows it.

OUTPUT FORMAT:
{
  "name": "new-feature",
  "script": "#!/bin/bash\nset -euo pipefail\n...",
  "explanation": "Creates a new feature branch from main following your PROJ-* convention, rebases onto the latest main, and sets up tracking.",
  "risks": ["Rebases may conflict if local changes exist"],
  "parameters": [{"name": "ticket_id", "example": "SEAL-456"}],
  "invocation": "/seal new-feature SEAL-456",
  "similar_existing_skills": []
}
```

#### 3.3.2 Delivery

The proposal is sent via the user's **preferred channel** (configurable, default Telegram):

```
🔔 SEAL Proposal #42

I've noticed you do this 4 times this week:
  1. git checkout -b feature/PROJ-X
  2. git pull origin main
  3. git rebase main

Want me to turn it into `/seal new-feature <ticket>`?

📜 Script:
---
#!/bin/bash
set -euo pipefail
TICKET="${1:?Usage: new-feature <ticket>}"
git checkout -b "feature/$TICKET"
git pull origin main
git rebase main
echo "✅ Branch feature/$TICKET ready"
---

⚠️  Risks: rebase may conflict if local changes exist.

[✅ Approve once]  [💾 Approve + save]  [✏️ Modify]  [❌ Deny]  [🚫 Deny + suppress]
```

The buttons are clickable on Telegram (inline keyboard), Discord (buttons), and the dashboard. For WhatsApp (no buttons), the user replies with a keyword (`/seal approve 42`).

---

### 3.4 Permission Gate (the soul)

This is the component that makes SEAL different from every other agent framework.

#### 3.4.1 The Five Responses (plan-based approval)

**The core rule**: approving a plan approves **every future run of that plan**. SEAL never re-asks for plans that have been approved. The single approval moment is where all the trust gets paid — everything after is automatic execution.

| Response | Effect |
|----------|--------|
| ✅ **Approve plan** (default) | Plan becomes a skill. Runs now AND automatically on every future match. No re-asking. |
| ✏️ **Modify then approve** | User edits the plan before approving. Edited version saved + runs forever. |
| 🔁 **Approve once only** | Plan runs now but is NOT saved. Use when the situation is genuinely one-off. |
| ❌ **Deny once** | Plan doesn't run. Pattern returns to observing state. SEAL may propose again later. |
| 🚫 **Deny + suppress** | Pattern marked `denied` forever. SEAL will never propose this shape of plan again. |

**Why no escalation ladder**: An earlier draft had a 3-step ladder (first 3 runs ask, then auto). That's wrong. A real human assistant gets taught *once* — *"handle invoices from this vendor by filing them in folder X"* — and then just does it. Repeated asking isn't safety, it's annoyance. Safety comes from **what's inside the plan**, not from how many times it's re-approved.

**Safeguards belong IN the plan, not AROUND it**:
- Plan for outbound email → must use `save_as_draft`, never `send` (enforced at plan-drafting time)
- Plan for destructive actions → must include explicit rollback or confirmation
- Plan for genuinely ambiguous data → must include an `ask_user` step mid-flow

If the TL approves an unsafe plan, that's a plan-review failure, not a permission-gate failure. The Permission Gate does not exist to second-guess the TL — it exists to make sure the TL **saw** the plan before it ran. Once.

#### 3.4.2 What Permission Gate is NOT

- **Not a policy engine.** v1 had capability-based rules (`fs:~/projects:write`). v2 has a human clicking a button. If you find yourself wanting policies, that's a sign the proposals are too noisy — fix the detector, not the gate.
- **Not a delayed decision.** Proposals have a 7-day TTL. If the user hasn't responded, the proposal auto-expires (pattern stays observing, may re-surface later).
- **Not bypassable.** Even emergency "run this NOW" situations go through the gate. The dashboard has a "propose inline" form for user-initiated work, but user-initiated proposals still show the script and still require the click.

#### 3.4.3 Memory of Decisions

Every approval and denial is logged — SEAL learns **your preferences** not just your patterns:

```sql
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  pattern_id TEXT REFERENCES patterns(id),
  decision TEXT,  -- approved_once | approved_saved | modified | denied | suppressed
  original_script TEXT,
  final_script TEXT,  -- different if 'modified'
  decided_at TEXT NOT NULL,
  user_notes TEXT    -- optional, user can explain why
);
```

This becomes training data for the proposal engine: *"Last time I proposed a similar pattern, the user modified it by removing the auto-push step. I should not include auto-push this time."*

---

### 3.5 Skill Factory

Approved scripts become **skills** — named, reusable, invocable, trackable.

#### 3.5.1 Skill Structure

```
~/.config/seal/skills/
├── new-feature/
│   ├── skill.json         # metadata
│   ├── script.sh          # the executable
│   ├── README.md          # generated explanation
│   └── runs.jsonl         # run history (append-only)
├── release/
│   └── ...
└── meeting-prep/
    └── ...
```

**skill.json**:
```json
{
  "name": "new-feature",
  "created_from_pattern": "pat_a3b4c5",
  "created_at": "2026-04-10T14:32:00Z",
  "description": "Create a new feature branch and rebase onto main",
  "invocation": "/seal new-feature <ticket>",
  "parameters": [{"name": "ticket_id", "required": true}],
  "triggers": {
    "manual": true,
    "pattern_match": false,
    "cron": null
  },
  "risks": ["rebase may conflict if local changes exist"],
  "requires_ack": false,
  "sandbox_profile": "project-write",
  "stats": {
    "runs": 0,
    "successes": 0,
    "failures": 0,
    "last_run": null,
    "avg_duration_ms": null
  }
}
```

#### 3.5.2 Skill Lifecycle

- **Created** (first approval)
- **Active** (runs at least once, has successful runs)
- **Dormant** (no runs in 30 days → dashboard suggests retirement)
- **Retired** (user explicitly retires, or 90 days dormant → auto-archived)

Dead skills are retired automatically. No skill rots forever.

#### 3.5.3 Trigger Modes

A skill can be triggered by:
1. **Manual**: `/seal new-feature SEAL-456` in any channel or CLI
2. **Pattern match**: SEAL detected the same starting context again (optional, opt-in per skill)
3. **Cron**: Time-based (e.g., meeting-prep at 8:50am on weekdays)
4. **Channel message**: Message matching a regex triggers the skill

**Once a skill is approved, it runs automatically for every matching trigger — no re-asking.** Triggers can be manual (`/seal <name>`), pattern-based (Observe loop), data-based (Ingest loop), or scheduled (cron). All of them run without additional prompts because the **approval of the plan is the approval of every run**.

The only thing that ever "escalates" is the trigger type — a skill created for manual use can later be upgraded to auto-trigger (pattern or cron), which is **a separate approval of a modified plan**, not a silent capability bump.

```
proposed plan  ─►  TL reviews  ─►  approved  ─►  runs forever for every match
                                     │
                                     └─ denied ─► never proposed in this shape again
```

No ladder, no incremental trust-building, no nagging. **One moment of careful review, unlimited automatic runs afterward.** That's the deal.

---

### 3.6 Gateway Layer (the Dialogue Substrate)

**Important reframing**: gateways are not just data inputs. Because SEAL's entire value depends on *asking the TL* (the Doubt Rule), gateways are the **physical medium where every decision happens**. They're two things at once:

1. **Data ingest surface** — emails, messages, calendar events arrive and become triggers
2. **Dialogue substrate** — SEAL reaches the TL to ask questions, deliver proposals, confirm plans

Without gateways, there is no ingest loop. Without gateways, there is no observe loop. SEAL would be deaf (can't hear what arrives) and mute (can't reach the TL to ask).

This is why gateways are higher-priority than they looked in Rev 2.0 — they are the substrate on which both loops depend. The design must treat the *outbound-to-TL* side of gateways as **first-class**, not an afterthought.

v1 had a 200-line gateway layer section. v2 keeps it simple:

```javascript
// src/gateways/base.js
export class Gateway {
  constructor(name, config) {
    this.name = name;
    this.config = config;
  }
  async start() {}
  async stop() {}
  async send(target, payload) {}
  onEvent(handler) { this.handler = handler; }
}
```

Five gateways to implement:

| Gateway | Direction | Purpose |
|---------|-----------|---------|
| **telegram** | bidirectional | Proposal delivery + user commands (primary UI) |
| **gmail** | bidirectional | Read-and-reply emails (via OAuth) |
| **google-calendar** | bidirectional | Watch events, query freebusy, create events |
| **discord** | bidirectional | Alternate channel for proposals |
| **whatsapp** | bidirectional | Alternate channel (existing Baileys) |

**Credentials**: Single `~/.config/seal/vault.json` (encrypted via `openssl aes-256-cbc` keyed on user's machine ID). OAuth refresh is a simple cron task that runs once an hour and refreshes any expiring tokens.

**No abstract capability schemas. No event normalization layer.** Each gateway emits directly into the event bus with a `source: 'telegram'` tag. The pattern detector is smart enough to handle variations.

**Email specifics** (since this was a user requirement):
- Gmail OAuth (not IMAP) — real-time via Gmail push notifications
- Replies preserve thread ID (Gmail native) and `In-Reply-To` headers
- **Draft-only mode is the default** — SEAL composes responses as Gmail drafts. The user opens Gmail, reviews, and hits send. No surprise outgoing mail. Later, specific senders can be whitelisted for auto-send.

---

---

### 3.6b The Dialogue Router (⭐ NEW in Rev 2.3)

> **Problem**: The TL is not always at the dashboard. He's on a phone, in a meeting, walking, driving, asleep. When SEAL needs to ask something, *where* does it ask, *how urgently*, and *what if there's no answer*?

The Dialogue Router is the component that handles every outbound question from SEAL to the TL. It's the operational arm of "when in doubt, ask."

#### 3.6b.1 TL Reach Preferences

A single config file declares how to reach the TL:

```json
// ~/.config/seal/tl.json
{
  "name": "Ulisses",
  "reach_priority": ["telegram", "whatsapp", "email", "dashboard"],

  "identities": {
    "telegram": { "user_id": "123456789", "chat_id": "123456789" },
    "whatsapp":  { "jid": "5511999999999@s.whatsapp.net" },
    "email":     { "address": "ulisses@hens.com.br" },
    "discord":   { "user_id": "...", "dm_channel_id": "..." },
    "dashboard": { "url": "http://localhost:3333" }
  },

  "quiet_hours": {
    "enabled": true,
    "from": "22:00",
    "to":   "07:00",
    "timezone": "America/Sao_Paulo",
    "allowed_channels_during_quiet": ["email", "dashboard"],
    "urgent_override": true
  },

  "fallback": {
    "timeout_normal_minutes": 120,
    "timeout_urgent_minutes": 5,
    "timeout_low_minutes":   1440,
    "on_all_channels_timeout": "park_in_dashboard"
  },

  "rendering_preference": "rich"  // rich = buttons/embeds, plain = text only
}
```

#### 3.6b.2 Question Urgency (three levels)

Every question SEAL asks has a declared urgency:

| Level | Timeout | When to use | Example |
|-------|---------|-------------|---------|
| 🔥 **urgent** | 5 min | Time-sensitive plan approval, live incidents | "Client asked for status on deployed change — reply now?" |
| 📬 **normal** | 2 hours | Most proposals, teaching dialogue rounds | "I noticed this pattern 3 times — automate?" |
| 🌙 **low** | 24 hours | Non-blocking proposals, skill retirement suggestions | "This skill hasn't run in 30 days — retire it?" |

The Brain declares urgency when it hands a question to the Dialogue Router. The router then picks a channel based on reach priority + quiet hours + urgency override.

#### 3.6b.3 The Routing Algorithm

```
When SEAL needs to ask Q:

1. Compute eligible_channels:
   - Start from tl.reach_priority
   - If in quiet_hours and NOT urgent:
        filter to tl.quiet_hours.allowed_channels_during_quiet
   - If urgent and quiet_hours.urgent_override:
        use full reach_priority (wake the TL)

2. Try channels in order:
   for channel in eligible_channels:
     send Q via channel (with rendering appropriate for channel)
     wait up to timeout_for(urgency) for a response
     if response: break
     if timeout: continue to next channel

3. If no channel responded:
   execute tl.fallback.on_all_channels_timeout
   options:
     - "park_in_dashboard"  (default — show in pending queue, send morning digest)
     - "auto_deny"          (treat as deny, pattern stays in observing state)
     - "retry_in_N_minutes" (try the whole sequence again after delay)
```

**Key property**: The Dialogue Router is **stateful**. It tracks which question was sent to which channel with which timeout. If the TL eventually answers via a different channel (e.g., SEAL asked via Telegram but TL replied via dashboard), the router reconciles — the answer is valid regardless of the channel it arrived on.

#### 3.6b.4 Channel-Specific Rendering

The same question renders differently per channel. The Dialogue Router handles translation:

**Telegram** (rich — buttons):
```
🔔 SEAL: Approve plan for new-feature skill?

Script preview:
  git checkout -b feature/${1}
  git pull origin main
  git rebase main

[✅ Approve] [✏️ Modify] [❌ Deny] [🚫 Deny + suppress]
```

**WhatsApp** (plain — keyword replies):
```
🔔 SEAL: Approve plan for new-feature skill?
Script preview:
  git checkout -b feature/${1}
  git pull origin main
  git rebase main

Reply with:
  /seal approve 42      — approve
  /seal modify 42       — modify
  /seal deny 42         — deny
  /seal suppress 42     — deny + suppress
```

**Email** (rich — HTML + reply parsing):
```
Subject: [SEAL] Approve plan for new-feature skill? (#42)
Body: <HTML with colored buttons that mailto: back with encoded action>

Alternative: plain text with "Reply YES/NO/MODIFY to approve/deny/modify"
```

**Dashboard** (full UI):
- Modal with full script editor, risk panel, inline approval
- Real-time updates via 5-second polling
- Keyboard shortcuts (Enter = approve, Esc = deny)

The Gateway interface exposes this via an `ask(question, urgency, renderingHint)` method. The Dialogue Router calls it; the gateway handles the channel-specific formatting.

```javascript
// Gateway interface extension
class Gateway {
  // ... existing start/stop/send/onEvent

  // NEW — for the Dialogue Router
  async ask(question, options) {
    // options: { urgency, id, renderingHint, timeout, callbackId }
    // Returns: { delivered_at, delivery_receipt }
    // Actual answer arrives later via onEvent with kind: 'dialogue.response'
  }

  supports_rich_rendering() { return false; /* telegram/discord override to true */ }
}
```

#### 3.6b.5 Stateful Conversations (multi-round teaching)

The teaching dialogue from §3.9.3 requires **multi-round conversations** where each user response triggers SEAL's next question. The Dialogue Router handles this with a **session token** that threads messages together:

```
Teaching session: tsess_abc123

Turn 1 (SEAL → TL via Telegram):
  [tsess_abc123/turn=1] "What should I do when emails like this arrive?"
  Options: [draft_reply, create_task, forward, ignore]

TL response (via Telegram): "create_task"
  → Dialogue Router matches callback_id → tsess_abc123 → Brain

Turn 2 (SEAL → TL via Telegram):
  [tsess_abc123/turn=2] "Should I extract deadline from body text?"
  Options: [yes_extract, fixed_deadline, ask_each_time]

...continues until Brain has enough info to generate the handler skill...

Turn N (SEAL → TL via Telegram):
  [tsess_abc123/turn=N] "Here's the complete plan. Approve?"
  [✅ Approve] [✏️ Modify] [❌ Start over]
```

Sessions persist in SQLite:

```sql
CREATE TABLE dialogue_sessions (
  id TEXT PRIMARY KEY,             -- tsess_<hex>
  trigger_event_id TEXT,           -- what started the session
  current_turn INTEGER DEFAULT 1,
  state TEXT DEFAULT 'active',     -- active | completed | abandoned
  channel TEXT,                    -- primary channel used
  started_at TEXT NOT NULL,
  last_activity_at TEXT,
  context JSON                     -- accumulated answers from each turn
);

CREATE TABLE dialogue_turns (
  session_id TEXT REFERENCES dialogue_sessions(id),
  turn INTEGER,
  question JSON,                   -- what was asked
  asked_at TEXT,
  response JSON,                   -- what TL answered
  responded_at TEXT,
  PRIMARY KEY (session_id, turn)
);
```

If the TL abandons a teaching session (no response for 24h), it's marked `abandoned`. The next time similar data arrives, SEAL starts fresh — no half-built handlers rotting in the database.

#### 3.6b.6 Why This Unlocks the Whole Design

Before adding the Dialogue Router, the design had a hidden assumption: *"the TL will see SEAL's question at the right time."* That assumption is wrong in practice:

- The TL's phone is on silent in a meeting → Telegram notification ignored for 90 minutes
- The TL is on a trip → Gmail IMAP still polling but inbox unread
- The TL is asleep → Quiet hours must prevent a ping at 3am for a non-urgent proposal
- The TL switched devices → Dashboard open on laptop that's now closed

The Dialogue Router makes the physical reality of attention a **first-class concern**. Without it, "ask carefully once" becomes "ask and hope someone's watching" — which is just guessing dressed up in a button.

---

### 3.7 Learning Layer (pattern-focused)

v1's learning layer was ambitious (trajectory logging, strategy journals, quality scoring, Hermes-style insights engine). v2 is much simpler — **one feedback loop**:

> **Which approved skills actually get used? Which don't?**

That's the single learning signal. Track it. Use it to:

1. **Retire dead skills** — if approved + never run in 30 days, mark dormant
2. **Refine detection thresholds** — if 8 of 10 last proposals were denied, raise the confidence threshold
3. **Improve proposal drafting** — compare `original_script` vs `final_script` in modified approvals; feed back into the proposal prompt

No trajectories. No embeddings. No vector DBs. Just counters and simple heuristics. If something more sophisticated becomes necessary later, we'll know exactly what's missing because the simple version will have obvious limits.

**Minimum learning tables**:
```sql
CREATE TABLE learning_signals (
  id INTEGER PRIMARY KEY,
  kind TEXT,                 -- proposal_accepted | proposal_denied | skill_used | skill_failed | skill_modified
  pattern_id TEXT,
  skill_id TEXT,
  delta JSON,                -- what changed (for modified proposals)
  timestamp TEXT DEFAULT (datetime('now'))
);
```

Aggregated into simple weekly reports in the dashboard.

---

---

### 3.8 Flow Engine (kept from v0.2.0, promoted to first-class)

SEAL v0.2.0 already has a flow engine at `src/flows/` (YAML-defined multi-step workflows with adapters). v1 of this design doc incorrectly put it in the anti-scope list. v2 restores it as the **execution substrate for complex skills**.

#### 3.8.1 Why skills need two backends

Not every skill is a linear shell script. Compare:

**Simple skill** — shell script is perfect:
```bash
# ~/.config/seal/skills/new-feature/script.sh
#!/bin/bash
set -euo pipefail
TICKET="${1:?Usage: new-feature <ticket>}"
git checkout -b "feature/$TICKET"
git pull origin main
git rebase main
```

**Complex skill** — shell script gets ugly fast:
```yaml
# ~/.config/seal/skills/meeting-prep/flow.yaml
name: meeting-prep
description: Prepare for a recurring 1:1
triggers:
  cron: "45 9 * * 4"  # 9:45am Thursdays

steps:
  - id: fetch_notes
    type: read_file
    path: ~/notes/people/{{ params.person }}.md
    on_missing: create_empty

  - id: fetch_prs
    type: adapter
    adapter: github
    action: list_user_prs
    params:
      user: "{{ params.github_handle }}"
      state: open
    timeout: 30s

  - id: fetch_action_items
    type: query
    source: mempalace
    query: "action items from last 1:1 with {{ params.person }}"

  - id: draft_agenda
    type: llm
    prompt: |
      Draft a 1:1 agenda using:
      - Notes: {{ steps.fetch_notes.output }}
      - Open PRs: {{ steps.fetch_prs.output }}
      - Last action items: {{ steps.fetch_action_items.output }}
    model: claude-sonnet  # or codex, configurable

  - id: deliver
    type: channel_send
    channel: telegram
    target: "{{ user.telegram_id }}"
    message: "📋 Prep for 1:1 with {{ params.person }}:\n\n{{ steps.draft_agenda.output }}"

  - id: create_notes_entry
    type: append_file
    path: ~/notes/people/{{ params.person }}.md
    content: "\n## {{ now }} - 1:1 prep\n{{ steps.draft_agenda.output }}\n"
```

Trying to write the above as a shell script means inlining curl, jq, Python one-liners, and error handling for each step. YAML flows make it declarative.

#### 3.8.2 Skill Selection: Script vs Flow

The **Proposal Engine decides** which backend to use based on complexity heuristics:

```javascript
function selectSkillBackend(pattern, llmDraft) {
  const indicators = {
    scriptFriendly: 0,
    flowFriendly: 0,
  };

  // Script-friendly: pure shell commands, no branching, no external APIs
  if (llmDraft.stepCount <= 5) indicators.scriptFriendly += 2;
  if (!llmDraft.needsExternalApi) indicators.scriptFriendly += 2;
  if (!llmDraft.hasConditionals) indicators.scriptFriendly += 1;

  // Flow-friendly: multi-source data, LLM steps, conditionals, retries
  if (llmDraft.needsLlmStep) indicators.flowFriendly += 3;
  if (llmDraft.multipleDataSources) indicators.flowFriendly += 2;
  if (llmDraft.hasConditionals) indicators.flowFriendly += 2;
  if (llmDraft.needsRetry) indicators.flowFriendly += 1;

  return indicators.flowFriendly > indicators.scriptFriendly ? 'flow' : 'script';
}
```

The user can override in the proposal (*"Use a flow instead of a script"*). Decisions are logged as learning signals.

#### 3.8.3 Flow Engine Capabilities (kept & extended)

The existing `src/flows/code-review.yaml` pattern is extended with:

| Step type | Purpose | Existing in v0.2.0? |
|-----------|---------|---------------------|
| `shell` | Run a command | ✅ |
| `read_file` / `append_file` / `write_file` | File ops | ✅ (via adapters) |
| `adapter` | Call a registered adapter (github, azure, slack) | ✅ |
| `llm` | Call Claude/Codex with a templated prompt, return parsed output | ❌ NEW |
| `channel_send` | Send message via gateway (Telegram, Discord, email) | ⚠️ partial |
| `query` | Query MemPalace or SQL | ❌ NEW |
| `condition` | Branch on a value | ❌ NEW |
| `retry` | Retry with exponential backoff | ❌ NEW |
| `ask_user` | Pause the flow and ask the TL a question (the bridge to Ingest Loop) | ❌ NEW |

The `ask_user` step is the critical new addition — it lets flows **pause mid-execution** and request input from the TL, then resume. This is what makes the ingest loop's conversational learning possible (see §3.9).

---

### 3.9 The Ingest Loop (Conversational Learning)

**The core problem**: Today, when data arrives at SEAL (an email, a Telegram message, a calendar event), SEAL either (a) tries to execute it as a task, or (b) ignores it. There's no middle ground. There's no "I don't know what to do with this — let me ask."

**The core fix**: Turn every "unknown data" into a conversation. Every conversation into a handler. Every handler into automatic processing for future similar data.

#### 3.9.1 The Loop, Step by Step

```
┌─────────────────────────────────────────────────────────────┐
│  1. Data arrives (email / message / event)                  │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  2. Handler Router: is there a skill that matches?          │
│                                                              │
│     match_criteria examples:                                 │
│     • sender == "client@bigclient.com"                      │
│     • subject matches "^status on"                          │
│     • kind == "calendar.event" AND summary contains "1:1"   │
└─────────────────────────┬───────────────────────────────────┘
                          │
              ┌───────────┴───────────┐
              │                       │
          match found             no match
              │                       │
              ▼                       ▼
  ┌──────────────────────┐  ┌────────────────────────────────┐
  │  3a. Run handler     │  │  3b. Conversational Query      │
  │      (first time:    │  │                                  │
  │       ACK required)  │  │  (a) LLM reads the data          │
  │                      │  │      and drafts understanding:   │
  │      (subsequent:    │  │      "Looks like a status        │
  │       auto or ask,   │  │       request from a client      │
  │       per settings)  │  │       — subject: '...',          │
  │                      │  │       key asks: [...]"           │
  │                      │  │                                  │
  │                      │  │  (b) LLM suggests 3-5 actions:   │
  │                      │  │      • Draft a reply             │
  │                      │  │      • Create a task to handle   │
  │                      │  │      • Forward to someone        │
  │                      │  │      • Ignore                    │
  │                      │  │      • "I'll teach you how"      │
  │                      │  │                                  │
  │                      │  │  (c) Send to TL via preferred    │
  │                      │  │      channel with buttons        │
  └──────────┬───────────┘  └───────────────┬────────────────┘
             │                              │
             ▼                              ▼
  ┌──────────────────────┐  ┌────────────────────────────────┐
  │ 4a. Handler runs,    │  │  4b. TL picks an action OR     │
  │     output delivered │  │      teaches SEAL step by step │
  │                      │  │                                  │
  │                      │  │      (teaching mode: the LLM    │
  │                      │  │       asks follow-ups:          │
  │                      │  │       "Should this apply to all │
  │                      │  │        status emails from this  │
  │                      │  │        sender? Or only when...")│
  └──────────┬───────────┘  └───────────────┬────────────────┘
             │                              │
             └──────────────┬───────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  5. Outcome is saved as a Handler Skill                      │
│                                                              │
│     Match criteria + action + parameters                    │
│     → new entry in skills table with trigger:data_match     │
│                                                              │
│     Next similar data → goes through step 2 → matches →     │
│     step 3a → handler runs automatically (with ACK if set) │
└─────────────────────────────────────────────────────────────┘
```

#### 3.9.2 Handler Skills Schema

Handler skills are just **skills with a data-match trigger**:

```json
{
  "name": "bigclient-status-reply",
  "created_at": "2026-04-10T14:32:00Z",
  "created_from": "ingest_conversation",
  "description": "Draft a 4-bullet status reply when client asks for updates",
  "backend": "flow",
  "flow_path": "~/.config/seal/skills/bigclient-status-reply/flow.yaml",
  "trigger": {
    "kind": "data_match",
    "match": {
      "source": "gmail",
      "from_matches": "@bigclient\\.com$",
      "subject_matches": "^(re: )?status",
      "body_contains_any": ["status", "update", "progress"]
    }
  },
  "approved_at": "2026-04-10T14:32:00Z",   // single approval moment — no re-asking after this
  "notify_on_run": true,                    // post-run notification (not pre-run approval)
  "stats": { "runs": 0, "successes": 0 }
}
```

The flow itself:

```yaml
# ~/.config/seal/skills/bigclient-status-reply/flow.yaml
name: bigclient-status-reply
description: Draft status reply for BigClient

steps:
  - id: fetch_progress
    type: llm
    prompt: |
      Summarize progress on active projects for BigClient.
      Use MemPalace context: {{ context.mempalace.recent_commits }}
      Output as: In Progress | Done | Blocked | Next

  - id: draft_reply
    type: llm
    prompt: |
      Draft a professional email reply to:
      ---
      From: {{ event.from }}
      Subject: {{ event.subject }}
      Body: {{ event.body }}
      ---
      Use this structure:
      # In Progress
      {{ steps.fetch_progress.in_progress }}
      # Done
      {{ steps.fetch_progress.done }}
      # Blocked
      {{ steps.fetch_progress.blocked }}
      # Next
      {{ steps.fetch_progress.next }}

  - id: save_as_draft
    type: adapter
    adapter: gmail
    action: create_draft
    params:
      in_reply_to: "{{ event.message_id }}"
      thread_id: "{{ event.thread_id }}"
      body: "{{ steps.draft_reply.output }}"

  - id: notify_user
    type: channel_send
    channel: telegram
    target: "{{ user.telegram_id }}"
    message: "📧 Drafted reply to {{ event.from }} ({{ event.subject }}). Review in Gmail drafts before sending."
```

**Note the `save_as_draft` step**: the flow never auto-sends. It stores in the Gmail drafts folder and notifies the TL. This matches the safety default from §3.6.

#### 3.9.3 The Conversational Query Protocol

When no handler matches, SEAL enters **teaching mode**. The conversation between SEAL and the TL follows a simple protocol:

**Round 1 — Framing** (SEAL → TL):
```
🤔 New data I don't recognize:

Source: gmail
From: client@newclient.com
Subject: Proposal review needed
Body preview: "Hi Ulisses, could you take a look at the attached
              proposal and let me know your thoughts by Friday?"

LLM interpretation:
  This looks like a professional request to review a document
  with a deadline (Friday).

What should I do?
  [📝 Draft a reply now]
  [📋 Create a task with deadline Friday]
  [📚 Teach me step by step]
  [👀 Show similar past emails you've handled]
  [🤷 Ignore this — I'll handle manually]
  [🚫 Never ask about emails from this sender]
```

**Round 2 — Teaching** (if TL picked "Teach me"):
```
TL: [clicks "Teach me step by step"]

SEAL: Great — I'll ask you a few questions.

  1. What should I DO when I see an email like this?
     [📝 Draft a response]
     [📋 Create a task]
     [🔀 Route to another person]
     [📁 File it somewhere]
     (select one or more)

TL: [selects "Create a task"]

SEAL: 2. Should the task have a deadline extracted from the email?
         (I detected "Friday" in the body)
         [Yes, use the date I extracted]
         [No, use a fixed deadline]
         [Ask me each time]

TL: [selects "Yes, use the date I extracted"]

SEAL: 3. What should the task prompt say?
         I suggest: "Review proposal from {{ sender }} (attached file)
                     and reply by {{ deadline }}"
         [👍 Use this]
         [✏️ Edit it]
         [🔄 Regenerate]

TL: [edits and confirms]

SEAL: 4. Should this also apply to future emails from newclient.com
         that look similar? I'd match on:
           • from: @newclient.com
           • keywords in subject: review, proposal, feedback
         [Yes, match these criteria]
         [Only exact sender + subject shape]
         [Ask me each time]
         [One-time only, don't save]

TL: [selects "Yes, match these criteria"]

SEAL: Perfect. I've created the handler skill 'newclient-proposal-review'.
      Next time a similar email arrives, I'll:
      1. Extract the deadline
      2. Create a SEAL task with deadline + task prompt
      3. Notify you via Telegram
      4. First 3 times I'll still ask for approval before creating the task.

      View in dashboard: http://localhost:3333/skills/newclient-proposal-review
```

**That's the conversational learning loop.** Every teaching session produces a handler skill. Every handler skill reduces the number of times SEAL has to ask in the future.

#### 3.9.4 The LLM's Role in the Ingest Loop

The LLM (Claude, Codex, or GPT — configurable) is critical to the ingest loop, but **only as an advisor**:

| LLM job | What it does | What it does NOT do |
|---------|-------------|---------------------|
| **Interpret incoming data** | Read the email/message/event and summarize the intent | Decide whether to act |
| **Generate action options** | Suggest 3-5 reasonable ways to handle the data | Pick one automatically |
| **Frame the teaching dialogue** | Ask clarifying questions during teaching mode | Assume anything the TL hasn't confirmed |
| **Draft flows/scripts** | Generate the YAML/bash for the handler skill | Save or execute the handler |
| **Extract parameters** | Parse dates, names, IDs from free text | Validate them against reality |

**Provider selection** (the "connect with Codex" ask):

```json
// ~/.config/seal/llm.json
{
  "default": "claude-sonnet",
  "providers": {
    "claude-sonnet": {
      "type": "anthropic",
      "model": "claude-sonnet-4-6",
      "api_key_env": "ANTHROPIC_API_KEY"
    },
    "codex": {
      "type": "openai",
      "model": "gpt-5.3-codex",
      "api_key_env": "OPENAI_API_KEY",
      "endpoint": "https://chatgpt.com/backend-api/codex"
    },
    "local": {
      "type": "ollama",
      "model": "llama3.1:70b",
      "endpoint": "http://localhost:11434"
    }
  },
  "per_job": {
    "proposal_drafting": "claude-sonnet",
    "ingest_interpretation": "claude-sonnet",
    "ingest_teaching_dialogue": "codex",
    "email_draft_generation": "claude-sonnet"
  }
}
```

**Keep it simple**: a single JSON file. No complex provider abstraction, no fallback chains (initially). Each "job" picks from the provider list. If a provider fails, SEAL falls back to the default provider once, then fails the job cleanly (logged, not retried indefinitely).

This is where the user's Hermes pain comes in — don't repeat it. Use the simplest possible provider plumbing.

#### 3.9.5 Handler Match Performance

**Concern**: if every incoming data runs through every handler's match criteria, matching gets slow.

**Solution**: an indexed match table updated on skill create/update:

```sql
CREATE TABLE handler_matchers (
  skill_id TEXT REFERENCES skills(id),
  source TEXT NOT NULL,           -- gmail, telegram, calendar, ...
  priority INTEGER DEFAULT 0,     -- higher = checked first
  criteria JSON NOT NULL,          -- the match clause
  PRIMARY KEY (skill_id, source)
);

CREATE INDEX idx_handler_matchers_source ON handler_matchers(source, priority DESC);
```

On each incoming event:
1. `SELECT * FROM handler_matchers WHERE source = ? ORDER BY priority DESC`
2. For each row, evaluate `criteria` against the event (simple JSON-logic evaluator)
3. First match wins (handlers are ordered by priority, then creation date)
4. If no match → conversational query

Single-table lookup, cheap match evaluation. Scales to hundreds of handlers before needing optimization.

---

## 4. Concrete Walkthroughs

### Walkthrough 1: Branch Pattern → `new-feature` Skill

**Day 1, Monday**: User types:
```
git checkout -b feature/SEAL-101
git pull origin main
git rebase main
```
GitObserver captures each step. PatternDetector sees a 3-step sequence but confidence is low (1 sample).

**Day 3, Wednesday**: User does the same thing with `SEAL-103`. Pattern detector now has 2 samples. Still below threshold.

**Day 5, Friday**: Same with `SEAL-107`. **Threshold crossed** (3 occurrences, 100% matching).

Within 30 seconds, Telegram message arrives:

> 🔔 **SEAL Proposal #42**
>
> I noticed this sequence 3 times this week:
> 1. `git checkout -b feature/<ticket>`
> 2. `git pull origin main`
> 3. `git rebase main`
>
> **Want me to create `/seal new-feature <ticket>`?**
>
> ```bash
> #!/bin/bash
> set -euo pipefail
> TICKET="${1:?Usage: new-feature <ticket>}"
> git checkout -b "feature/$TICKET"
> git pull origin main
> git rebase main
> echo "✅ Branch feature/$TICKET ready"
> ```
>
> ⚠️ Risks: rebase may conflict if uncommitted changes exist.
>
> [✅ Approve once] [💾 Save as skill] [✏️ Modify] [❌ Deny] [🚫 Deny + suppress]

User clicks **💾 Save as skill**. Skill created. Pattern state → `approved`.

**Day 6**: User types `/seal new-feature SEAL-112` in Telegram. The skill runs. Stats updated. Done.

**Day 15**: GitObserver sees the same 3-step sequence starting. SEAL checks: "there's an approved skill for this pattern". It sends:

> SEAL: "Detected the start of your `new-feature` skill. Run it now?"
> [Run] [Skip]

User clicks **Run**. Seamless.

**Day 30**: SEAL: "You've run `new-feature` 12 times this month, every time successfully. Want me to trigger it automatically when I detect the pattern (no confirmation)?"
> [Yes, auto-run] [No, keep asking]

Every escalation is explicit.

### Walkthrough 2: Tag Pattern → `release` Skill

Similar flow, but the detector notices:
- Every 2 weeks on Fridays, user runs: `git tag v<semver> && git push origin v<semver> && gh release create v<semver>`
- Plus a temporal pattern: these events cluster on Friday afternoons

Proposal includes **both** insights:
> "I noticed you cut a release every other Friday. Want `/seal release <version>` that tags, pushes, and creates the GitHub release? (Could optionally trigger automatically every other Friday at 4pm — but I'll always ask first.)"

### Walkthrough 3: Calendar → Meeting Prep Skill

CalendarObserver sees: every Thursday 10am → "1:1 with João". Recurring for 6 weeks now.

Before the very first detection fires, nothing happens. After 3 occurrences, SEAL proposes:

> "You have a recurring 1:1 with João (Thursdays 10am). Want me to prepare 15 minutes before?
>
> My plan:
> 1. Open `~/notes/people/joao.md`
> 2. Fetch João's open PRs from GitHub
> 3. Check your last 1:1 action items
> 4. Draft an agenda
>
> Delivery: Telegram with the draft at 9:45am."
>
> [Approve] [Modify] [Deny]

Approved → skill created with cron trigger `45 9 * * 4`. First run next Thursday.

### Walkthrough 4: Email Pattern → Auto-Draft

ChannelObserver (gmail) notices: every time a PM from the client emails asking "status on X", the user replies within 30 minutes with a 4-bullet format: `# In Progress`, `# Done`, `# Blocked`, `# Next`.

After 3 such reply patterns, SEAL proposes:

> "When 'status on' emails arrive from that PM, want me to draft a reply in your usual 4-bullet format?
>
> It will create a Gmail draft — I will never send emails automatically. You review and click Send yourself."
>
> [Approve draft-only mode] [Modify template] [Deny]

Approved → next email from PM triggers a draft creation. Email stays in drafts folder until user sends.

### Walkthrough 5: Shell Pattern (opt-in)

User has opted into ShellObserver. Every morning around 9am, they run:
```
cd ~/projects/seal
git pull
npm install
code .
```

After 4 days, proposal:
> "Want `/seal warmup seal` that does your morning warmup routine?"

Simple, boring, useful. These are the wins.

### Walkthrough 6: Ingest Loop — First Email from a New Client

This is the scenario that motivated the entire ingest loop redesign.

**10:42 AM — Email arrives in Gmail inbox**:
```
From: sarah@acmecorp.com
Subject: Proposal feedback needed by Friday
Body: Hi Ulisses, we're evaluating your proposal for the dashboard
      project. Could you review our feedback doc (attached) and get
      back to us by Friday? Thanks!
```

**10:42:03 AM — SEAL's Gmail gateway fires event**.

**10:42:04 AM — Handler Router checks for match**. No handler matches (`@acmecorp.com` is unknown). Router triggers conversational query.

**10:42:06 AM — LLM interprets the email**:
- Intent: professional feedback request
- Deadline detected: "Friday" → 2026-04-12
- Has attachment: yes
- Sender: new (not in any existing handler)

**10:42:08 AM — Telegram message arrives**:
```
🤔 SEAL: New data I don't recognize

📧 Email from sarah@acmecorp.com
Subject: Proposal feedback needed by Friday
Deadline: Friday, 2026-04-12

I think this is a feedback request with a deadline.
What should I do?

  [📝 Draft a reply]
  [📋 Create task (deadline Friday)]
  [📚 Teach me how to handle these]
  [🤷 Ignore]
  [🚫 Never ask about @acmecorp.com]
```

**10:43 AM — TL clicks "Teach me how to handle these"**.

SEAL enters teaching mode:
```
SEAL: Great. A few questions:

1. When emails like this arrive, the PRIMARY action should be:
   [ ] Create a task for me to review
   [ ] Draft a reply automatically
   [ ] Both: create task AND draft reply
   [ ] Forward to my designer
```

TL picks **"Both: create task AND draft reply"**.

```
SEAL: 2. For the task, what should the prompt say?
         I suggest:
         "Review proposal feedback from {{sender}} ({{attachment_name}})
          and reply by {{deadline}}"

         [Use this] [Edit] [Regenerate]
```

TL picks **"Use this"**.

```
SEAL: 3. For the draft reply, what tone and length?
         [Short acknowledgment ("Got it, will review")]
         [Medium with ETA commitment]
         [Full structured response (requires my follow-up)]
```

TL picks **"Medium with ETA commitment"**.

```
SEAL: 4. Should I apply this to future emails from ANY new client
         asking for feedback, or only from @acmecorp.com?

         [Any new client with feedback-request pattern]
         [Only @acmecorp.com]
         [Only @acmecorp.com + keywords: proposal, feedback, review]
```

TL picks the third option (specific).

```
SEAL: 5. Last question. The first few times this handler runs,
         should I still ask you for approval before creating the
         task and draft?

         [Yes, ask me for the first 3 runs, then auto]
         [Yes, ask me every time]
         [No, run immediately]
```

TL picks the first option.

```
SEAL: ✅ Handler skill created: acmecorp-proposal-feedback

     Next similar email will:
       1. Parse the deadline from the body
       2. Ask you to approve task + draft creation (first 3 runs)
       3. Create a SEAL task with the deadline
       4. Save a Gmail draft reply (medium tone, ETA commitment)
       5. Notify you via Telegram

     For THIS email specifically, want me to do that now?
       [Yes] [No, I'll handle it manually]
```

TL clicks **"Yes"**. The brand-new skill runs immediately on the triggering email. Task created. Draft saved. Telegram confirms.

**Total elapsed time: ~4 minutes.** But from this moment on, every `acmecorp.com` proposal email is handled in seconds.

---

### Walkthrough 7: Ingest Loop — Approved Plan Runs Automatically

Two weeks after Walkthrough 6. ACME sends another proposal feedback email.

**Handler Router matches** `acmecorp-proposal-feedback`. The plan was already approved during the teaching session in Walkthrough 6. **No re-asking.** The plan runs immediately.

**3 seconds later — Telegram notification (post-run, informational only)**:
```
📬 SEAL: handled an ACME email

Trigger: acmecorp-proposal-feedback (approved 2026-04-10)
From: sarah@acmecorp.com
Subject: Q2 roadmap feedback
Deadline extracted: Wednesday, 2026-04-17

Done:
  ✅ Created task seal_b4e7d102
     "Review proposal feedback from sarah@acmecorp.com
      (Q2-roadmap.pdf) and reply by Wednesday"
  ✅ Saved draft reply in Gmail (medium tone, ETA commitment)

Review: /dashboard/runs/seal_b4e7d102
Revoke skill: /dashboard/skills/acmecorp-proposal-feedback
```

The TL didn't have to approve anything. The plan they approved 2 weeks ago is still running, exactly as designed. Every run is logged. The skill can be revoked with one click if behavior ever drifts.

**Next email from ACME** (4 days later): same thing. Runs in 3 seconds. Notification delivered. Task created. Draft saved. Zero friction.

**The total "approval tax" for handling ACME emails forever**: 4 minutes, once, in Walkthrough 6. After that: free automation, for every matching email, forever — until the TL decides to change or revoke it.

**Compare to the discarded escalation-ladder design**: under the old rules, the TL would have been interrupted 3 times before this became automatic. That's 3 annoying interruptions in exchange for zero additional safety (the plan was already approved; re-asking doesn't catch new bugs).

---

### Walkthrough 8b: Dialogue Router — Channel Fallback in Action

**Scenario**: It's Tuesday 11:40am. A new vendor sends an invoice via email. SEAL's Gmail gateway fires. Handler Router finds no match. Brain drafts a plan. Dialogue Router picks Telegram (primary channel, reach_priority[0]). Urgency: **normal** (2h timeout).

```
11:40:12  SEAL → Telegram: "New invoice from vendor@new.com
                            for $2,340. Draft a task to review
                            and file? (plan attached)"
                            [✅ Approve] [✏️ Modify] [❌ Deny]
```

The TL is in a 90-minute client meeting. Phone is on silent. Notification unread.

```
13:40:12  (2 hours elapsed — Telegram timed out)
          Dialogue Router → next channel: WhatsApp
```

```
13:40:14  SEAL → WhatsApp: "Still waiting on your decision for
                             invoice from vendor@new.com ($2,340).
                             Reply /seal approve 42 to accept,
                             /seal deny 42 to skip."
```

The TL is still in the meeting but glances at WhatsApp between agenda items. Sees the text. Doesn't want to type `/seal approve 42` on a phone in a meeting. Ignores it.

```
15:40:14  (another 2 hours — WhatsApp timed out)
          Dialogue Router → next channel: Email
```

```
15:40:16  SEAL → Email: [SEAL] New invoice decision needed — reply YES/NO

          Subject: [SEAL] Approve plan for vendor@new.com invoice?
          From: seal@ulisses-local
          Body: <HTML with plan preview + approve/deny links>

          X-SEAL-Origin: true
          X-SEAL-Dialogue-Session: tsess_abc123
```

Meeting ends at 15:55. TL opens laptop, sees email. Clicks "Approve" link — which sends a GET request to SEAL's dashboard endpoint with a signed token.

```
15:57:22  TL → Dashboard: GET /api/dialogue/tsess_abc123/approve?sig=...
          Dialogue Router: reconciles → plan approved via email channel
          Brain: generates handler skill "vendor-invoice-triage"
          Hands: runs the approved plan
```

```
15:57:25  SEAL → Telegram + Email (post-run notification, low priority):
          ✅ Done: task created (seal_c8e2a9f1), invoice filed in
          ~/projects/finance/invoices/2026-04/, summary added to
          the ledger. Skill "vendor-invoice-triage" is now active.
```

**Total attempts: 3 channels.** **Total TL clicks: 1.** **Total time lost to channel friction: zero** (the TL didn't even know SEAL had tried Telegram and WhatsApp first — the email arrived when he was actually free). The router made the physical reality of attention invisible.

**Without the Dialogue Router**: SEAL would have sent the Telegram message, waited forever, the invoice would have sat unreviewed for a week, and the vendor would have sent a follow-up — the failure mode of every naive agent that assumes "the user is watching my one channel."

---

### Walkthrough 9: Ingest Loop — Quiet Hours Protection

**Scenario**: 3:47am. A monitoring webhook fires into SEAL's Gmail gateway: "Disk usage at 92% on production server." Brain classifies urgency: **normal** (not page-worthy, but needs action within the day).

```
03:47:00  Dialogue Router checks:
            - Current time: 03:47 America/Sao_Paulo
            - Quiet hours: 22:00-07:00 ✅ active
            - Urgency: normal
            - Urgent override needed? NO (not urgent)
          → eligible_channels filtered to ["email", "dashboard"]
          → primary (telegram) SKIPPED

03:47:02  SEAL → Email only (quiet, no Telegram ping):
          [SEAL] Disk usage alert — action needed today
          (low-priority email, no push notification from Gmail)
```

TL wakes up at 07:15, opens email, reviews, approves. Total sleep interruptions: **0**.

**Compare to urgent scenario**: same webhook but message is "🔥 PRODUCTION DOWN — service unavailable". Brain marks urgency: **urgent**.

```
03:47:00  Dialogue Router:
            - Quiet hours active
            - Urgency: URGENT
            - urgent_override: true
          → use full reach_priority, wake the TL

03:47:02  SEAL → Telegram (with 🔥 prefix for visual urgency):
          🔥🔥🔥 URGENT: production service down — approve
                       auto-restart plan? [✅ YES]
```

Phone vibrates even in silent mode (Telegram urgent notifications override DND if configured). TL approves in 30 seconds. Auto-restart plan executes.

**The difference**: the same router, the same gateways, the same TL — but the Dialogue Router distinguishes between "important enough to wake you" and "important but can wait 4 hours". That distinction lives in the plan urgency level, declared by the Brain during plan drafting.

---

### Walkthrough 8: Ingest Loop — Denied Data

Scenario: a recruiter spam email arrives from LinkedIn.

**Handler Router**: no match.  
**SEAL Telegram**:
```
🤔 New data I don't recognize

📧 LinkedIn email — "Your job match!"
    (LLM interpretation: recruiter outreach, automated)

  [📝 Draft a reply] [📋 Create task] [📚 Teach me]
  [🤷 Ignore] [🚫 Never ask about linkedin.com emails]
```

TL clicks **🚫 Never ask**.

SEAL creates a **suppression handler**:
```json
{
  "name": "suppress-linkedin",
  "trigger": {
    "kind": "data_match",
    "match": { "source": "gmail", "from_matches": "@linkedin\\.com$" }
  },
  "backend": "noop",
  "action": "silently_mark_read_and_archive"
}
```

All future LinkedIn emails: matched → silently archived → TL never sees them. Noise eliminated, zero future friction.

---

## 5. What We're NOT Building (explicit list)

This is the **anti-scope**. When tempted to add these, refer back to this list:

| Feature | Why we're not building it |
|---------|---------------------------|
| Multi-agent registry | One agent type (general) is enough. Specialized agents are a v3 problem if ever. |
| DAG **across tasks** | Tasks remain independent. Skills can be multi-step flows, but we never chain tasks into dependency graphs. |
| Generator-based orchestrator | Node's existing async flow is sufficient. No need for stream architectures. |
| WebSocket streaming to dashboard | Polling every 5 seconds is fine for a single-user system. |
| Tiered concurrency manager | 4-slot limit is fine. Nobody runs 50 concurrent skills. |
| Trajectory logging for training | Not fine-tuning our own models. Not needed. |
| Context compression hooks | Each skill is short. No long-running context to compress. |
| Multi-model provider management | Claude is enough. Don't scatter energy across providers. |
| Policy engine with rule languages | Permission Gate with buttons IS the policy engine. Rules = complexity. |
| Capability-based access control | Sandbox profiles already exist. Don't build a second layer. |
| Federation across machines | Single-user, single-machine. Turso already handles cloud DB. |
| Visual workflow designer | Shell scripts in a text editor. |
| A/B testing of prompts | One prompt, refined based on acceptance rates. |
| Plugin marketplace | Skills are the marketplace. Users share `~/.config/seal/skills/` directories. |
| Team/multi-tenant support | Single user. Period. |

If the user later asks for any of these, the answer is: "Let's see if a simpler approach exists first." Usually it does.

---

## 6. Database Schema (complete)

Only the tables that actually exist in v2. Compare to v1's twelve+ tables.

```sql
-- Existing tables (keep)
tasks            -- current tasks table, unchanged
task_runs        -- existing audit log, unchanged

-- New v2 tables
events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,           -- git|calendar|telegram|gmail|shell|file
  kind TEXT NOT NULL,             -- git.branch.created, calendar.event.upcoming, ...
  timestamp TEXT NOT NULL,
  data JSON NOT NULL,             -- source-specific payload
  INDEX idx_events_source_kind (source, kind),
  INDEX idx_events_timestamp (timestamp)
);
-- Rotation: DELETE WHERE timestamp < date('now', '-90 days')

patterns (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,             -- sequence|temporal|naming|reaction|usage
  signature TEXT UNIQUE NOT NULL, -- canonical hash for dedup
  evidence_count INTEGER DEFAULT 0,
  confidence REAL DEFAULT 0.0,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  state TEXT DEFAULT 'observing', -- observing|proposed|approved|denied|active|retired
  metadata JSON,
  proposed_at TEXT,
  skill_id TEXT REFERENCES skills(id)
);

proposals (
  id TEXT PRIMARY KEY,
  pattern_id TEXT REFERENCES patterns(id),
  script TEXT NOT NULL,
  explanation TEXT NOT NULL,
  risks JSON,
  parameters JSON,
  invocation TEXT,
  delivered_via TEXT,             -- telegram|discord|dashboard|...
  delivered_at TEXT,
  expires_at TEXT,                -- 7-day TTL
  decision TEXT,                  -- NULL until decided
  decided_at TEXT
);

skills (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,      -- the /seal <name> invocation
  description TEXT,
  script_path TEXT NOT NULL,      -- ~/.config/seal/skills/<name>/script.sh
  pattern_id TEXT REFERENCES patterns(id),
  parameters JSON,
  triggers JSON,                  -- { manual, pattern_match, cron, channel_regex }
  requires_ack BOOLEAN DEFAULT 1, -- true until explicitly upgraded to auto
  sandbox_profile TEXT,
  created_at TEXT NOT NULL,
  last_run_at TEXT,
  run_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  state TEXT DEFAULT 'active'     -- active|dormant|retired
);

decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_id TEXT REFERENCES patterns(id),
  proposal_id TEXT REFERENCES proposals(id),
  decision TEXT NOT NULL,         -- approved_once|approved_saved|modified|denied|suppressed|auto_escalated
  original_script TEXT,
  final_script TEXT,
  user_notes TEXT,
  decided_at TEXT NOT NULL
);

learning_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,             -- see §3.7
  pattern_id TEXT,
  skill_id TEXT,
  delta JSON,
  timestamp TEXT DEFAULT (datetime('now'))
);
```

Total new tables: **6**. All simple, no joins deeper than 2 levels.

---

## 7. Implementation Phases (mapped to semver releases)

SEAL is currently at **v0.2.0**. Each phase ships a user-visible milestone as a minor version bump. v1.0.0 is reached when the consent-first pattern-learning loop is production-complete.

Patch versions (v0.3.1, v0.3.2, ...) are reserved for bug fixes between minor releases. Each minor release is independently shippable and usable on its own.

---

### 🎯 v0.3.0 — "SEAL sees" (Week 1-2)

**Theme**: Passive observation. No automation, no proposals. SEAL just watches.

**Scope**:
- Create `events` table (schema in §6)
- Implement `Observer` base class + in-process event bus
- Implement `GitObserver` — git hooks installer + periodic `git log` scraping fallback
- Dashboard: "Recent Events" view (tail of the events table, filterable by source)
- Event retention policy (90-day rotation cron)

**What the user sees after upgrading from v0.2.0**:
> "SEAL is now watching my git activity. I can see every branch, commit, and tag in the dashboard."

**Why ship this alone**: Validates observation works before investing in downstream components. If the event stream is garbage, no pattern detector can save you.

---

### 🎯 v0.4.0 — "SEAL notices" (Week 3)

**Theme**: Pattern detection. Still no proposals — just insight.

**Scope**:
- Create `patterns` table
- Implement sequence pattern detector (the most concrete type)
- Implement naming pattern detector (branch/tag regex library — **the user's specific ask**)
- Dashboard: "Detected Patterns" view with confidence scores
- Background detector runs every 15 minutes + on-event fast path

**What the user sees**:
> "SEAL noticed 6 patterns in my git activity this week: my branch naming convention, my release tag format, and a 3-step 'new feature' sequence I repeat all the time. Cool — it's paying attention."

**Why ship this alone**: User can validate the detector is finding *real* patterns before the proposal engine starts nagging.

---

### 🎯 v0.5.0 — "SEAL proposes" (Week 4-5)

**Theme**: The full consent loop — the first release where SEAL actually offers to do work.

**Scope**:
- Create `proposals` and `decisions` tables
- Implement proposal drafting (LLM prompt in §3.3.1)
- Telegram delivery with inline keyboard (approve/deny/modify/suppress)
- Dashboard: pending proposals list with inline approval
- Proposal TTL (7-day auto-expire)
- Proposal fatigue rate limit (max 3/day, configurable)

**What the user sees**:
> "Telegram ping: 'I noticed this sequence 4 times this week, want me to turn it into a skill?' — I click approve and I have a script ready to use. This is the first time SEAL feels like an assistant, not a task queue."

**Why ship this alone**: End-to-end loop validated. Everything after this is additive value.

---

### 🎯 v0.6.0 — "SEAL remembers" (Week 6) — Script Skills

**Backend scope**: script (`.sh`) only. Flow YAML backend comes in v0.7.0.

**Theme**: Skills become persistent and reusable.

**Scope**:
- Create `skills` table + `~/.config/seal/skills/` directory structure
- Implement `/seal <skill>` invocation in all channels (Telegram, Discord, WhatsApp, CLI)
- Wire skills into existing executor with sandbox profiles
- Manual triggers only (no pattern-match auto-run yet)
- Dashboard: skills library with run history

**What the user sees**:
> "The scripts I approved last week are now saved. I can run `/seal new-feature SEAL-456` anytime from my phone. My productivity jumped this week."

---

### 🎯 v0.7.0 — "SEAL follows steps" (Week 7) — Flow Engine as Skill Backend ⭐ NEW

**Theme**: Upgrade the existing v0.2.0 flow engine into a first-class skill backend.

**Scope**:
- Extend existing `src/flows/` YAML schema with new step types: `llm`, `query`, `channel_send`, `condition`, `retry`, `ask_user`
- Implement "flow skills" — `~/.config/seal/skills/<name>/flow.yaml` as an alternative to `script.sh`
- Proposal engine picks backend automatically (§3.8.2 heuristics) — user can override
- Dashboard: flow skill viewer (renders YAML as a step diagram)
- Migration: existing `src/flows/code-review.yaml` becomes the first built-in flow skill

**What the user sees**:
> "Complex skills like meeting-prep and release workflows now run as declarative YAML flows, not giant shell scripts. I can read them, edit them, and debug each step in the dashboard."

**Why here**: Flow engine is needed *before* the ingest loop (v0.9.0) because handler skills for ingested data are almost always multi-step (parse → enrich → draft → save → notify) — exactly what flows are for.

---

### 🎯 v0.8.0 — "SEAL learns rhythms" (Week 8)

**Theme**: Add the remaining pattern types.

**Scope**:
- Temporal pattern detector (cron fitting over repeated events)
- Reaction pattern detector (incoming message → user reply shape)
- Usage pattern detector (frequency-based)
- Better proposal prompts using naming context ("your convention is feature/PROJ-*")
- Pattern upgrade path: manual trigger → pattern-match confirmation → auto-run

**What the user sees**:
> "SEAL proposed a meeting-prep skill because it saw my Thursday 10am 1:1 repeat for 3 weeks. It also proposed an email draft template based on how I reply to the PM."

---

### 🎯 v0.9.0 — "SEAL integrates" (Week 9-10)

**Theme**: Professional gateway layer + Google Calendar + bidirectional Gmail.

**Scope**:
- `Gateway` base class + `CredentialVault` (encrypted, auto-refresh OAuth)
- Gmail OAuth gateway with **draft-only reply mode** (the safety default)
- Google Calendar gateway with watch channels + freebusy queries
- Refactor existing telegram/discord/whatsapp to use `Gateway` interface (adapter pattern)
- `CalendarObserver` + email `ChannelObserver` emit into event bus
- Dashboard: gateway health + credential status

**What the user sees**:
> "SEAL now watches my calendar and my Gmail. It drafted 3 email responses today — I reviewed and sent them in one click. A 1:1 prep skill fired automatically before my meeting."

**Why this phase is v0.8.0 and not earlier**: Gateways add value **only** once the pattern loop is running. Integrating first (as v1 of the design proposed) wastes effort on inputs the system can't yet use.

---

### 🎯 v0.10.0 — "SEAL asks back" (Week 11-12) — Ingest Loop ⭐ NEW

**Theme**: Symmetric learning — SEAL receives data, asks the TL what to do, learns for next time.

**Scope**:
- Create `handler_matchers` table (§3.9.5)
- Implement **Handler Router**: match incoming events (from any gateway) to handler skills
- Implement **Conversational Query protocol** (§3.9.3):
  - LLM interprets incoming data, drafts interpretation + action options
  - Telegram/Dashboard delivery with multi-round teaching mode
  - Flow generation from answered dialogue
- Add `data_match` trigger kind to skills
- Add `llm.json` config for provider selection (Claude, Codex, GPT, Ollama) — simple JSON, no provider abstraction layer
- First-run-ACK escalation: `requires_ack: true` → auto after N successful runs
- Suppression handlers (`action: silently_archive` for spam/noise patterns)

**What the user sees**:
> "An email from a new client arrives. SEAL pings me on Telegram: 'I don't recognize this — teach me how to handle it.' I answer a few questions in 3 minutes. From now on, every similar email is handled automatically (with my approval for the first 3 runs). I stop being an inbox-processing zombie."

**Why this is the crown jewel release**: This is where SEAL becomes qualitatively different from a task runner. Before v0.10.0, SEAL only automates what you *already did*. After v0.10.0, SEAL also handles what *arrives for you*. The two loops together are the full product.

**LLM integration scope**:
- `llm.json` config with 3-4 provider types (anthropic, openai, ollama, openai-codex)
- Per-job provider selection: proposal drafting may use Claude, ingest interpretation may use Codex
- Single-retry fallback to default provider on failure (NOT indefinite fallback chains)
- Hermes-lessons-learned: no complex credential pools, no API mode auto-detection, no context probing — keep it boring

---

### 🎯 v0.11.0 — "SEAL prunes" (Week 13)

**Theme**: Self-improvement loop — retire dead weight, refine the detector.

**Scope**:
- `learning_signals` tracking (§3.7)
- Dormant skill detection + retirement suggestions
- Proposal prompt refinement using `original_script` vs `final_script` diff history
- Weekly "SEAL report" in dashboard (patterns, proposals, approval rate, hours saved)
- Adaptive confidence thresholds (raise if approval rate drops)

**What the user sees**:
> "SEAL: 'You haven't used the warmup-seal skill in 30 days — retire it?' And: 'This week I saved you ~3 hours, proposed 7 automations (5 approved), and noticed you keep editing my release script to add --dry-run. I'll include that in future proposals.'"

---

### 🎯 v0.12.0 — "SEAL goes deeper" (Week 14)

**Theme**: Opt-in high-privacy observers.

**Scope**:
- `ShellObserver` with `.zshrc` hook installer (opt-in, stores locally encrypted)
- `FileObserver` scoped to explicit directories (opt-in per project)
- Privacy explainer in dashboard
- Password/token auto-redaction in shell events

**What the user sees**:
> "After opting in, SEAL started noticing my morning routine and proposed a /seal warmup skill. Creepy in a good way."

---

### 🎯 v1.0.0 — "SEAL is production" (Week 15-16)

**Theme**: Polish, stability, documentation — ready for other people to use.

**Scope**:
- Full dashboard polish: proposal timeline, skills heatmap, pattern graphs
- Manual pattern creation ("I want to automate X, teach yourself")
- Skill export/import (`.seal-skill` bundles)
- Onboarding wizard for fresh installs
- Documentation: user guide, troubleshooting, privacy policy
- Migration tool from v0.2.0 → v1.0.0 (preserves existing tasks)
- Performance tuning based on real usage metrics from v0.3.0-v0.10.0

**What the user sees**:
> "It's v1.0.0. I've been using this daily for 3 months. I trust it. I'm showing it to other Tech Leads at the company."

---

**Release cadence summary**:

| Version | Theme | Week | Key deliverable |
|---------|-------|------|-----------------|
| v0.2.0 | (current) | — | Task queue + channels + MemPalace |
| v0.3.0 | SEAL sees | 1-2 | Observers + events table |
| v0.4.0 | SEAL notices | 3 | Pattern detector (sequence + naming) |
| v0.5.0 | SEAL proposes | 4-5 | Proposal engine + permission gate |
| v0.6.0 | SEAL remembers | 6 | Skill factory + manual triggers |
| v0.7.0 | SEAL learns rhythms | 7-8 | Temporal + reaction + usage patterns |
| v0.8.0 | SEAL integrates | 9-10 | Gateway layer + Gmail + Calendar |
| v0.9.0 | SEAL prunes | 11 | Learning loop + retirement |
| v0.10.0 | SEAL goes deeper | 12 | Shell + file observers (opt-in) |
| v1.0.0 | Production | 15-16 | Polish + docs + migration |

**Note on the table**: the row numbers for v0.8.0 onward need to be regenerated — see individual phase sections above for authoritative weeks. Updated mapping:

| Version | Theme | Week | Loop |
|---------|-------|------|------|
| v0.2.0 | (current) — task queue + channels | — | — |
| v0.3.0 | SEAL sees — observers + events table | 1-2 | observe |
| v0.4.0 | SEAL notices — pattern detector (seq + naming) | 3 | observe |
| v0.5.0 | SEAL proposes — proposal engine + permission gate | 4-5 | observe |
| v0.6.0 | SEAL remembers — script skills + manual triggers | 6 | observe |
| **v0.7.0** | **SEAL follows steps — flow engine as skill backend** ⭐ | **7** | **both** |
| v0.8.0 | SEAL learns rhythms — temporal + reaction + usage | 8 | observe |
| v0.9.0 | SEAL integrates — gateway layer + Gmail + Calendar | 9-10 | both |
| **v0.10.0** | **SEAL asks back — ingest loop + conversational learning** ⭐ | **11-12** | **ingest** |
| v0.11.0 | SEAL prunes — learning loop + retirement | 13 | both |
| v0.12.0 | SEAL goes deeper — shell + file observers (opt-in) | 14 | observe |
| v1.0.0 | Production — polish + docs + migration | 15-16 | both |

**Total: ~16 weeks from v0.2.0 to v1.0.0.** Two extra weeks vs. Rev 2.0 because of the flow engine upgrade (v0.7.0) and the ingest loop (v0.10.0). Each release is still independently usable — skip any non-essential phase and SEAL still works.

**Critical path to "feels like a real assistant"**: v0.3.0 → v0.4.0 → v0.5.0 → v0.6.0 → v0.7.0 → v0.9.0 → **v0.10.0**. That's the 12-week MVP that delivers both loops end-to-end. Everything else is polish and depth.

---

## 8. Open Questions (Honest Ones)

1. **Shell observation privacy**: Shell history is sensitive. Should SEAL store it encrypted at rest? Should it auto-redact passwords/tokens? (Probably yes to both.)

2. **Git hooks deployment**: Installing hooks in every watched repo is friction. Is a periodic `git log` scrape across `~/projects/*` sufficient as the default? (Probably yes — hooks become an optional upgrade.)

3. **Proposal fatigue**: If SEAL proposes too often, users will click deny reflexively. What's the right rate limit? (Max 3 proposals per day, tunable?)

4. **Cross-project patterns**: If the user does `git rebase` in every project, is that one pattern or N patterns (one per repo)? (Probably one — normalize by removing the project context.)

5. **Branch pattern ticket tracker integration**: When SEAL detects `feature/PROJ-\d+-*`, should it optionally fetch ticket titles from Linear/Jira/Azure DevOps? (Yes, but as an optional enrichment — not required.)

6. **Reaction patterns and privacy**: Analyzing user replies to emails is powerful but invasive. Opt-in? (Yes — definitely opt-in, per-gateway.)

7. **Multi-machine sync**: If the user works on two laptops, should patterns/skills sync? (Turso already exists for cloud DB — yes, if user configures it.)

8. **Skill sharing**: Can users export a skill and share with teammates? (Yes — `~/.config/seal/skills/<name>/` is a directory, just tar it up. Dashboard can have an "export" button.)

---

## 9. Success Metrics (what we measure in 3 months)

| Metric | Target |
|--------|--------|
| Patterns detected | 20+ per week |
| Proposals delivered | 5+ per week |
| Proposal approval rate | 40-60% (too high = proposals too obvious, too low = detection too noisy) |
| Skills created | 15+ active |
| Skills used per week | 30+ total invocations |
| Time saved per week | 2+ hours (measured by skill runtime × run count) |
| Skill retirement rate | <20% (otherwise we're creating junk) |
| User-reported satisfaction | "SEAL feels like a real assistant" |

The most important one: **does the Tech Lead trust SEAL enough to keep it running?** If after 3 months you've turned it off, the design failed, no matter what the numbers say.

---

## 10. Philosophical Commitments

Pinning these so we don't drift later.

### 10.0 The Two Prime Directives

> **1. It acts like me, but it is not me.**
> **2. When in doubt, ask. One more question is better than one more error.**

These two rules together form the product's ethical spine. The first sets the limit on **what SEAL may become** (never the TL, always the shadow). The second sets the limit on **how SEAL may act** (never guess, always clarify).

They balance each other:

- Without the Doubt Rule, "it acts like me" becomes reckless — SEAL would confidently automate things based on half-understood patterns.
- Without the Impersonation Rule, "when in doubt ask" becomes invasive — SEAL would ask permission for everything, including things that could obviously only be the TL.

Together: SEAL moves confidently within approved plans, and carefully when creating new ones.

---

### 10.0.1 The Doubt Rule, Operationalized

"When in doubt, ask" is not a feeling — it's a testable rule applied at specific moments:

| Moment | Rule |
|--------|------|
| **Proposal drafting (Observe loop)** | If the LLM is <80% confident that a pattern is intentional and repeatable → don't propose yet. Wait for more evidence. |
| **Plan interpretation (Ingest loop)** | If the LLM is <80% confident about what the data means → include an `ask_user` step in the plan instead of guessing. |
| **Teaching dialogue** | If the TL's answer is ambiguous → ask a clarifying question. Better to have 5 rounds in teaching mode than a wrong handler skill afterward. |
| **Parameter extraction** | If SEAL extracts a date/name/amount and the source text is ambiguous → flag it in the plan preview for explicit confirmation. |
| **Match evaluation** | If incoming data partially matches a handler (60-80% overlap) → do NOT auto-run. Treat as unknown data, ask. |
| **Plan drafting with high stakes** | If the plan touches irreversible actions (send, delete, publish, merge, deploy) → the plan MUST include either `save_as_draft`/dry-run mode OR an explicit `ask_user` confirmation step. |

The Doubt Rule means the **cost of asking is paid once, at plan creation**. After the plan is approved, the doubt is resolved forever for that pattern. This is why plan-based approval (§3.4.1) works: because the plans were built doubt-first, the approval is robust.

**The mantra**: *Ask carefully once → act confidently forever.*

---

### 10.0.2 Concrete Rules Derived from the Impersonation Directive

Every design choice must pass this test. When in doubt, the question is:
- *"Would this feature let SEAL be mistaken for the Tech Lead?"* → REJECT
- *"Would this feature let SEAL act without the Tech Lead's awareness?"* → REJECT
- *"Would this feature make the Tech Lead's life easier while keeping him in the loop?"* → ACCEPT

1. **Every outbound message from SEAL must be labeled as SEAL.** Emails sent via Gmail gateway carry a `X-SEAL-Origin: true` header and a footer: *"— sent by SEAL on behalf of Ulisses, draft approved at 14:32"*. No exceptions.
2. **Every action is auditable.** The `decisions` table is append-only. Every skill run links back to the approval that authorized it. No ghost actions.
3. **SEAL has no opinions on ambiguous things.** When the Brain interprets data, it offers options — never a single "correct" answer. The TL always picks.
4. **SEAL cannot learn to impersonate.** If a pattern would cause SEAL to send messages that look indistinguishable from the TL, the Brain must flag it and require explicit approval for each run, forever. No auto-escalation allowed.
5. **Shutdown is absolute.** When SEAL is stopped (`seal stop` or process killed), all pending proposals expire within 24 hours. The shadow cannot outlive the owner's attention.

### 10.1 Working Commitments

1. **SEAL is a shadow, not a colleague.** It doesn't initiate conversations. It doesn't have opinions. It observes and proposes.
2. **Every action is consented.** No exceptions. Escalation to auto-mode is always explicit.
3. **Simplicity is a feature.** Every time we add a component, we ask: "Can this be a shell script instead?" Usually yes.
4. **The user's time is sacred.** Proposal fatigue is worse than no proposals. Better to miss a pattern than to nag.
5. **Patterns come from the user, not from templates.** No hardcoded "Tech Lead workflows". SEAL learns what YOU do.
6. **Transparency over magic.** Every proposal shows the actual script. No black boxes.
7. **Retirement over accumulation.** Unused skills die. The system self-prunes.
8. **The dashboard is a window, not a control room.** Most interaction happens through chat (Telegram). The dashboard is for inspection and history.

---

## Appendix: What We Kept From v1

The research in v1 wasn't wasted. These patterns carry over:

- **Nanoclaw's filesystem isolation** — each skill has its own directory under `~/.config/seal/skills/`
- **Nanoclaw's channel factory pattern** — gateways register at startup
- **Hermes's prefetch/sync cycle** — simplified: prefetch relevant past decisions before drafting proposals, sync decision outcome after
- **Claude Code's sandboxing** — existing `sandbox-exec` profiles are reused for skill execution
- **Claude Code's permission layering** — adapted to the human-clickable Permission Gate
- **Existing SEAL**: tasks, task_runs, sandbox profiles, policy engine (simplified), MemPalace (optional, for proposal context retrieval)

**What was dropped**: task-level DAG engine, agent registry, generator orchestrator, trajectory logging, tiered concurrency, streaming WebSockets, complex multi-provider management, capability-based policy language.

**What was restored in Rev 2.1**: the flow engine (as a skill backend, not a task orchestrator), the ingest loop with conversational learning, and a minimal multi-LLM configuration (for the "connect with Codex" use case).

v1 was a platform. v2 is a tool. Tools get used.
