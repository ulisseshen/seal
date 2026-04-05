# Multi-Computer Setup

SEAL supports two database modes:

| Mode | Storage | Setup | Best for |
|------|---------|-------|----------|
| **Local** (default) | `~/.config/seal/tasks.db` | Zero config | Single machine |
| **Cloud** | [Turso](https://turso.tech) (hosted SQLite) | 2 env vars | Multiple machines |

## Local mode (default)

Works out of the box. Tasks live in `~/.config/seal/tasks.db`. Nothing to configure.

## Cloud mode (Turso)

Turso is hosted SQLite (libSQL). Free tier: 9GB storage, 1B row reads/month. Same SQL — no code changes.

### Setup

```bash
# 1. Install Turso CLI
brew install tursodatabase/tap/turso

# 2. Sign up (free)
turso auth signup

# 3. Create a database
turso db create seal

# 4. Get your credentials
turso db show seal --url
# → libsql://seal-yourname.turso.io

turso db tokens create seal
# → eyJhbGciOi...

# 5. Set env vars (add to ~/.zshrc for persistence)
export SEAL_DB_URL=libsql://seal-yourname.turso.io
export SEAL_DB_TOKEN=eyJhbGciOi...

# 6. Start SEAL
seal-run
# [db] Cloud → seal-yourname
```

Repeat step 5 on each machine. All instances read/write the same database.

### How it works

When `SEAL_DB_URL` is set, `db.js` uses `@libsql/client` instead of `better-sqlite3`. The API is identical — all queries are the same SQL. The only difference is network latency (typically <50ms with Turso's edge network).

### Architecture with multiple machines

```
Machine A (main — always on)
├── SEAL Runner (polling tasks)
├── Baileys WhatsApp (QR linked)
├── Email webhook server (:3456)
└── ↕ reads/writes Turso DB

Machine B (laptop)
├── SEAL Runner (polling tasks)
├── /seal skill (Claude Code)
└── ↕ reads/writes Turso DB

Machine C (work desktop)
├── /seal skill only
└── ↕ reads/writes Turso DB
```

- **WhatsApp** runs on only ONE machine (Baileys = one WhatsApp Web session)
- **Email webhook** runs on the machine with the tunnel
- **Task execution** (`claude -p`) can run on any machine with a SEAL runner
- **`/seal` skill** works on any machine with the env vars set

### Migrating from local to cloud

```bash
# 1. Create Turso DB (see above)

# 2. Start SEAL with cloud config — schema auto-creates
export SEAL_DB_URL=libsql://...
export SEAL_DB_TOKEN=...
seal-run

# 3. (Optional) Import existing local tasks
sqlite3 ~/.config/seal/tasks.db ".dump tasks" | \
  turso db shell seal
```

### Reverting to local

Just unset the env vars:

```bash
unset SEAL_DB_URL SEAL_DB_TOKEN
seal-run
# [db] Local → ~/.config/seal/tasks.db
```

Your local database is still there, untouched.
