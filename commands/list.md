---
name: seal:list
description: List active SEAL tasks (pending, running, firing)
allowed-tools:
  - Bash
---
<objective>
List all active SEAL tasks from SQLite.
</objective>

<process>
Run:

```bash
sqlite3 -header -column ~/.config/seal/tasks.db "SELECT id, type, summary, priority, status, execute_at, recurrence FROM tasks WHERE status IN ('pending','running','firing') ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, execute_at ASC;"
```

If no results, say: "SEAL: No active tasks. Standing by."

Otherwise, display the table and a count: "SEAL: X active tasks."
</process>
