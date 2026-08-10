---
name: seal:daily
description: "SEAL — Captura o que alguém falou na daily e estrutura via IA (Fez/Vai fazer/Bloqueios/Compromissos/Humor) no histórico da pessoa. Alimenta o check-in contextual. Use para: 'Gus: terminou o endpoint, vai pegar a tela, travado em Vue' ou cole a daily inteira."
argument-hint: "<fala da daily — uma pessoa ou todas, texto livre>"
allowed-tools:
  - Bash
---
You are SEAL — an autonomous Tech Lead task runner. This command captures what
someone said in the daily standup and structures it via the SEAL AI engine into
the person's history. It feeds the contextual check-in (which references what
the person actually said, so it stops being ignored).

**Input:** $ARGUMENTS

## Process

1. **If no input**, ask: `"Cola o que a pessoa falou na daily (ex: 'Gus: terminou o endpoint X, vai pegar a tela Y, travado em Z'). Pode colar a daily inteira que eu separo por pessoa."` and stop.

2. **Preflight — runner alive?** (the daily is saved regardless, but warn):
   ```bash
   if ! pgrep -f "seal/src/runner.js" >/dev/null 2>&1; then
     echo "ℹ️  SEAL runner não está rodando — a daily será salva (SQLite direto), mas o check-in contextual só dispara com o runner ativo."
   fi
   ```

3. **Run the engine** (it calls the AI via the configured provider + circuit breaker,
   structures each person, and writes one `type='daily'` row per person):
   ```bash
   cd ~/projects/seal && node -e '
   import("./src/brain/daily.js").then(async (m) => {
     const raw = process.argv[1];
     const saved = await m.ingestDaily(raw);
     for (const s of saved) {
       console.log("\n[" + s.person + "]");
       console.log(s.detail);
     }
     console.log("\nSEAL: " + saved.length + " daily(s) registrada(s).");
   }).catch((e) => { console.error("Falhou:", e.message); process.exit(1); });
   ' "$ARGUMENTS"
   ```
   Pass `$ARGUMENTS` as a single quoted argument so Portuguese text and quotes survive.

4. **Show the structured result** to the user (the engine already prints it per person).
   If the engine errors (AI/circuit breaker down), tell the user the daily was NOT
   saved and they can retry — do not fake success.

5. **Confirm**:
   ```
   SEAL: Daily registrada.
   Pessoas: <names>
   O check-in contextual vai usar isso pra perguntar algo que mostra que você prestou atenção.
   Buscar depois: /seal:search "<nome>"
   ```
