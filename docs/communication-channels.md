# Communication Channels

SEAL can receive tasks from your phone when you're away from the computer. Three channels are supported: WhatsApp, Email, and Voice Notes.

## Quick Start

```bash
# 1. Edit config
nano ~/.config/seal/ingest.json

# 2. Enable the channels you want
{
  "email":    { "enabled": true },
  "whatsapp": { "enabled": true }
}

# 3. Start SEAL
seal-run

# 4. For WhatsApp: scan the QR code that appears
# 5. For Email: deploy the Cloudflare Worker (see below)
```

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

## Email (Cloudflare Worker)

Emails sent to your SEAL address are received by a Cloudflare Email Worker, which POSTs them to SEAL's webhook server.

### Architecture

```
ulisseshen@gmail.com → seal@hens.com.br
                            ↓
                    Cloudflare Email Worker
                            ↓ POST /email
                    SEAL ingest server (:3456)
                            ↓
                    Task in SQLite/Turso
```

### Setup

#### 1. Deploy the Cloudflare Worker

```bash
cd ~/projects/seal/cloudflare-email-worker

# Edit wrangler.toml — set your tunnel URL
# SEAL_WEBHOOK_URL = "https://your-tunnel.trycloudflare.com/email"

npx wrangler deploy
```

#### 2. Configure Cloudflare Email Routing

1. Go to Cloudflare Dashboard → your domain → Email Routing
2. Add a route: `seal@yourdomain.com` → Send to Worker → `seal-email-worker`

#### 3. Set up a tunnel

SEAL runs locally on port 3456. The Cloudflare Worker needs to reach it:

**Option A: Cloudflare Tunnel (persistent, recommended)**
```bash
# Install cloudflared
brew install cloudflare/cloudflare/cloudflared

# Create a tunnel
cloudflared tunnel create seal
cloudflared tunnel route dns seal seal-ingest.yourdomain.com

# Run it
cloudflared tunnel run --url http://localhost:3456 seal
```

**Option B: ngrok (quick testing)**
```bash
ngrok http 3456
# Copy the https URL → update wrangler.toml → redeploy
```

#### 4. Enable in config

Set `email.enabled: true` in `~/.config/seal/ingest.json`

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
