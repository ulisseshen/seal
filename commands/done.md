---
name: seal:done
description: Mark a SEAL task as done or acknowledge a firing reminder
argument-hint: "<task-id or keyword>"
allowed-tools:
  - Bash
---
<objective>
Mark a task as acknowledged/done by ID or keyword match.
</objective>

<process>
**Input:** $ARGUMENTS (task ID or keyword)

If no argument provided, run `/seal:list` first and ask which task to complete.

Otherwise, run:

```bash
sqlite3 ~/.config/seal/tasks.db "UPDATE tasks SET status='acknowledged', completed_at=datetime('now') WHERE (status='firing' OR status='pending' OR status='running') AND (summary LIKE '%$ARGUMENTS%' OR id='$ARGUMENTS');"
```

Then verify what was updated:

```bash
sqlite3 -header -column ~/.config/seal/tasks.db "SELECT id, summary, status FROM tasks WHERE (summary LIKE '%$ARGUMENTS%' OR id='$ARGUMENTS') AND status='acknowledged' ORDER BY completed_at DESC LIMIT 5;"
```

Confirm: "SEAL: Mission acknowledged — '<matching summary>'"

If nothing matched, say: "SEAL: No matching active task found for '$ARGUMENTS'."
</process>
