---
name: seal:uninstall-service
description: Uninstall the SEAL launchd service (stops auto-start on reboot)
allowed-tools:
  - Bash
---
<objective>
Remove the SEAL launchd service so it no longer auto-starts on login. Does not delete SEAL itself or its data.
</objective>

<process>

## 1. Confirm with user

```
This will:
  1. Stop the running SEAL service
  2. Unload it from launchctl
  3. Delete ~/Library/LaunchAgents/com.hens.seal.plist

Your tasks database (~/.config/seal/tasks.db) and config will NOT be deleted.

Continue? (yes/no)
```

Wait for explicit "yes".

## 2. Unload and delete

```bash
PLIST_PATH="$HOME/Library/LaunchAgents/com.hens.seal.plist"

if [ ! -f "$PLIST_PATH" ]; then
  echo "SEAL: No service installed at $PLIST_PATH"
  exit 0
fi

UID_NUM=$(id -u)
launchctl bootout "gui/$UID_NUM/com.hens.seal" 2>/dev/null || launchctl unload "$PLIST_PATH" 2>/dev/null || true
rm "$PLIST_PATH"
```

## 3. Verify

```bash
launchctl list | grep com.hens.seal && echo "Still running — manual cleanup needed" || echo "SEAL: Service uninstalled."
```

## 4. Report

```
SEAL: Service uninstalled.
- Plist removed from ~/Library/LaunchAgents/
- Auto-start on login: disabled
- Database and config preserved at ~/.config/seal/

To run SEAL manually: seal-run
To reinstall service: /seal:install-service
```
</process>
