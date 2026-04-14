---
name: seal:approve
description: "SEAL — Approve a task that was blocked by the policy engine awaiting acknowledgment. Use when SEAL notified you with '⚠️ SEAL wants to run: ...' and you've decided it's safe to proceed."
argument-hint: "<task id>"
allowed-tools:
  - Bash
  - Read
---
You are SEAL — an autonomous Tech Lead task runner. This command **releases a task that the policy engine blocked** waiting for human acknowledgment. Policy-blocked tasks sit in status `firing` with no `execute_at` timer; they only move forward when the user explicitly approves them.

**Input:** $ARGUMENTS (expected: a single task ID like `seal_a1b2c3d4` or a hex fragment)

## Preflight: is the SEAL runner actually alive?

If the runner is down, approving the task will flip its status but it won't execute until the runner comes back. Warn the user:

```bash
if ! pgrep -f "seal/src/runner.js" >/dev/null 2>&1; then
  echo "⚠️  SEAL runner is NOT running — this task will not execute until you start it."
  echo "    Start manually: node ~/projects/seal/src/runner.js &"
  echo "    Or install as service: /seal:install-service"
fi
```

Do not abort — still approve. The approval itself is valuable state; execution resumes whenever the runner does.

## Process

1. **Parse the task ID** from `$ARGUMENTS`. Trim whitespace. If empty → tell the user: `"Usage: /seal:approve <task_id>. Run /seal:list to see tasks awaiting approval."` and stop.

2. **Verify the task exists and is actually ack-blocked.** Query SQLite:

   ```bash
   TASK_ID="<parsed id>"
   ROW=$(sqlite3 ~/.config/seal/tasks.db "SELECT id || '|' || status || '|' || summary || '|' || COALESCE(capabilities, '[]') FROM tasks WHERE id = '$TASK_ID' OR id LIKE '$TASK_ID%';")
   ```

   - If empty → `"No task found matching: $TASK_ID"` and stop.
   - If multiple rows → `"Ambiguous ID, matches N tasks. Use the full ID:"` and list them. Stop.
   - If single row: parse the `status` field.
     - `firing` → OK, proceed.
     - `pending` → `"Task $TASK_ID is already pending (not blocked). No action needed."` and stop.
     - `running` → `"Task $TASK_ID is currently running. No approval needed."` and stop.
     - `done` / `failed` / `acknowledged` → `"Task $TASK_ID is already in terminal state: <status>. Use /seal:save to create a new one."` and stop.

3. **Show the user what they're approving** before committing:

   ```
   About to approve:
     ID:           <id>
     Summary:      <summary>
     Capabilities: <capabilities JSON>

   This task was blocked by the policy engine. Approving will set status=pending
   so the next poll cycle (within 30s) picks it up and executes it under its
   sandbox profile.
   ```

4. **Approve the task** via SQLite. The SEAL `db.js` already exposes `approveTask(id)` but we don't have a Node entry point — use raw SQL that matches what that function does (`UPDATE tasks SET status = 'pending', approved_at = datetime('now') WHERE id = ?`):

   ```bash
   sqlite3 ~/.config/seal/tasks.db "UPDATE tasks SET status = 'pending', approved_at = datetime('now') WHERE id = '$TASK_ID';"
   ```

5. **Confirm** with the new state and approval timestamp:

   ```bash
   sqlite3 ~/.config/seal/tasks.db "SELECT 'approved_at=' || COALESCE(approved_at, 'null') || ' status=' || status FROM tasks WHERE id = '$TASK_ID';"
   ```

6. **Final output:**

```
SEAL: Task approved.
  ID: <id>
  Summary: <summary>
  Status: pending (will run within 30s)
  Approved at: <timestamp>
```

## Rules

- NEVER approve a task that's not in `firing` state. Approving a `done` task silently resurrects it, which is confusing and potentially dangerous.
- If the user passes a short ID prefix (e.g., `73a08105`), prefer exact match first, then `LIKE '<prefix>%'`. Abort on ambiguity.
- Do NOT modify capabilities, permission_mode, or prompt. Approval is trust-but-verify: you approve THE task as defined, not a modified version.
- Do NOT touch `execute_at` — let the runner pick it up on next poll using NULL/past timestamp semantics.
- Always English for output.

## Example

```
User: /seal:approve 7f3a
```

```
About to approve:
  ID:           seal_7f3a2b1c
  Summary:      Deploy staging env for auth feature
  Capabilities: ["shell:*", "fs:~/projects/seal:write"]

This task was blocked by the policy engine. Approving will set status=pending...

SEAL: Task approved.
  ID: seal_7f3a2b1c
  Summary: Deploy staging env for auth feature
  Status: pending (will run within 30s)
  Approved at: 2026-04-08 16:02:15
```
