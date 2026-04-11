# SEAL Agent System — Design Document

> **Status**: Draft v1.1  
> **Date**: 2026-04-10  
> **Author**: Architecture session (Claude + Ulisses)  
> **Scope**: Evolution from task runner to autonomous agent orchestration system  
> **v1.1 additions**: Gateway layer, Google Calendar, bidirectional Email

---

## 1. Executive Summary

SEAL today is a **task queue daemon** — it polls SQLite for pending tasks, spawns isolated `claude -p` subprocesses, and routes results back through notification channels. This works for one-shot automation but lacks the capabilities needed for true agent-level autonomy: goal decomposition, inter-agent communication, learning from past executions, and adaptive decision-making.

This document proposes the **SEAL Agent System** — an evolution that adds:

- **Agent Registry** with specialized, composable agents (not just `claude -p`)
- **Orchestrator Loop** inspired by Claude Code's generator-based agent loop
- **Self-Learning Layer** inspired by Hermes's dual-memory + feedback architecture
- **DAG-based Task Graph** replacing linear task execution
- **Dashboard as Control Plane** (not just visibility)

### Design Principles

1. **Incremental evolution** — Each layer adds value independently. No big-bang rewrite.
2. **Steal shamelessly** — Adapt proven patterns from Claude Code, Hermes, and Nanoclaw.
3. **Isolation by default** — Agents can't escalate privileges or corrupt shared state.
4. **Learn from every execution** — Every task outcome feeds future decisions.
5. **Human stays in the loop** — Autonomy is a spectrum controlled by policy, not a switch.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    DASHBOARD (Control Plane)                  │
│  Task Graph Viz │ Agent Registry │ Memory Explorer │ Policies │
└────────────────────────────┬────────────────────────────────┘
                             │ REST + WebSocket
┌────────────────────────────┴────────────────────────────────┐
│                     SEAL CORE DAEMON                         │
│                                                              │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ Ingestion │  │  Orchestrator │  │    Agent Registry      │ │
│  │ Channels  │→│  Loop         │→│  (specialized agents)   │ │
│  └──────────┘  └──────┬───────┘  └────────────────────────┘ │
│                        │                                     │
│  ┌─────────────────────┴──────────────────────────────────┐ │
│  │              Task Graph (DAG Engine)                     │ │
│  │  goal → decompose → schedule → execute → collect        │ │
│  └─────────────────────┬──────────────────────────────────┘ │
│                        │                                     │
│  ┌──────────┐  ┌───────┴──────┐  ┌────────────────────────┐ │
│  │ Policy   │  │  Executor    │  │  Learning Layer         │ │
│  │ Engine   │  │  (sandboxed) │  │  (memory + feedback)    │ │
│  └──────────┘  └──────────────┘  └────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Component Design

### 3.1 Agent Registry

**Inspiration**: Claude Code's tool registration + Nanoclaw's channel registry factory pattern.

Today SEAL has one execution mode: spawn `claude -p` with a prompt. The Agent Registry introduces **typed, configurable agents** that declare their capabilities.

#### Agent Definition Schema

```javascript
// agents/code-reviewer.js
export default {
  name: 'code-reviewer',
  description: 'Reviews PRs for code quality, security, and style',
  version: '1.0.0',

  // What this agent can do (for policy engine)
  capabilities: ['scm:read', 'scm:comment', 'fs:read'],

  // What tools this agent is allowed to use
  allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],

  // Resource constraints
  constraints: {
    maxIterations: 30,        // Tool-calling budget (from Claude Code)
    maxTokens: 100_000,       // Output token limit
    timeoutMs: 10 * 60_000,   // 10 minutes
    sandboxProfile: 'readonly', // macOS sandbox
  },

  // Memory configuration
  memory: {
    prefetch: true,           // Load relevant memories before execution
    sync: true,               // Write outcomes to memory after execution
    contextFiles: ['REVIEW_GUIDELINES.md'], // Always-load context
  },

  // System prompt builder
  buildPrompt({ task, memories, context }) {
    return `You are a code reviewer for ${task.project}...`;
  },

  // Optional: post-processing of agent output
  postProcess({ result, task }) {
    return extractReviewDecision(result);
  },
};
```

#### Registry API

```javascript
class AgentRegistry {
  register(agentDefinition)        // Register an agent type
  get(name) → AgentDefinition      // Look up by name
  list({ capability? }) → Agent[]  // Filter by capability
  resolve(task) → AgentDefinition  // Auto-select best agent for a task
}
```

**Auto-resolution**: When a task doesn't specify an agent, the registry uses task type + capabilities + past performance metrics to select the best agent. This is where learning feeds back into orchestration.

#### Built-in Agents (Phase 1)

| Agent | Purpose | Capabilities |
|-------|---------|-------------|
| `general` | Default — current `claude -p` behavior | `*` (policy-controlled) |
| `code-reviewer` | PR review + style enforcement | `scm:read`, `scm:comment` |
| `deployer` | CI/CD trigger + monitoring | `shell:deploy`, `http:*` |
| `writer` | Blog posts, docs, changelogs | `fs:write`, `http:read` |
| `researcher` | Web search + summarization | `http:read`, `fs:write` |
| `planner` | Goal decomposition into subtask DAGs | `seal:create-task` |

---

### 3.2 Orchestrator Loop

**Inspiration**: Claude Code's `queryLoop` generator pattern + Hermes's iteration budget.

The current SEAL runner is a simple poll-execute-notify loop. The new Orchestrator is a **generator-based event loop** that yields control at each phase, enabling streaming, cancellation, and mid-execution policy checks.

#### Loop Architecture

```javascript
async function* orchestratorLoop(task, agent, context) {
  // Phase 1: Prefetch
  yield { phase: 'prefetch', status: 'started' };
  const memories = await memoryLayer.prefetch(task);
  const contextFiles = await loadContextFiles(agent, task);
  yield { phase: 'prefetch', status: 'done', memories, contextFiles };

  // Phase 2: Policy check
  yield { phase: 'policy', status: 'checking' };
  const decision = await policyEngine.evaluate(task, agent);
  if (decision.action === 'deny') {
    yield { phase: 'policy', status: 'denied', reason: decision.reason };
    return;
  }
  if (decision.action === 'require_ack') {
    yield { phase: 'policy', status: 'awaiting_ack' };
    await waitForAcknowledgment(task);
  }
  yield { phase: 'policy', status: 'approved' };

  // Phase 3: Execute
  yield { phase: 'execute', status: 'started' };
  const iterationBudget = new IterationBudget(agent.constraints.maxIterations);

  for await (const event of executeAgent(task, agent, memories, contextFiles)) {
    // Stream events to dashboard via WebSocket
    yield { phase: 'execute', event };

    // Check budget (from Hermes pattern)
    if (iterationBudget.exhausted) {
      yield { phase: 'execute', status: 'budget_exceeded' };
      break;
    }

    // Check for cancellation
    if (task.status === 'cancelled') {
      yield { phase: 'execute', status: 'cancelled' };
      break;
    }
  }

  // Phase 4: Post-process
  yield { phase: 'postprocess', status: 'started' };
  const result = agent.postProcess?.({ result: event.output, task }) ?? event.output;

  // Phase 5: Learn
  yield { phase: 'learn', status: 'started' };
  await memoryLayer.sync(task, result);
  await feedbackLoop.record(task, result, iterationBudget.stats());
  yield { phase: 'learn', status: 'done' };

  // Phase 6: Notify + trigger dependents
  yield { phase: 'complete', result };
  await notifyChannels(task, result);
  await taskGraph.onTaskComplete(task.id, result);
}
```

#### Key Patterns Adopted

| Pattern | Source | How SEAL Uses It |
|---------|--------|-----------------|
| Generator-based loop | Claude Code `query.ts` | Streaming events to dashboard, cancellation points |
| Iteration budget | Hermes `IterationBudget` | Prevent runaway agents, track tool call costs |
| Prefetch → Execute → Sync | Hermes memory cycle | Memory context injected before, outcomes captured after |
| Concurrent tool batching | Claude Code `toolOrchestration.ts` | Read-only tools run in parallel, stateful ones serialize |
| Exponential backoff retry | Nanoclaw `GroupQueue` | Transient failures retry with 5s base, max 5 retries |

---

### 3.3 Task Graph (DAG Engine)

**Inspiration**: Claude Code's subagent spawning + missing capability in current SEAL.

Current SEAL tasks are independent — no dependencies, no data flow between them. The Task Graph introduces **directed acyclic graph** execution:

#### Schema Extension

```sql
-- New table: task edges
CREATE TABLE task_edges (
  parent_id TEXT NOT NULL REFERENCES tasks(id),
  child_id TEXT NOT NULL REFERENCES tasks(id),
  edge_type TEXT NOT NULL DEFAULT 'depends_on',  -- depends_on | data_flow | cancel_on_fail
  data_key TEXT,  -- For data_flow: which output key to pass
  PRIMARY KEY (parent_id, child_id)
);

-- New columns on tasks table
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id);
ALTER TABLE tasks ADD COLUMN agent_name TEXT DEFAULT 'general';
ALTER TABLE tasks ADD COLUMN input_data JSON;     -- Data received from parent
ALTER TABLE tasks ADD COLUMN output_data JSON;    -- Structured output for children
ALTER TABLE tasks ADD COLUMN goal TEXT;            -- High-level goal (for decomposition)
```

#### Goal Decomposition Flow

```
User: "Review all open PRs and deploy if all approved"
  │
  ├─ [planner agent] decomposes into:
  │
  ├─ Task A: "List open PRs" (agent: general)
  │   └─ output_data: { prs: [...] }
  │
  ├─ Task B: "Review PR #42" (agent: code-reviewer, depends_on: A)
  ├─ Task C: "Review PR #43" (agent: code-reviewer, depends_on: A)
  ├─ Task D: "Review PR #44" (agent: code-reviewer, depends_on: A)
  │   └─ B, C, D run in parallel
  │
  ├─ Task E: "Check all reviews passed" (agent: general, depends_on: B,C,D)
  │   └─ cancel_on_fail: true
  │
  └─ Task F: "Deploy to production" (agent: deployer, depends_on: E)
      └─ permission_mode: 'plan' (requires ACK)
```

#### DAG Executor

```javascript
class TaskGraph {
  // Resolve ready tasks (all dependencies satisfied)
  getReadyTasks() → Task[]

  // Called when a task completes — unblocks dependents, passes data
  async onTaskComplete(taskId, result) {
    const edges = await db.getEdges({ parent_id: taskId });
    for (const edge of edges) {
      if (edge.edge_type === 'data_flow') {
        await db.updateTask(edge.child_id, {
          input_data: { ...existing, [edge.data_key]: result }
        });
      }
      if (edge.edge_type === 'cancel_on_fail' && result.failed) {
        await db.updateTask(edge.child_id, { status: 'cancelled' });
      }
      // Check if child is now unblocked
      const blocked = await db.hasUnresolvedDependencies(edge.child_id);
      if (!blocked) {
        await db.updateTask(edge.child_id, { status: 'pending' });
      }
    }
  }

  // Visualize DAG for dashboard
  toGraph() → { nodes: TaskNode[], edges: TaskEdge[] }
}
```

---

### 3.4 Learning Layer

**Inspiration**: Hermes's dual-memory (MEMORY.md + USER.md) + prefetch/sync cycle + trajectory logging.

This is SEAL's biggest missing piece. Currently, each `claude -p` invocation is amnesiac — no cross-task learning, no failure analysis, no strategy refinement.

#### Architecture

```
┌────────────────────────────────────────────────┐
│              Learning Layer                      │
│                                                  │
│  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ Memory Store  │  │ Feedback Engine           │ │
│  │ (what we know)│  │ (what we learned)         │ │
│  ├──────────────┤  ├──────────────────────────┤ │
│  │ MemPalace    │  │ Outcome Tracker           │ │
│  │ (vectors)    │  │ (success/fail/cost)       │ │
│  │              │  │                            │ │
│  │ Strategy     │  │ Pattern Detector           │ │
│  │ Journal      │  │ (recurring failures,       │ │
│  │ (decisions)  │  │  effective prompts)        │ │
│  │              │  │                            │ │
│  │ Agent        │  │ Quality Scorer             │ │
│  │ Profiles     │  │ (per-agent effectiveness)  │ │
│  └──────────────┘  └──────────────────────────┘ │
│                                                  │
│  ┌──────────────────────────────────────────────┐│
│  │ Prefetch → [Agent Execution] → Sync          ││
│  └──────────────────────────────────────────────┘│
└────────────────────────────────────────────────────┘
```

#### 3.4.1 Memory Store (Extended)

Current SEAL has MemPalace for vector search. We extend with two new stores:

**Strategy Journal** — records HOW tasks were solved, not just WHAT happened.

```sql
CREATE TABLE strategy_journal (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  agent_name TEXT,
  project TEXT,
  -- What was tried
  strategy_summary TEXT,        -- "Used git diff + line-by-line review"
  prompt_hash TEXT,             -- Hash of the prompt template used
  -- What happened
  outcome TEXT,                 -- 'success' | 'partial' | 'failed'
  quality_score REAL,          -- 0.0 - 1.0 (from feedback engine)
  -- What to do differently
  learnings TEXT,               -- "Next time, check CI status before reviewing"
  reuse_score REAL,            -- How applicable to future similar tasks
  created_at TEXT DEFAULT (datetime('now'))
);
```

**Agent Profiles** — tracks per-agent effectiveness over time.

```sql
CREATE TABLE agent_profiles (
  agent_name TEXT PRIMARY KEY,
  total_runs INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  avg_duration_ms REAL,
  avg_token_cost REAL,
  avg_quality_score REAL,
  -- Per-project breakdown
  project_stats JSON,          -- { "seal": { runs: 10, success: 9 }, ... }
  -- Failure patterns
  common_failures JSON,        -- [{ pattern: "timeout on large repos", count: 3 }]
  last_updated TEXT
);
```

#### 3.4.2 Feedback Engine

**Inspired by**: Hermes's `InsightsEngine` + trajectory logging.

```javascript
class FeedbackEngine {
  // Called after every task execution
  async record(task, result, stats) {
    // 1. Log trajectory (for future training data, a la Hermes)
    await this.logTrajectory(task, result, stats);

    // 2. Update agent profile
    await this.updateAgentProfile(task.agent_name, {
      duration: stats.durationMs,
      tokens: stats.totalTokens,
      outcome: result.exitCode === 0 ? 'success' : 'failed',
    });

    // 3. Detect patterns
    const patterns = await this.detectPatterns(task, result);
    if (patterns.recurringFailure) {
      // Auto-create a strategy journal entry
      await this.recordLearning(task, patterns);
    }

    // 4. Score quality (heuristic for now, LLM-based later)
    const quality = await this.scoreQuality(task, result);
    await this.updateStrategyJournal(task, quality);
  }

  // Called during prefetch — what did we learn about similar tasks?
  async getRelevantLearnings(task) {
    return db.query(`
      SELECT strategy_summary, learnings, quality_score
      FROM strategy_journal
      WHERE project = ? AND agent_name = ?
      ORDER BY quality_score DESC, created_at DESC
      LIMIT 5
    `, [task.project, task.agent_name]);
  }
}
```

#### 3.4.3 Prefetch/Sync Cycle

Directly adopted from Hermes's `MemoryManager` lifecycle:

```
┌─────────────────────────────────────────────────────┐
│                  TASK LIFECYCLE                       │
│                                                      │
│  1. PREFETCH (before execution)                      │
│     ├─ MemPalace: semantic search by task summary    │
│     ├─ Strategy Journal: similar past tasks          │
│     ├─ Agent Profile: known failure patterns         │
│     └─ Context Files: agent-specific guidelines      │
│                                                      │
│  2. INJECT (prompt assembly)                         │
│     └─ <memory-context> block prepended to prompt    │
│         ├─ Relevant memories (scored, truncated)     │
│         ├─ Past learnings for this task type         │
│         └─ Known pitfalls to avoid                   │
│                                                      │
│  3. EXECUTE (agent runs)                             │
│     └─ Streaming output captured                     │
│                                                      │
│  4. SYNC (after execution)                           │
│     ├─ MemPalace: store outcome                      │
│     ├─ Strategy Journal: record strategy + quality   │
│     ├─ Agent Profile: update stats                   │
│     ├─ Trajectory: log full conversation (JSONL)     │
│     └─ task_runs: audit log (existing)               │
└─────────────────────────────────────────────────────┘
```

---

### 3.5 Executor (Enhanced)

**Inspiration**: Claude Code's tool batching + Nanoclaw's container isolation.

#### Execution Modes

The current executor only knows `claude -p`. The enhanced executor supports multiple backends:

```javascript
class Executor {
  async* execute(task, agent, context) {
    const mode = agent.executionMode ?? 'subprocess';

    switch (mode) {
      case 'subprocess':
        // Current behavior: spawn claude -p (or any CLI)
        yield* this.executeSubprocess(task, agent, context);
        break;

      case 'sdk':
        // New: use Claude Agent SDK directly (no subprocess overhead)
        yield* this.executeSDK(task, agent, context);
        break;

      case 'container':
        // Future: Nanoclaw-style Docker/Apple Container isolation
        yield* this.executeContainer(task, agent, context);
        break;

      case 'flow':
        // Flow engine: multi-step YAML workflow
        yield* this.executeFlow(task, agent, context);
        break;

      case 'script':
        // Nanoclaw pattern: pre-flight script decides if agent wakes
        const shouldWake = await this.runPreFlight(task);
        if (shouldWake) yield* this.executeSubprocess(task, agent, context);
        break;
    }
  }
}
```

#### Concurrency Model

Upgrade from flat 4-slot limit to **tiered concurrency** (inspired by Nanoclaw's GroupQueue):

```javascript
class ConcurrencyManager {
  constructor() {
    this.slots = {
      heavy: 2,    // Full agent runs (claude -p, SDK)
      light: 6,    // Script pre-flights, notifications, memory ops
      flow: 2,     // Flow engine executions
    };
    this.queues = new Map(); // Per-project queues
  }

  // Nanoclaw pattern: per-project queue + global limit
  async acquire(task) {
    const tier = this.classifyTier(task);
    const queue = this.getQueue(task.project ?? 'default');
    await queue.waitForSlot(tier);
    return { release: () => queue.release(tier) };
  }
}
```

---

### 3.6 Dashboard as Control Plane

**Current**: Read-only task list + stats.  
**Target**: Full agent control plane with live streaming.

#### New Dashboard Capabilities

| Feature | Description | API |
|---------|-------------|-----|
| **Task Graph Viz** | Interactive DAG view of task dependencies | `GET /api/graph/:rootTaskId` |
| **Agent Registry** | View, enable/disable, configure agents | `GET/PUT /api/agents` |
| **Live Streaming** | Real-time agent output via WebSocket | `WS /api/stream/:taskId` |
| **Memory Explorer** | Browse strategy journal, agent profiles | `GET /api/memory/strategies` |
| **Policy Editor** | Visual rule builder for auto_approve/deny | `GET/PUT /api/policies` |
| **Learning Dashboard** | Agent effectiveness over time, failure patterns | `GET /api/analytics` |
| **Manual Decomposition** | User decomposes goals into subtask DAG | `POST /api/graph/create` |

#### WebSocket Protocol

```javascript
// Client subscribes to task events
ws.send({ type: 'subscribe', taskId: 'seal_a3d074e4' });

// Server streams orchestrator events
ws.receive({
  type: 'phase',
  taskId: 'seal_a3d074e4',
  phase: 'execute',
  event: { tool: 'Bash', input: 'npm test', status: 'running' }
});

// Client can send control signals
ws.send({ type: 'cancel', taskId: 'seal_a3d074e4' });
ws.send({ type: 'approve', taskId: 'seal_a3d074e4' });
```

---

---

### 3.7 Gateway Layer (Unified Integration Plane)

**Current state**: 5 channel files (`telegram.js`, `discord.js`, `whatsapp.js`, `ingest-gmail.js`, `ingest-server.js`) — each independent, no common interface, hardcoded `switch` statements in `channel-notify.js`. Gmail is **read-only** — task results originating from email vanish into the void. No Google Calendar. Auth is fragmented.

**Goal**: A professional gateway layer that unifies ingestion + outbound, supports bidirectional integrations (read AND answer), and makes adding new providers (Slack, calendar, CRMs) a 30-minute task instead of a full rewrite.

**Inspiration**: Nanoclaw's `ChannelFactory` registry + Hermes's `credential_pool.py` + Claude Code's plugin lifecycle.

#### 3.7.1 Gateway Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     GATEWAY LAYER                             │
│                                                                │
│  ┌──────────────────────────────────────────────────────┐   │
│  │            Gateway Manager (lifecycle)                │   │
│  │  • register(gateway)                                  │   │
│  │  • start/stop/healthcheck                             │   │
│  │  • credential resolution (vault)                      │   │
│  │  • event routing (ingest → orchestrator)              │   │
│  └───────────┬──────────────────────────────────────────┘   │
│              │                                                 │
│  ┌───────────┴──────────────────────────────────────────┐   │
│  │              Gateway Interface (contract)             │   │
│  │                                                        │   │
│  │  interface Gateway {                                   │   │
│  │    name: string                                        │   │
│  │    kind: 'chat' | 'email' | 'calendar' | 'scm'         │   │
│  │    direction: 'ingest' | 'outbound' | 'bidirectional'  │   │
│  │                                                        │   │
│  │    async start(credentials, config)                    │   │
│  │    async stop()                                        │   │
│  │    async healthCheck() → HealthStatus                  │   │
│  │                                                        │   │
│  │    // Ingestion (gateway → SEAL)                       │   │
│  │    onEvent(handler: (event) => void)                   │   │
│  │                                                        │   │
│  │    // Outbound (SEAL → gateway)                        │   │
│  │    async send(target, payload) → Receipt               │   │
│  │                                                        │   │
│  │    // Threading (optional)                             │   │
│  │    async reply(originalMessageId, payload)             │   │
│  │                                                        │   │
│  │    // Capabilities declaration                         │   │
│  │    capabilities: GatewayCapabilities                   │   │
│  │  }                                                     │   │
│  └───────────┬──────────────────────────────────────────┘   │
│              │                                                 │
│  ┌───────────┴─────────────┬──────────────┬───────────────┐ │
│  │  ChatGateway            │ EmailGateway │ CalendarGateway│ │
│  │  • telegram             │ • gmail      │ • google-cal   │ │
│  │  • discord              │ • outlook    │ • outlook-cal  │ │
│  │  • whatsapp             │ • smtp/imap  │ • caldav       │ │
│  │  • slack (new)          │              │                │ │
│  └─────────────────────────┴──────────────┴───────────────┘ │
│                                                                │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Credential Vault                          │   │
│  │  • OAuth token refresh (Google, Microsoft)             │   │
│  │  • Encrypted storage at ~/.config/seal/vault.enc       │   │
│  │  • Per-gateway credential scoping                      │   │
│  │  • Expiry monitoring + auto-refresh                    │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

#### 3.7.2 Unified Event Schema

All gateways emit a normalized `GatewayEvent`, regardless of source:

```typescript
interface GatewayEvent {
  // Origin
  gateway: string;              // 'telegram' | 'gmail' | 'google-calendar'
  eventId: string;              // Stable ID for dedup
  timestamp: string;            // ISO 8601

  // Actor
  actor: {
    id: string;                 // Platform-native ID (chatId, email, userId)
    displayName?: string;
    contact?: string;           // email, phone, handle
  };

  // Content
  kind: 'message' | 'email' | 'event' | 'call' | 'reaction';
  thread?: {                    // For threading/replies
    id: string;
    parentEventId?: string;
  };
  content: {
    text?: string;
    html?: string;              // For rich email
    subject?: string;           // Email-specific
    attachments?: Attachment[];
    metadata?: Record<string, any>;
  };

  // Reply target (so the orchestrator knows how to respond)
  replyTarget: {
    gateway: string;            // Which gateway to use for reply
    target: string;              // Where to send (chatId, email addr, etc.)
    threadId?: string;           // For threaded replies
    messageId?: string;          // For in-reply-to headers
  };
}
```

**Why this matters**: The orchestrator doesn't need to know how Telegram differs from Gmail. It sees `GatewayEvent`, routes to an agent, and when done, sends a `GatewayReply` back through the `replyTarget`. This is the same trick Claude Code uses for tool results — uniform shape, polymorphic dispatch.

#### 3.7.3 Gateway Registry & Lifecycle

```javascript
class GatewayManager {
  constructor() {
    this.gateways = new Map();        // name → Gateway instance
    this.eventBus = new EventEmitter();
  }

  register(gatewayFactory, config) {
    const gateway = gatewayFactory(config);
    this.gateways.set(gateway.name, gateway);
  }

  async startAll() {
    for (const gateway of this.gateways.values()) {
      const creds = await credentialVault.resolve(gateway.name);
      try {
        await gateway.start(creds, gateway.config);
        gateway.onEvent((event) => this.eventBus.emit('event', event));
        logger.info(`Gateway ${gateway.name} started`);
      } catch (err) {
        logger.error(`Gateway ${gateway.name} failed to start`, err);
        // Don't crash — other gateways continue
      }
    }
  }

  // Called by orchestrator when a task completes
  async sendReply(event, payload) {
    const gateway = this.gateways.get(event.replyTarget.gateway);
    if (!gateway) throw new Error(`No gateway: ${event.replyTarget.gateway}`);
    return gateway.send(event.replyTarget.target, payload, {
      threadId: event.replyTarget.threadId,
      inReplyTo: event.replyTarget.messageId,
    });
  }

  // Health monitoring (dashboard endpoint)
  async healthAll() {
    const results = {};
    for (const [name, gateway] of this.gateways) {
      results[name] = await gateway.healthCheck();
    }
    return results;
  }
}
```

#### 3.7.4 Credential Vault

**Problem today**: Tokens scattered across env vars, config files, `.secrets`, keychain. OAuth refresh is manual.

**Solution**: Centralized encrypted vault with OAuth lifecycle:

```javascript
class CredentialVault {
  constructor(vaultPath = '~/.config/seal/vault.enc') {
    this.vaultPath = vaultPath;
    this.cipher = new AES256Cipher(this.deriveKey());
  }

  // Store credential (encrypted at rest)
  async store(gatewayName, credential) {
    const vault = await this.loadVault();
    vault[gatewayName] = {
      type: credential.type,           // 'oauth' | 'api_key' | 'app_password'
      data: credential.data,            // Token / key
      expiresAt: credential.expiresAt,
      refreshToken: credential.refreshToken,
      scope: credential.scope,
      updatedAt: new Date().toISOString(),
    };
    await this.saveVault(vault);
  }

  // Resolve credential (auto-refresh if expired)
  async resolve(gatewayName) {
    const vault = await this.loadVault();
    const cred = vault[gatewayName];
    if (!cred) throw new Error(`No credential for ${gatewayName}`);

    if (cred.type === 'oauth' && this.isExpired(cred)) {
      const refreshed = await this.refreshOAuth(gatewayName, cred);
      await this.store(gatewayName, refreshed);
      return refreshed;
    }
    return cred;
  }

  // OAuth refresh per provider
  async refreshOAuth(gatewayName, cred) {
    const provider = OAuthProviders[gatewayName]; // google, microsoft, slack
    return provider.refresh(cred.refreshToken);
  }
}
```

**Benefits**:
- OAuth tokens refresh automatically — no expired-token bugs
- Single place to audit credentials
- Dashboard can show credential status (expired, valid, needs reauth)
- Supports rotation without code changes

---

### 3.8 Google Calendar Gateway

**Use cases**:
1. **Ingest**: Calendar events create SEAL reminders (meetings → prep tasks)
2. **Outbound**: SEAL creates/moves events (reschedule based on workload)
3. **Query**: Agents check availability before scheduling tasks

#### 3.8.1 Implementation

```javascript
// src/gateways/google-calendar.js
export default function createGoogleCalendarGateway(config) {
  return {
    name: 'google-calendar',
    kind: 'calendar',
    direction: 'bidirectional',

    capabilities: {
      ingest: ['event.created', 'event.updated', 'event.reminder'],
      outbound: ['event.create', 'event.update', 'event.delete'],
      query: ['freebusy', 'list'],
    },

    async start(credentials, config) {
      this.client = google.calendar({ version: 'v3', auth: oauth2Client(credentials) });
      // Use Google Calendar push notifications (webhooks) — not polling
      await this.setupWatchChannel(config.calendarId);
    },

    // Webhook receiver (via ingest-server.js extension)
    async handleWebhook(headers, body) {
      const resourceId = headers['x-goog-resource-id'];
      const events = await this.fetchChangedEvents(resourceId);
      for (const event of events) {
        this.emitEvent({
          gateway: 'google-calendar',
          eventId: event.id,
          timestamp: event.updated,
          actor: { id: event.organizer.email, displayName: event.organizer.displayName },
          kind: 'event',
          content: {
            subject: event.summary,
            text: event.description,
            metadata: {
              startTime: event.start.dateTime,
              endTime: event.end.dateTime,
              attendees: event.attendees,
              location: event.location,
              meetLink: event.hangoutLink,
            },
          },
          replyTarget: {
            gateway: 'google-calendar',
            target: event.id,
          },
        });
      }
    },

    // Outbound: create/update/delete events
    async send(target, payload) {
      if (payload.action === 'create') {
        return this.client.events.insert({
          calendarId: 'primary',
          resource: payload.event,
          sendUpdates: 'all',
        });
      }
      // ... update, delete
    },

    // Query: check availability (used by planner agent)
    async freeBusy(timeMin, timeMax) {
      return this.client.freebusy.query({
        resource: { timeMin, timeMax, items: [{ id: 'primary' }] },
      });
    },
  };
}
```

#### 3.8.2 Use Case: Meeting Prep Automation

```
Event: Google Calendar fires webhook — "1:1 with João tomorrow 10am"
  │
  ├─ Gateway emits GatewayEvent (kind: 'event')
  │
  ├─ Orchestrator creates task:
  │   { agent: 'planner', goal: 'Prepare for 1:1 with João' }
  │
  ├─ Planner decomposes:
  │   ├─ Task A: "Fetch recent notes on João" (agent: general, tools: memory)
  │   ├─ Task B: "Pull João's open PRs" (agent: general, tools: github)
  │   ├─ Task C: "Check action items from last 1:1" (agent: general)
  │   └─ Task D: "Draft prep document" (agent: writer, depends_on: A,B,C)
  │
  └─ Task D output sent back via calendar event description OR email
```

#### 3.8.3 Conflict Detection

Agents can query calendar availability before scheduling:

```javascript
// Inside a scheduling agent
const busy = await gatewayManager.query('google-calendar', 'freebusy', {
  timeMin: '2026-04-11T09:00:00Z',
  timeMax: '2026-04-11T17:00:00Z',
});
if (busy.length > 0) {
  // Reschedule or notify user
}
```

---

### 3.9 Email Gateway (Bidirectional)

**Current gap**: `ingest-gmail.js` reads emails via IMAP but CANNOT send replies. Task results from email-originated tasks are lost. No OAuth. No threading. Only one provider.

**Target**: Full bidirectional email with IMAP IDLE (real-time), SMTP sending, OAuth for Gmail/Outlook, thread-aware replies with in-reply-to headers.

#### 3.9.1 Provider Abstraction

```javascript
// src/gateways/email/base.js
class EmailProvider {
  // Real-time ingestion (IMAP IDLE instead of polling)
  async watchInbox(onMessage) { /* abstract */ }

  // Send new email
  async send({ to, subject, body, html, attachments }) { /* abstract */ }

  // Reply to existing thread (preserves threading)
  async reply({ originalMessageId, threadId, body, html }) { /* abstract */ }

  // Mark as read, archive, label
  async updateMessage(messageId, updates) { /* abstract */ }
}

// src/gateways/email/gmail-oauth.js — Gmail via Google API (recommended)
class GmailOAuthProvider extends EmailProvider {
  constructor(credentials) {
    this.gmail = google.gmail({ version: 'v1', auth: oauth2Client(credentials) });
  }

  async watchInbox(onMessage) {
    // Use Gmail push notifications via Pub/Sub
    // Fallback: historyId polling every 60s
    await this.gmail.users.watch({
      userId: 'me',
      resource: { topicName: config.pubsubTopic, labelIds: ['INBOX'] },
    });
  }

  async send({ to, subject, body, html }) {
    const message = this.buildRFC822({ to, subject, body, html });
    return this.gmail.users.messages.send({
      userId: 'me',
      resource: { raw: Buffer.from(message).toString('base64url') },
    });
  }

  async reply({ originalMessageId, body, html }) {
    const original = await this.gmail.users.messages.get({
      userId: 'me',
      id: originalMessageId,
      format: 'metadata',
      metadataHeaders: ['Message-Id', 'Subject', 'From', 'References'],
    });

    const headers = this.extractHeaders(original);
    const message = this.buildRFC822({
      to: headers.From,
      subject: `Re: ${headers.Subject}`,
      body, html,
      inReplyTo: headers['Message-Id'],
      references: [headers.References, headers['Message-Id']].filter(Boolean).join(' '),
    });

    return this.gmail.users.messages.send({
      userId: 'me',
      resource: {
        raw: Buffer.from(message).toString('base64url'),
        threadId: original.data.threadId,  // Preserves Gmail thread
      },
    });
  }
}

// src/gateways/email/imap-smtp.js — Generic IMAP + SMTP (fallback)
class ImapSmtpProvider extends EmailProvider {
  // IMAP IDLE for real-time ingestion
  async watchInbox(onMessage) {
    this.imap = new ImapFlow({ host, port, auth: { user, pass } });
    await this.imap.connect();
    await this.imap.mailboxOpen('INBOX');
    this.imap.on('exists', async (data) => {
      const messages = await this.fetchNew(data.count);
      for (const msg of messages) onMessage(msg);
    });
    await this.imap.idle();  // Real-time, no polling
  }

  // Nodemailer for SMTP
  async send(opts) {
    const transporter = nodemailer.createTransport({ host, port, secure, auth });
    return transporter.sendMail(opts);
  }
}
```

#### 3.9.2 Gmail Gateway (wrapping provider)

```javascript
// src/gateways/gmail.js
export default function createGmailGateway(config) {
  let provider;

  return {
    name: 'gmail',
    kind: 'email',
    direction: 'bidirectional',

    capabilities: {
      ingest: ['message.received'],
      outbound: ['message.send', 'message.reply'],
      threading: true,
      realtime: true,  // IMAP IDLE or push notifications
    },

    async start(credentials, config) {
      provider = credentials.type === 'oauth'
        ? new GmailOAuthProvider(credentials)
        : new ImapSmtpProvider(credentials);

      await provider.watchInbox((rawMessage) => {
        this.emitEvent(this.normalizeToGatewayEvent(rawMessage));
      });
    },

    normalizeToGatewayEvent(rawMessage) {
      return {
        gateway: 'gmail',
        eventId: rawMessage.messageId,
        timestamp: rawMessage.date,
        actor: {
          id: rawMessage.from.address,
          displayName: rawMessage.from.name,
          contact: rawMessage.from.address,
        },
        kind: 'email',
        thread: {
          id: rawMessage.threadId,
          parentEventId: rawMessage.inReplyTo,
        },
        content: {
          subject: rawMessage.subject,
          text: rawMessage.text,
          html: rawMessage.html,
          attachments: rawMessage.attachments,
        },
        replyTarget: {
          gateway: 'gmail',
          target: rawMessage.from.address,
          threadId: rawMessage.threadId,          // Gmail thread
          messageId: rawMessage.messageId,         // For in-reply-to
        },
      };
    },

    async send(target, payload) {
      if (payload.inReplyTo) {
        return provider.reply({
          originalMessageId: payload.inReplyTo,
          body: payload.text,
          html: payload.html,
        });
      }
      return provider.send({
        to: target,
        subject: payload.subject,
        body: payload.text,
        html: payload.html,
      });
    },
  };
}
```

#### 3.9.3 Answering Email: The Full Flow

```
1. Someone emails ulisses@hens.com.br
   "Hey, can you send me the Q1 report?"

2. Gmail gateway (IMAP IDLE) fires event instantly
   GatewayEvent {
     kind: 'email',
     content: { subject: 'Q1 report', text: 'Hey, can you...' },
     replyTarget: { gateway: 'gmail', target: 'sender@...', threadId, messageId }
   }

3. Orchestrator routes to classifier agent
   → Classified as: information request, needs research

4. Router creates task DAG:
   ├─ Task A: "Find Q1 report in ~/projects/seal" (agent: researcher)
   ├─ Task B: "Draft professional email response" (agent: writer, depends_on: A)
   └─ Task C: "Send reply" (agent: general, depends_on: B, tool: gmail.reply)

5. Task C calls gatewayManager.sendReply(originalEvent, {
     text: generatedResponse,
     inReplyTo: originalEvent.replyTarget.messageId,
   })

6. Gmail gateway sends reply with:
   - To: original sender
   - Subject: "Re: Q1 report"
   - In-Reply-To: <original-message-id>
   - References: <original-message-id>
   - threadId: preserves Gmail conversation

7. Reply appears in sender's inbox as part of the original thread
```

#### 3.9.4 Human-in-the-Loop for Email

Email is high-stakes (wrong replies can damage relationships). Default policy:

```json
{
  "policies": {
    "gmail": {
      "auto_reply": {
        "whitelist_senders": ["newsletter@", "notifications@", "github.com"],
        "require_ack_for": ["external", "unknown", "containing:decision"]
      },
      "draft_only_mode": false  // If true, SEAL drafts but never sends
    }
  }
}
```

**Draft-only mode** is the recommended starting point: SEAL composes the reply, stores it as a Gmail draft, and notifies the user via Telegram to review + send.

#### 3.9.5 Provider Matrix

| Provider | Auth | Ingest | Outbound | Real-time | Threading |
|----------|------|--------|----------|-----------|-----------|
| Gmail (OAuth) | OAuth 2.0 | Gmail API + Pub/Sub | Gmail API | ✅ Push | ✅ Native |
| Gmail (IMAP) | App password | IMAP IDLE | SMTP | ✅ IDLE | ⚠️ Headers only |
| Outlook | OAuth 2.0 (Microsoft Graph) | Graph API + Webhooks | Graph API | ✅ Push | ✅ Native |
| Generic IMAP/SMTP | User/pass | IMAP IDLE | SMTP | ✅ IDLE | ⚠️ Headers only |

**Recommendation**: Implement Gmail (OAuth) first (primary use case), then generic IMAP/SMTP as fallback for other providers.

---

### 3.10 Migration: Current Channels → Gateway Layer

The existing `telegram.js`, `discord.js`, `whatsapp.js` work — they just need to be wrapped in the new interface. Not a rewrite, an adapter pattern:

```javascript
// src/gateways/telegram.js (thin wrapper around existing telegram.js)
import { startTelegram, sendTelegramMessage, isTelegramConnected } from '../telegram.js';

export default function createTelegramGateway(config) {
  return {
    name: 'telegram',
    kind: 'chat',
    direction: 'bidirectional',
    capabilities: { ingest: ['message'], outbound: ['message'], realtime: true },

    async start(credentials, config) {
      await startTelegram({
        ...config,
        token: credentials.data.token,
        onMessage: (msg) => this.emitEvent(this.normalize(msg)),
      });
    },

    async send(target, payload) {
      return sendTelegramMessage(target, payload.text);
    },

    async healthCheck() {
      return { healthy: isTelegramConnected(), lastCheck: new Date().toISOString() };
    },

    normalize(telegramMessage) {
      return { /* GatewayEvent shape */ };
    },
  };
}
```

**Migration steps**:
1. Build `GatewayManager` + `Gateway` interface (no behavior change yet)
2. Wrap existing channels as gateways (telegram, discord, whatsapp)
3. Replace `channel-notify.js` switch statement with `gatewayManager.sendReply()`
4. Add Gmail OAuth gateway (first bidirectional provider)
5. Add Google Calendar gateway
6. Deprecate old direct channel imports in `runner.js`

No breaking changes — old `ingest-gmail.js` keeps working until the new Gmail gateway proves stable.

---

## 4. Pattern Adoption Matrix

Summary of which patterns we adopt from each reference codebase:

| Pattern | Source | SEAL Adoption | Priority |
|---------|--------|---------------|----------|
| Generator-based agent loop | Claude Code | Orchestrator loop yields streaming events | P0 |
| Concurrent tool batching | Claude Code | Read-only parallel, stateful serial | P1 |
| Permission layering (deny→ask→allow) | Claude Code | Extend policy engine with classifier | P2 |
| Hook system (pre/post tool) | Claude Code | Add pre/post hooks to agent execution | P2 |
| Subagent spawning with context cloning | Claude Code | Agent Registry + DAG-based decomposition | P0 |
| Feature gating | Claude Code | Feature flags for incremental rollout | P1 |
| Dual memory (MEMORY + USER) | Hermes | Strategy Journal + Agent Profiles | P0 |
| Prefetch → Execute → Sync cycle | Hermes | Core of Learning Layer | P0 |
| Iteration budget | Hermes | Per-agent tool-call limits | P0 |
| Trajectory logging (JSONL) | Hermes | Training data capture | P1 |
| Context compression with hooks | Hermes | on_pre_compress for long-running agents | P2 |
| Frozen system prompt (prefix cache) | Hermes | Prompt caching optimization | P1 |
| InsightsEngine (metrics analysis) | Hermes | FeedbackEngine quality scoring | P1 |
| Memory provider plugin interface | Hermes | Pluggable memory backends | P2 |
| GroupQueue (per-actor + global limit) | Nanoclaw | Tiered concurrency manager | P1 |
| Filesystem IPC (atomic writes) | Nanoclaw | Inter-agent data flow via JSON files | P2 |
| Script-based conditional activation | Nanoclaw | Pre-flight scripts for sensors | P0 |
| Channel registry factory | Nanoclaw | Unified Gateway Manager (§3.7) | P0 |
| OAuth credential vault | Hermes `credential_pool.py` | Centralized vault with auto-refresh (§3.7.4) | P0 |
| IMAP IDLE real-time ingestion | New | Bidirectional email (§3.9) | P1 |
| Gmail push notifications | Google API | Real-time email without polling (§3.9.1) | P1 |
| Google Calendar watch channels | Google API | Event-driven calendar ingestion (§3.8) | P1 |
| Email thread preservation | SMTP headers + Gmail API | Replies maintain conversation context (§3.9) | P1 |
| Draft-only reply mode | New (safety) | Human-in-the-loop for email (§3.9.4) | P0 |
| Streaming marker protocol | Nanoclaw | Real-time output to dashboard | P1 |
| Snapshot visibility | Nanoclaw | Write context snapshots before agent runs | P1 |
| Idle pipelining | Nanoclaw | Keep agents warm for follow-ups | P3 |

---

## 5. Implementation Phases

### Phase 0a: Gateway Foundation (Week 1-2) ⭐ NEW
**Goal**: Professional integration layer without breaking existing channels.

- [ ] Define `Gateway` interface + `GatewayEvent` schema
- [ ] Build `GatewayManager` (lifecycle, event bus, health checks)
- [ ] Build `CredentialVault` with encrypted storage + OAuth refresh
- [ ] Wrap existing channels (telegram, discord, whatsapp) as gateways — adapter pattern, no rewrite
- [ ] Replace `channel-notify.js` switch with `gatewayManager.sendReply()`
- [ ] Dashboard: gateway health panel, credential status

**Result**: Unified integration plane. Existing channels work unchanged. Ready to plug in new providers.

### Phase 0b: Bidirectional Email + Calendar (Week 2-3) ⭐ NEW
**Goal**: Two-way email and calendar integration.

- [ ] Implement `EmailProvider` interface (`GmailOAuthProvider`, `ImapSmtpProvider`)
- [ ] Build Gmail Gateway (OAuth, push notifications or IMAP IDLE)
- [ ] Wire reply threading (in-reply-to headers, Gmail threadId)
- [ ] Build Google Calendar Gateway (watch channels, freebusy, create/update events)
- [ ] Implement draft-only reply mode (safety default)
- [ ] Add email auto-reply policies (whitelist + require_ack)
- [ ] Deprecate `ingest-gmail.js` once Gmail gateway proves stable

**Result**: SEAL can read AND answer emails. Calendar events trigger prep tasks. OAuth handled cleanly.

### Phase 0: Foundation (Week 3-4)
**Goal**: Learning layer without breaking existing task execution.

- [ ] Add `strategy_journal` and `agent_profiles` tables to SQLite schema
- [ ] Implement `FeedbackEngine.record()` — called after every task_run
- [ ] Extend `memory.js` prefetch to include strategy journal lookups
- [ ] Add trajectory logging (JSONL file alongside memory.jsonl)
- [ ] Wire prefetch→inject→sync cycle into existing executor

**Result**: Every task execution now builds institutional knowledge. Zero breaking changes.

### Phase 1: Agent Registry (Week 5-6)
**Goal**: Typed agents instead of raw `claude -p`.

- [ ] Define `AgentDefinition` schema and `AgentRegistry` class
- [ ] Create 3 built-in agents: `general`, `code-reviewer`, `planner`
- [ ] Add `agent_name` column to tasks table
- [ ] Extend executor to resolve agent → build prompt → apply constraints
- [ ] Add iteration budget tracking per execution

**Result**: Tasks can target specific agents. Agents have bounded resources.

### Phase 2: Orchestrator Loop (Week 7-8)
**Goal**: Generator-based execution with streaming.

- [ ] Rewrite runner.js core loop as async generator
- [ ] Add WebSocket endpoint to dashboard server
- [ ] Stream orchestrator phases to dashboard in real-time
- [ ] Add cancellation support (check task.status mid-execution)
- [ ] Implement exponential backoff retry for transient failures

**Result**: Dashboard shows live agent execution. Users can cancel mid-run.

### Phase 3: Task Graph (Week 9-10)
**Goal**: DAG-based task dependencies and goal decomposition.

- [ ] Add `task_edges` table and `TaskGraph` class
- [ ] Implement `getReadyTasks()` — replaces simple `WHERE status='pending'`
- [ ] Build `planner` agent that decomposes goals into subtask DAGs
- [ ] Add `onTaskComplete` cascade (unblock dependents, pass data)
- [ ] Dashboard: interactive DAG visualization

**Result**: Complex multi-step workflows execute as coordinated task graphs.

### Phase 4: Dashboard Control Plane (Week 11-12)
**Goal**: Full control through the web UI.

- [ ] Agent registry management (enable/disable, configure)
- [ ] Memory explorer (strategy journal, agent profiles, quality trends)
- [ ] Policy editor (visual rule builder)
- [ ] Manual goal decomposition (user draws task DAGs)
- [ ] Analytics dashboard (agent effectiveness, cost tracking)

**Result**: Dashboard is the primary interface for managing SEAL agents.

### Phase 5: Advanced Learning (Week 13-14)
**Goal**: Self-improving agent selection and prompt optimization.

- [ ] Pattern detector: identify recurring failures across task types
- [ ] Auto-strategy selection: use quality scores to pick best approach
- [ ] Prompt A/B testing: try variations, track which works better
- [ ] Agent recommendation: suggest best agent based on task + history
- [ ] Context compression hooks for long-running agents

**Result**: SEAL gets measurably better at tasks over time without manual tuning.

---

## 6. Data Flow Example

**User sends via Telegram**: "Review all PRs in the seal project and summarize findings"

```
1. INGEST
   Telegram channel → classify → create task:
   { type: 'task', summary: 'Review all PRs in seal', project: 'seal',
     goal: 'Review all open PRs and summarize findings' }

2. ORCHESTRATE
   Orchestrator picks up task → detects goal → routes to 'planner' agent

3. DECOMPOSE (planner agent)
   planner → creates subtask DAG:
   ├─ Task A: "List open PRs" (agent: general)
   ├─ Task B: "Review PR #12" (agent: code-reviewer, depends_on: A)
   ├─ Task C: "Review PR #15" (agent: code-reviewer, depends_on: A)
   └─ Task D: "Summarize all reviews" (agent: writer, depends_on: B,C)

4. EXECUTE (DAG engine)
   A runs → completes → B and C unblocked → run in parallel →
   both complete → D unblocked → runs with B+C output as input

5. LEARN
   Each subtask: prefetch memories → execute → sync outcomes
   FeedbackEngine: records strategy, updates agent profiles
   Strategy journal: "code-reviewer effective on seal PRs, avg 3min"

6. NOTIFY
   Telegram: "Reviewed 2 PRs. PR #12: approved. PR #15: 2 issues found.
              Full summary: [link to dashboard]"
```

---

## 7. Migration Strategy

### Backward Compatibility

All changes are additive. Existing tasks continue to work:

- Tasks without `agent_name` default to `'general'` (current behavior)
- Tasks without `task_edges` execute independently (current behavior)
- Memory prefetch gracefully degrades if strategy journal is empty
- Dashboard keeps all existing endpoints; new ones are additive

### Database Migration

```sql
-- Phase 0: Learning tables
CREATE TABLE IF NOT EXISTS strategy_journal (...);
CREATE TABLE IF NOT EXISTS agent_profiles (...);
CREATE TABLE IF NOT EXISTS trajectories (...);

-- Phase 1: Agent support
ALTER TABLE tasks ADD COLUMN agent_name TEXT DEFAULT 'general';

-- Phase 3: Task graph
CREATE TABLE IF NOT EXISTS task_edges (...);
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
ALTER TABLE tasks ADD COLUMN input_data JSON;
ALTER TABLE tasks ADD COLUMN output_data JSON;
ALTER TABLE tasks ADD COLUMN goal TEXT;
```

All migrations are `CREATE IF NOT EXISTS` or `ADD COLUMN` — safe to run on existing databases.

---

## 8. Open Questions

1. **SDK vs subprocess**: Should we adopt Claude Agent SDK directly for lower overhead, or keep subprocess isolation for safety? Could do both (SDK for trusted agents, subprocess for untrusted).

2. **Multi-model support**: Should agents be able to use different LLM providers (Hermes supports OpenRouter, Anthropic, OpenAI)? Or keep it Claude-only for simplicity?

3. **Container isolation**: Is Nanoclaw-style Docker/Apple Container isolation worth the complexity for SEAL's use case? Or is macOS sandbox-exec sufficient?

4. **Federated execution**: Should SEAL support multi-machine execution (already has Turso for cloud DB)? Or keep it single-node?

5. **Training loop**: Hermes has trajectory logging for fine-tuning. Should SEAL invest in this, or is prompt-based learning (strategy journal) sufficient?

6. **Flow engine integration**: Current flow engine (YAML-based) should be migrated to task graph, or kept as a separate execution mode?

---

## 9. Success Metrics

| Metric | Current | Target (6 months) |
|--------|---------|-------------------|
| Task types supported | 7 (flat) | 7 + DAG compositions |
| Concurrent execution | 4 fixed slots | 2 heavy + 6 light (tiered) |
| Cross-task learning | None | Strategy journal + agent profiles |
| Agent specialization | 1 (generic claude -p) | 5+ specialized agents |
| Goal decomposition | Manual only | Automatic via planner agent |
| Dashboard capabilities | Read-only task list | Full control plane |
| Mean time to improve | Never (no feedback) | Measurable per-agent quality trend |
| Streaming output | Post-completion only | Real-time via WebSocket |
| Email direction | Read-only (IMAP polling) | Bidirectional (Gmail OAuth + SMTP) |
| Integration auth | Fragmented (env, .secrets, keychain) | Centralized vault with OAuth refresh |
| Gateway abstraction | 5 independent channel files | Unified `Gateway` interface + manager |
| Calendar integration | None | Google Calendar (ingest + create + freebusy) |
| Real-time email | No (30-300s polling) | Yes (IMAP IDLE or Gmail push) |
| Email threading | Broken (no in-reply-to) | Preserved (Gmail threadId + headers) |

---

## Appendix A: Reference Codebase Summary

### Claude Code (~/projects/claudecode)
- **Key insight**: Generator-based agent loop enables streaming, cancellation, and composability
- **Adopt**: queryLoop pattern, tool batching, permission layering, hook system
- **Skip**: Feature gating complexity (SEAL is simpler), coordinator mode (over-engineered for our needs)

### Hermes Agent (~/projects/hermes-agent)
- **Key insight**: Dual-memory + prefetch/sync cycle enables genuine cross-session learning
- **Adopt**: MemoryProvider interface, iteration budget, trajectory logging, InsightsEngine
- **Skip**: Multi-provider model management (keep it Claude-only for now), frozen system prompt (not needed without prefix caching)

### Nanoclaw (~/projects/nanoclaw)
- **Key insight**: Per-actor queue with global concurrency limit is the right concurrency model
- **Adopt**: GroupQueue pattern, script-based activation, streaming markers, filesystem IPC
- **Skip**: Container isolation (macOS sandbox sufficient), session persistence (SEAL uses SQLite)
