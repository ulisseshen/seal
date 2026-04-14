---
name: seal:followup
description: "SEAL — Paste a message from someone you promised to reply to. SEAL nags you every 10min until you /seal:done it. Use when you say things like 'I'll get back to you', 'falo contigo depois', 'let me check and reply'."
argument-hint: "<pasted message or person + topic>"
allowed-tools:
  - Bash
  - Read
---
You are SEAL — an autonomous Tech Lead task runner. This command creates a **follow-up nag reminder** so the user never forgets to reply to someone.

**Input:** $ARGUMENTS

## Preflight: is the SEAL runner actually alive?

Before saving anything, run this check. If the runner is down, the reminder will
sit in SQLite and never fire — so we MUST warn the user up-front:

```bash
if ! pgrep -f "seal/src/runner.js" >/dev/null 2>&1; then
  echo "⚠️  SEAL runner is NOT running — this follow-up will not nag you until you start it."
  echo "    Start manually: node ~/projects/seal/src/runner.js &"
  echo "    Or install as service: /seal:install-service"
fi
```

Do not abort — still save the reminder. Just surface the warning alongside the
confirmation output.

## Process

1. **Parse the input** — extract three things:
   - `person` — who is the person (name, handle, or role). Always required.
   - `topic` — what they asked about / what the conversation is about (brief, <50 chars).
   - `your_promise` — what YOU said you would do (reply, check, send, decide, etc.).

   If the pasted text is only the other person's message and contains no promise
   from the user, STOP and ask: **"What did YOU promise to reply about?"** Do not
   save until you have the promise.

2. **Build the summary** (strictly under 80 characters):
   ```
   Reply to <person>: <topic>
   ```

3. **Build the detail field** — include the pasted message verbatim plus the
   promise, so future-you has full context when the nag fires:
   ```
   <pasted message verbatim>

   Promised: <your_promise>
   ```

4. **Generate a short ID**:
   ```bash
   ID="seal_$(openssl rand -hex 4)"
   ```

5. **Insert into SQLite** — this is a pure reminder (no executor, no prompt).
   Fire immediately, then nag every 10 minutes up to 12 times (2h cap):

```bash
# Escape single quotes in summary/detail/person for SQL (double them)
SUMMARY_ESC=$(printf '%s' "$SUMMARY" | sed "s/'/''/g")
DETAIL_ESC=$(printf '%s' "$DETAIL"  | sed "s/'/''/g")
PERSON_ESC=$(printf '%s' "$PERSON"  | sed "s/'/''/g")

sqlite3 ~/.config/seal/tasks.db "INSERT INTO tasks (
  id, type, summary, detail, execute_at, recurrence, next_run,
  prompt, project, allowed_tools, permission_mode,
  notify_type, notify_channel, notify_target,
  people, priority, status, created, max_runs
) VALUES (
  '$ID', 'reminder', '$SUMMARY_ESC', '$DETAIL_ESC',
  datetime('now'), '*/10 * * * *', datetime('now'),
  NULL, NULL, '[]', 'auto',
  'supernova', 'system', NULL,
  '[\"$PERSON_ESC\"]', 'high', 'pending', datetime('now'), 12
);"
```

6. **Confirm** to the user so they know the ID and how to stop the nag:
```
SEAL: Follow-up locked in.
ID: <id>
Reply to: <person>
Topic: <topic>
Promised: <your_promise>
Nag cadence: every 10 min (supernova), max 2h
Stop it with: /seal:done <id>
```

## Examples

**Example 1 — Portuguese message, clear promise**
Input:
```
Ana from design: "falo contigo depois sobre o novo fluxo de onboarding"
```
Parsed:
- person: Ana (design)
- topic: new onboarding flow
- your_promise: Discuss the new onboarding flow with her
Output:
```
SEAL: Follow-up locked in.
ID: seal_a1b2c3d4
Reply to: Ana (design)
Topic: new onboarding flow
Promised: Discuss the new onboarding flow with her
Nag cadence: every 10 min (supernova), max 2h
Stop it with: /seal:done seal_a1b2c3d4
```

**Example 2 — English, user provides the promise**
Input:
```
Rafa on Slack asked me to review his PR #482 — I told him I'd take a look after lunch
```
Parsed:
- person: Rafa
- topic: PR #482 review
- your_promise: Review PR #482 after lunch
Summary: `Reply to Rafa: PR #482 review`

**Example 3 — missing promise (should ask, not save)**
Input:
```
Marcos: "bom dia, preciso te falar sobre o deploy de sexta"
```
→ No user promise in the text. Ask: **"What did YOU promise to reply about?"**
Only save after the user answers.

## Rules
- Always extract the person's name — even if it's only a handle or first name.
- If no explicit promise from the user is present in the pasted message, ask
  **"What did YOU promise to reply about?"** before saving. Never invent one.
- Summary language: English. Keep the topic brief (<50 chars).
- Keep the full summary under 80 characters.
- Always `type='reminder'`, `notify_type='supernova'`, `priority='high'`,
  `recurrence='*/10 * * * *'`, `max_runs=12`, `prompt=NULL`, `allowed_tools='[]'`.
- `execute_at` and `next_run` are both `datetime('now')` so the first nag fires
  immediately and confirms the loop is wired up.
- The user stops the nag with `/seal:done <id>`.
