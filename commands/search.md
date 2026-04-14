---
name: seal:search
description: Search SEAL tasks by keyword, person, or project
argument-hint: "<query>"
allowed-tools:
  - Bash
---
<objective>
Search tasks in SQLite by keyword match across summary, detail, and people fields.
</objective>

<process>
**Input:** $ARGUMENTS (search query)

If no query provided, ask what to search for.

Otherwise, run:

```bash
sqlite3 -header -column ~/.config/seal/tasks.db "SELECT id, type, summary, status, execute_at FROM tasks WHERE summary LIKE '%$ARGUMENTS%' OR detail LIKE '%$ARGUMENTS%' OR people LIKE '%$ARGUMENTS%' ORDER BY created DESC LIMIT 20;"
```

Display results. If empty, say: "SEAL: No tasks matching '$ARGUMENTS'."
</process>
