---
name: seal:update
description: Update SEAL to latest version and re-install commands/skills
allowed-tools:
  - Bash
  - Read
  - Write
---
<objective>
Pull the latest SEAL code from GitHub, reinstall dependencies, and re-deploy all skills and commands to their correct locations.
</objective>

<process>

## 1. Pull latest code

```bash
cd ~/projects/seal && git pull origin main
```

If there are local changes, stash them first:
```bash
cd ~/projects/seal && git stash && git pull origin main && git stash pop
```

## 2. Install dependencies

```bash
cd ~/projects/seal && npm install
```

## 3. Re-deploy skill (for /seal default action)

```bash
mkdir -p ~/.claude/skills/seal
cp ~/projects/seal/skill/SKILL.md ~/.claude/skills/seal/SKILL.md
```

## 4. Re-deploy commands (for /seal:* subcommands)

The repo has a `commands/` directory with all command definitions. Deploy them:

```bash
mkdir -p ~/.claude/commands/seal
cp ~/projects/seal/commands/*.md ~/.claude/commands/seal/
echo "Deployed $(ls ~/projects/seal/commands/*.md | wc -l | tr -d ' ') commands"
```

## 5. Re-deploy to other runtimes (if installed)

```bash
# Codex
if [ -d ~/.agents/skills ]; then
  mkdir -p ~/.agents/skills/seal
  cp ~/projects/seal/skill/SKILL.md ~/.agents/skills/seal/SKILL.md
  echo "[update] Codex skill updated"
fi

# Antigravity
if [ -d ~/.gemini/antigravity/skills ]; then
  mkdir -p ~/.gemini/antigravity/skills/seal
  cp ~/projects/seal/skill/SKILL.md ~/.gemini/antigravity/skills/seal/SKILL.md
  echo "[update] Antigravity skill updated"
fi

# Cursor
if [ -d ~/.cursor/rules ]; then
  cp ~/projects/seal/skills/cursor/seal.mdc ~/.cursor/rules/seal.mdc 2>/dev/null
  echo "[update] Cursor rule updated"
fi
```

## 6. Show changelog

```bash
cd ~/projects/seal && git log --oneline -10
```

## 7. Report

```
SEAL: Updated successfully.
- Code: pulled latest from main
- Dependencies: npm install complete
- Skills: re-deployed to all detected runtimes
- Commands: re-deployed /seal:* subcommands

Restart SEAL runner to apply: seal-run
```

If any step fails, report the error clearly and continue with remaining steps.
</process>
