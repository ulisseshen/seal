#!/bin/bash
# SEAL Watchdog — detect a dead runner and say so on Telegram.
#
# Why this exists: on 2026-08-10 the runner had been down for an unknown
# period. The lockfile at run/runner.pid held PID 2311, which the OS had since
# recycled to a Chrome renderer — so the single-instance guard saw "2311 is
# alive", concluded another runner held the lock, and refused to start. Forever.
# Silently.
#
# That failure mode is worse than a crash: rituals stop firing, and the user
# reads the silence as their own lack of discipline instead of a dead process.
#
# This script runs on a schedule, and unlike healthcheck.sh it (a) verifies the
# lock actually belongs to a *node* process, and (b) reports to Telegram rather
# than to a terminal nobody is watching.

CONFIG_DIR="$HOME/.config/seal"
LOCKFILE="$CONFIG_DIR/run/runner.pid"
GATEWAY="$CONFIG_DIR/gateway.json"
STATEFILE="$CONFIG_DIR/run/watchdog.state"

mkdir -p "$(dirname "$STATEFILE")"

notify_telegram() {
  local text="$1"
  local token chat
  token=$(python3 -c "import json;print(json.load(open('$GATEWAY'))['channels']['telegram']['token'])" 2>/dev/null) || return 1
  chat=$(python3 -c "import json;print(json.load(open('$GATEWAY'))['channels']['telegram']['chatId'])" 2>/dev/null) || return 1
  curl -s -m 20 "https://api.telegram.org/bot$token/sendMessage" \
    -d "chat_id=$chat" --data-urlencode "text=$text" >/dev/null 2>&1
}

# --- 1. Is a real runner process alive? -------------------------------------
if pgrep -f "seal/src/runner.js" >/dev/null 2>&1; then
  # Healthy. Only announce if we were previously down, so recovery is visible
  # but a healthy runner never spams.
  if [ -f "$STATEFILE" ] && [ "$(cat "$STATEFILE")" = "down" ]; then
    notify_telegram "🦭 SEAL voltou. O runner estava morto e subiu de novo — os rituais que venceram enquanto ele estava fora vao disparar no proximo ciclo."
  fi
  echo "up" > "$STATEFILE"
  exit 0
fi

# --- 2. Runner is down. Is a stale lock the reason? -------------------------
STALE_LOCK_MSG=""
if [ -f "$LOCKFILE" ]; then
  LOCKED_PID=$(tr -d '[:space:]' < "$LOCKFILE")
  if [ -n "$LOCKED_PID" ]; then
    # The bug: the guard only asks "does this PID exist?". A recycled PID
    # belonging to any unrelated process passes that check. Verify it is
    # actually a node process before trusting the lock.
    LOCK_CMD=$(ps -p "$LOCKED_PID" -o comm= 2>/dev/null)
    if [ -z "$LOCK_CMD" ]; then
      STALE_LOCK_MSG="Lock aponta pro PID $LOCKED_PID, que nao existe mais."
      rm -f "$LOCKFILE"
    elif ! echo "$LOCK_CMD" | grep -qi "node"; then
      STALE_LOCK_MSG="Lock aponta pro PID $LOCKED_PID, mas esse PID virou outro processo ($(basename "$LOCK_CMD")). PID reciclado."
      rm -f "$LOCKFILE"
    fi
  fi
fi

# --- 3. Try to bring it back ------------------------------------------------
launchctl kickstart -k "gui/$(id -u)/com.ulisseshen.seal" >/dev/null 2>&1
sleep 8

if pgrep -f "seal/src/runner.js" >/dev/null 2>&1; then
  MSG="🦭 SEAL estava morto. Eu reiniciei e voltou."
  [ -n "$STALE_LOCK_MSG" ] && MSG="$MSG

Causa: $STALE_LOCK_MSG Removi o lock."
  notify_telegram "$MSG"
  echo "up" > "$STATEFILE"
  exit 0
fi

# --- 4. Could not recover — this needs a human ------------------------------
MSG="🔴 SEAL esta morto e NAO conseguiu reiniciar sozinho.

Nenhum ritual vai disparar ate resolver isso.
$STALE_LOCK_MSG

Olha o log:
  tail -40 ~/.config/seal/runner.err.log"
notify_telegram "$MSG"
echo "down" > "$STATEFILE"
exit 1
