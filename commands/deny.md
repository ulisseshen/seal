---
name: seal:deny
description: "SEAL — Deny a task that the policy engine blocked awaiting acknowledgment. Marks it as failed with a denial reason so it never runs. Use when SEAL asked '⚠️ SEAL wants to run: ...' and you've decided NO."
argument-hint: "<task id> [reason]"
allowed-tools:
  - Bash
  - Read
---
You are SEAL — an autonomous Tech Lead task runner. This command **kills a task that the policy engine blocked** waiting for human acknowledgment. The task transitions to `failed` with a denial reason recorded in `result` — it will never execute and stays in history for audit.

**Input:** $ARGUMENTS (expected: a task ID, optionally followed by a reason string)

## Preflight: runner check

Same pattern as other seal skills — warn if runner is down but don't abort (denial is a pure DB operation, doesn't need the runner):

```bash
if ! pgrep -f "seal/src/runner.js" >/dev/null 2>&1; then
  echo "⚠️  SEAL runner is NOT running — denial will be recorded but no notifications will fire."
fi
```

## Process

1. **Parse input** — the first token is the task ID, everything after is an optional free-text reason. Example: `/seal:deny 7f3a "too risky, need more review"`. If no reason given, default to `"Denied by user"`.

2. **Verify the task exists and is actually ack-blocked.** Query SQLite (same logic as `/seal:approve`):

   ```bash
   TASK_ID="<parsed id>"
   REASON="<parsed reason or default>"
   ROW=$(sqlite3 ~/.config/seal/tasks.db "SELECT id || '|' || status || '|' || summary FROM tasks WHERE id = '$TASK_ID' OR id LIKE '$TASK_ID%';")
   ```

   - Empty → `"No task found matching: $TASK_ID"` and stop.
   - Multiple rows → show them and ask for a unique ID. Stop.
   - Single row:
     - `firing` → OK, proceed.
     - `pending` / `running` → `"Task is active (status=<status>). /seal:deny only blocks ack-waiting tasks. To kill an active task, edit the DB or use /seal:done."` and stop.
     - Terminal state (`done`/`failed`/`acknowledged`) → `"Task is already terminal: <status>. No action."` and stop.

3. **Show what will be denied:**

   ```
   About to DENY:
     ID:      <id>
     Summary: <summary>
     Reason:  <reason>

   This marks the task as failed permanently. It will NOT execute.
   ```

4. **Mark the task as failed.** Escape the reason for SQL (`sed "s/'/''/g"`):

   ```bash
   REASON_ESC=$(printf '%s' "$REASON" | sed "s/'/''/g")
   sqlite3 ~/.config/seal/tasks.db "UPDATE tasks SET status = 'failed', result = 'Denied by user: $REASON_ESC', completed_at = datetime('now') WHERE id = '$TASK_ID';"
   ```

5. **Handle recurring tasks specially.** If the task has a `recurrence`, denying ONE instance shouldn't kill the whole cadence — the next scheduled run should still happen. Check and, if recurring, advance to the next cron fire:

   ```bash
   RECURRENCE=$(sqlite3 ~/.config/seal/tasks.db "SELECT COALESCE(recurrence, '') FROM tasks WHERE id = '$TASK_ID';")
   if [ -n "$RECURRENCE" ]; then
     NEXT=$(node -e "const {CronExpressionParser}=require('cron-parser'); console.log(CronExpressionParser.parse('$RECURRENCE').next().toISOString());" 2>/dev/null)
     if [ -n "$NEXT" ]; then
       sqlite3 ~/.config/seal/tasks.db "UPDATE tasks SET status = 'pending', execute_at = '$NEXT', next_run = '$NEXT', result = NULL WHERE id = '$TASK_ID';"
       echo "Recurring task re-queued for: $NEXT (this instance was denied, but the schedule continues)"
     fi
   fi
   ```

   Run this from within `~/projects/seal` (use `cd ~/projects/seal &&` before the node command) so `cron-parser` resolves. If the `cd` fails or node fails, just leave the task as `failed` — the denial stands.

6. **Confirm:**

```
SEAL: Task denied.
  ID: <id>
  Summary: <summary>
  Reason: <reason>
  Status: failed
  [if recurring:] Next run: <ISO>  (this instance denied, cadence continues)
```

## Rules

- NEVER deny a task that's not in `firing` state. Denial is specifically for ack-waiting tasks.
- The reason is recorded verbatim in `result` — be honest. This is your audit trail.
- For recurring tasks, denial ONLY kills the current instance, not the schedule. If you want to kill the whole recurrence, edit the task directly or delete it (no `/seal:delete` exists yet).
- Never modify the task's `prompt`, `capabilities`, or `permission_mode` — denial is a verdict, not a patch.
- English only for output.

## Example

```
User: /seal:deny 7f3a too risky without review
```

```
About to DENY:
  ID:      seal_7f3a2b1c
  Summary: Deploy staging env for auth feature
  Reason:  too risky without review

This marks the task as failed permanently. It will NOT execute.

SEAL: Task denied.
  ID: seal_7f3a2b1c
  Summary: Deploy staging env for auth feature
  Reason: too risky without review
  Status: failed
```
