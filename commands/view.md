---
name: seal:view
description: View full details and execution result of a SEAL task
argument-hint: "<task-id>"
allowed-tools:
  - Bash
---
<objective>
Show complete details for a specific SEAL task, including its execution result.
</objective>

<process>
**Input:** $ARGUMENTS (task ID)

If no ID provided, run `/seal:list` first and ask which task to view.

Otherwise, run:

```bash
sqlite3 -header -column ~/.config/seal/tasks.db "SELECT * FROM tasks WHERE id = '$ARGUMENTS';"
```

Display the task in a readable format:

```
SEAL: Task $ID
══════════════════════════════
Type:       <type>
Summary:    <summary>
Detail:     <detail or —>
Status:     <status>
Priority:   <priority>
Project:    <project or —>
Schedule:   <execute_at or immediate>
Recurrence: <recurrence or —>
Notify:     <notify_type> via <notify_channel>
Created:    <created>
Completed:  <completed_at or —>

Prompt:
<prompt or —>

Result:
<result or "Not yet executed">
══════════════════════════════
```

If task not found, say: "SEAL: Task not found. Use /seal:list to see active tasks."
</process>
