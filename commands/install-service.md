---
name: seal:install-service
description: Install SEAL as a launchd service so it auto-starts on login and survives reboots
allowed-tools:
  - Bash
  - Read
  - Write
---
<objective>
Install SEAL as a macOS launchd user agent so the runner starts automatically on login and is restarted automatically if it crashes. This is opt-in — only run when the user explicitly asks.
</objective>

<process>

## 1. Detect environment

```bash
NODE_BIN=$(which node)
SEAL_DIR="$HOME/projects/seal"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/com.hens.seal.plist"
TEMPLATE="$SEAL_DIR/scripts/com.hens.seal.plist.template"

echo "Node: $NODE_BIN"
echo "SEAL: $SEAL_DIR"
echo "Plist will be installed at: $PLIST_PATH"
```

If `$NODE_BIN` is empty or `$SEAL_DIR` doesn't exist, abort with a clear error.

## 2. Confirm with the user

Show what will happen:
```
This will:
  1. Generate ~/Library/LaunchAgents/com.hens.seal.plist
  2. Load it via launchctl (starts SEAL immediately)
  3. SEAL will auto-start on every login and restart on crash
  4. Logs go to ~/.config/seal/seal.log and ~/.config/seal/seal.err.log

Continue? (yes/no)
```

Wait for explicit "yes" before proceeding.

## 3. Stop any running SEAL instance

```bash
# Kill any existing runner processes
pkill -f "seal/src/runner.js" 2>/dev/null || true

# Unload existing service if present
launchctl unload "$PLIST_PATH" 2>/dev/null || true
```

## 4. Generate the plist from template

```bash
mkdir -p "$PLIST_DIR"
mkdir -p "$HOME/.config/seal"

sed \
  -e "s|__NODE_PATH__|$NODE_BIN|g" \
  -e "s|__SEAL_PATH__|$SEAL_DIR|g" \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__PATH__|$PATH|g" \
  "$TEMPLATE" > "$PLIST_PATH"

chmod 644 "$PLIST_PATH"
```

## 5. Load the service

Use modern `bootstrap` + `kickstart` so the runner actually starts immediately
(legacy `launchctl load` can silently leave the job in a not-yet-running state
if another instance was previously registered under the same label).

```bash
UID_NUM=$(id -u)

# Unregister any stale job under this label first
launchctl bootout "gui/$UID_NUM/com.hens.seal" 2>/dev/null || true

# Register the new plist
launchctl bootstrap "gui/$UID_NUM" "$PLIST_PATH"

# Force-start the job right now (don't wait for next login)
launchctl kickstart -k "gui/$UID_NUM/com.hens.seal"
```

## 6. Verify it started

Wait 2 seconds, then check:

```bash
sleep 2
launchctl print "gui/$UID_NUM/com.hens.seal" 2>/dev/null | grep -E "state|pid" || launchctl list | grep com.hens.seal
```

If no PID is reported, the runner failed to start — show
`tail -40 "$HOME/.config/seal/seal.err.log"` so the user can see why.

Then check the log to confirm it booted cleanly:

```bash
tail -20 "$HOME/.config/seal/seal.log"
```

## 7. Report

```
SEAL: Service installed.
- Plist: ~/Library/LaunchAgents/com.hens.seal.plist
- Status: running (auto-restart on crash)
- Auto-start: enabled (every login)
- Logs: ~/.config/seal/seal.log
- Dashboard: http://localhost:3457

To check status:    launchctl list | grep com.hens.seal
To view logs:       tail -f ~/.config/seal/seal.log
To uninstall:       /seal:uninstall-service
```

If the service failed to start, show the error log:
```bash
tail -20 "$HOME/.config/seal/seal.err.log"
```
</process>
