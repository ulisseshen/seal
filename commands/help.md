---
name: seal:help
description: Show available SEAL commands and quick reference
---
<objective>
Display the complete SEAL command reference. Output ONLY the reference below — no project analysis, no git status, no suggestions.
</objective>

<process>
Output this reference exactly:

```
SEAL — Autonomous Tech Lead Task Runner
════════════════════════════════════════

COMMANDS:

  /seal <text>           Save a task/reminder (default action)
  /seal:save <text>      Save a task/reminder (explicit)
  /seal:list             List active tasks (pending, running, firing)
  /seal:view <id>        View full task details and execution result
  /seal:search <query>   Search tasks by keyword, person, or project
  /seal:done <query>     Mark a task as done/acknowledged
  /seal:history          Show recently completed tasks
  /seal:help             Show this reference
  /seal:update           Update SEAL and re-deploy skills/commands
  /seal:install-service  Install SEAL as auto-start launchd service (opt-in)
  /seal:uninstall-service  Remove the launchd service

EXAMPLES:

  /seal run tests on valenty tomorrow at 9am
  /seal remind me 1:1 with Ana every Tuesday at 10am
  /seal MUST review security audit by Wednesday
  /seal:list
  /seal:view a1b2c3d4
  /seal:search João
  /seal:done deploy reminder

TASK TYPES: task, reminder, ritual, deadline, person, decision
NOTIFY LEVELS: silent, sound, sticky, nuclear, supernova
CHANNELS: Claude Code, Telegram, Discord, WhatsApp, Email

Database: ~/.config/seal/tasks.db
Config:   ~/.config/seal/ingest.json
Secrets:  ~/.config/seal/.secrets
```
</process>
