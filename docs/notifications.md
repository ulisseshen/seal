# Notification System

SEAL has 5 escalation levels. Each level maps to platform-specific commands.

## Levels

| Level | Behavior | Ignorable? |
|-------|----------|-----------|
| `silent` | Log to DB only | Yes |
| `sound` | Desktop notification + sound | Yes |
| `sticky` | Persistent notification + terminal bell | Harder |
| `nuclear` | Voice + modal dialog (blocks until clicked) | No |
| `supernova` | Nuclear, re-fires every 5 min until `/seal ack` | **No** |

## Platform mapping

### macOS (current — implemented)

| Level | Command |
|-------|---------|
| sound | `osascript -e 'display notification "..." with title "..." sound name "Glass"'` |
| sticky | Same + `\x07` terminal bell |
| nuclear | `say "..."` + `osascript -e 'display alert "..." as critical'` |

### Linux (planned)

| Level | Command | Package |
|-------|---------|---------|
| sound | `notify-send -u normal "title" "message"` | `libnotify` |
| sticky | `notify-send -u critical "title" "message"` + `\x07` | `libnotify` |
| nuclear | `spd-say "..."` + `zenity --warning --text="..."` | `speech-dispatcher`, `zenity` |

#### Install on Linux

```bash
# Debian/Ubuntu
sudo apt install libnotify-bin speech-dispatcher zenity

# Arch
sudo pacman -S libnotify speech-dispatcher zenity

# Fedora
sudo dnf install libnotify speech-dispatcher zenity
```

#### Sound on Linux

For notification sounds without a desktop environment:

```bash
# Play a sound file
paplay /usr/share/sounds/freedesktop/stereo/message.oga

# Or use sox
play -q /path/to/sound.wav
```

## Implementation plan

The `notify.js` module should detect the platform and dispatch accordingly:

```js
import { platform } from 'os';

const PLATFORM = platform(); // 'darwin' | 'linux'

function notifySound(title, message) {
  if (PLATFORM === 'darwin') {
    execSync(`osascript -e 'display notification "${esc(message)}" ...'`);
  } else {
    execSync(`notify-send -u normal "${esc(title)}" "${esc(message)}"`);
  }
}

function notifyNuclear(title, message) {
  if (PLATFORM === 'darwin') {
    exec(`say "Attention. ${esc(message)}"`);
    execSync(`osascript -e 'display alert "${esc(title)}" ...'`);
  } else {
    exec(`spd-say "Attention. ${esc(message)}"`);
    execSync(`zenity --warning --title="${esc(title)}" --text="${esc(message)}"`);
  }
}
```

## Future considerations

- **Telegram** — send notifications via Telegram bot API (works anywhere, no platform dependency)
- **WhatsApp reply** — SEAL could reply to your WhatsApp message confirming task creation
- **Pushover/Ntfy** — lightweight push notification services for mobile
- **Web dashboard** — browser-based notification via WebSocket
