# Communication Channels

SEAL can receive tasks from your phone when you're away from the computer. Five channels are supported: Telegram, Discord, WhatsApp, Email, and Voice Notes.

## Quick Start

```bash
# 1. Edit config
nano ~/.config/seal/ingest.json

# 2. Enable the channels you want
{
  "telegram": { "enabled": true },
  "discord":  { "enabled": true },
  "email":    { "enabled": true },
  "whatsapp": { "enabled": true }
}

# 3. Set secrets (tokens, passwords)
# Option A: env vars
export SEAL_TELEGRAM_TOKEN="123456:ABC-DEF..."
export SEAL_DISCORD_TOKEN="MTIz...your-discord-token"
export SEAL_GMAIL_PASS="xxxx xxxx xxxx xxxx"

# Option B: secrets file (~/.config/seal/.secrets)
echo '{"telegram_token":"123456:ABC-DEF...","discord_token":"MTIz...","gmail_app_password":"xxxx xxxx xxxx xxxx"}' > ~/.config/seal/.secrets
chmod 600 ~/.config/seal/.secrets

# 4. Start SEAL
seal-run
```

## Telegram (easiest)

No phone number, no SIM, no tunnel. Just a bot token from @BotFather.

### Setup

1. Open Telegram, message **@BotFather**
2. Send `/newbot`
3. Name: **SEAL by Hens** (or your preferred name)
4. Username: `seal_hens_bot` (must be unique and end with `_bot`)
5. Copy the token
6. Set it: `export SEAL_TELEGRAM_TOKEN="your-token"` or add to `.secrets`
7. Set `telegram.enabled: true` in `~/.config/seal/ingest.json`
8. Run `seal-run`

### How to use

Message the bot directly. Same as all channels:
- Text → first line = summary
- Voice note → transcribed via whisper → task
- Project detection: `valenty: run tests` or `run tests on seal`
- No project + multiple projects → bot asks "Which project?"

### Security

Set `telegram.allowedUsers` in config to restrict who can send tasks:

```json
{
  "telegram": {
    "enabled": true,
    "allowedUsers": ["123456789", "@ulisseshen"]
  }
}
```

Empty array = allow all (only use for personal bots).

## Discord

No phone number needed. Works on desktop and mobile. Many developers already use it.

### Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**
2. Go to **Bot** tab → click **Reset Token** → copy the token
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**
4. Go to **OAuth2** → **URL Generator**:
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Read Message History`
5. Copy the generated URL → open it to invite the bot to a server you're in
6. Set token: `export SEAL_DISCORD_TOKEN="your-token"` or add `"discord_token"` to `.secrets`
7. Set `discord.enabled: true` in `~/.config/seal/ingest.json`
8. Run `seal-run`

### How to use

DM the bot directly. Same as all channels:
- Text → first line = summary
- Voice message (audio attachment) → transcribed via whisper → task
- Project detection: `valenty: run tests` or `run tests on seal`
- No project + multiple projects → bot asks "Which project?"

### Security

Set `discord.allowedUsers` in config to restrict who can send tasks:

```json
{
  "discord": {
    "enabled": true,
    "allowedUsers": ["123456789012345678", "yourusername"]
  }
}
```

Empty array = allow all (only use for personal bots).

### DM-only mode

By default, `dmOnly: true` — the bot only responds to direct messages. Set `dmOnly: false` to also accept messages in server channels (not recommended unless you restrict `allowedUsers`).

### Important notes

- The bot **must share a server** with you to receive DMs (Discord requirement)
- **Message Content Intent** must be enabled in the Developer Portal or the bot receives empty messages
- The bot ignores its own messages to prevent self-reply loops

## WhatsApp (Baileys)

Uses WhatsApp Web protocol via [Baileys](https://github.com/WhiskeySockets/Baileys). No Meta Business account needed — just your personal WhatsApp.

### Setup

1. Set `whatsapp.enabled: true` in `~/.config/seal/ingest.json`
2. Run `seal-run`
3. A QR code appears in the terminal
4. On your phone: WhatsApp → Settings → Linked Devices → Link a Device
5. Scan the QR code
6. Done — credentials persist in `~/.config/seal/whatsapp-auth/`

### How to use

Send a message **to yourself** (Saved Messages / your own number). Each message becomes a SEAL task.

**Text messages:**
```
Buy groceries for the team lunch
```
→ Creates task: "Buy groceries for the team lunch"

**With prefix:**
```
[reminder] Review João's PR by Monday
```
→ Creates reminder with nuclear notification

**Voice notes:**
Record and send a voice note to yourself. SEAL downloads it, transcribes via whisper-cli, and creates a task from the transcription.

### Reconnection

Baileys auto-reconnects on network drops. If you log out from WhatsApp (phone → Linked Devices → remove), delete `~/.config/seal/whatsapp-auth/` and restart SEAL to re-link.

### Limitations

- Only **one machine** can run Baileys at a time (WhatsApp Web constraint)
- Only processes messages **from you** (self-chat) — ignores group messages and messages from others
- Voice notes require `ffmpeg` and `whisper-cli` installed

## Email

Two modes: **Gmail IMAP** (simplest, no infra) or **Cloudflare Worker** (real-time webhook).

### Mode A: Gmail IMAP (recommended)

Polls your Gmail Sent folder for emails to your SEAL address. Zero infra needed.

```
ulisseshen@gmail.com → sends to seal@hens.com.br
                            ↓
                    SEAL polls Gmail Sent folder (every 5 min)
                            ↓
                    Finds emails TO seal@hens.com.br
                            ↓
                    Task in SQLite/Turso
```

#### Setup

1. Create a Gmail App Password: https://myaccount.google.com/apppasswords
2. Store it: `echo '{"gmail_app_password":"xxxx xxxx xxxx xxxx"}' > ~/.config/seal/.secrets && chmod 600 ~/.config/seal/.secrets`
3. Edit `~/.config/seal/ingest.json`:

```json
{
  "email": {
    "enabled": true,
    "mode": "gmail",
    "user": "ulisseshen@gmail.com",
    "appPassword": "secret:gmail_app_password",
    "sealAddress": "seal@hens.com.br"
  }
}
```

4. Run `seal-run`

### Mode B: Cloudflare Worker (real-time)

For real-time ingestion without polling. Requires a Cloudflare Worker + tunnel.

```bash
cd ~/projects/seal/cloudflare-email-worker
npx wrangler deploy
```

Configure Cloudflare Email Routing: `seal@yourdomain.com` → Send to Worker.
Set `email.mode: "webhook"` and `email.enabled: true` in config.
Requires a tunnel (Cloudflare Tunnel or ngrok) to expose port 3456.

### Email format

- **Subject** → task summary
- **Body** → task detail
- **Audio attachments** (.ogg, .mp3, .m4a, .wav) → transcribed and appended to detail

### Subject prefixes

| Prefix | Task type | Notification |
|--------|-----------|-------------|
| `[reminder]` | reminder | nuclear |
| `[decision]` | decision | silent |
| `[deadline]` | deadline | nuclear |
| `[person]` | person | silent |
| `[task]` | task | sound |
| *(no prefix)* | task | sound |

## Voice Notes & Audio Transcription

Voice notes from WhatsApp and audio attachments from email are automatically transcribed using [whisper.cpp](https://github.com/ggml-org/whisper.cpp).

### Setup

```bash
# Install whisper-cli
brew install whisper-cpp

# Install ffmpeg (for audio format conversion)
brew install ffmpeg

# The model is auto-downloaded on first SEAL install at:
# ~/.config/seal/models/ggml-small.bin (466MB)
```

### Configuration

In `~/.config/seal/ingest.json`:

```json
{
  "transcription": {
    "enabled": true,
    "binary": "whisper-cli",
    "model": "/Users/you/.config/seal/models/ggml-small.bin",
    "language": "pt"
  }
}
```

Change `language` to `"en"` for English, or `"auto"` for auto-detection (slower).

### Model options

| Model | Size | Speed (M1) | Quality |
|-------|------|------------|---------|
| tiny | 75 MB | ~10x realtime | Okay |
| base | 142 MB | ~7x realtime | Good |
| **small** | 466 MB | ~4x realtime | **Great (default)** |
| medium | 1.5 GB | ~2x realtime | Very good |
| large-v3 | 3 GB | ~1x realtime | Best |

To use a different model, download it from [HuggingFace](https://huggingface.co/ggerganov/whisper.cpp/tree/main) and update the `model` path in config.

## Multi-Computer Sync

See [multi-computer.md](multi-computer.md) for setting up Turso to share tasks across machines.
