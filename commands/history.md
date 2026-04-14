---
name: seal:history
description: Show recently completed SEAL tasks
allowed-tools:
  - Bash
---
<objective>
Display recently completed, acknowledged, or failed tasks.
</objective>

<process>
Run:

```bash
sqlite3 -header -column ~/.config/seal/tasks.db "SELECT id, type, summary, status, completed_at FROM tasks WHERE status IN ('done','acknowledged','failed') ORDER BY completed_at DESC LIMIT 20;"
```

If no results, say: "SEAL: No completed tasks yet."

Otherwise, display the table and count.
</process>
