/**
 * Diagnose — o motor de diagnóstico de omissão do SEAL (determinístico, honesto).
 *
 * A régua (aprovada pelo TL): NUNCA afirma o futuro. Cada risco é uma conclusão
 * RASTREÁVEL a fatos concretos lidos do banco. Sem sinal → sem diagnóstico (silêncio
 * em vez de alarme falso). O `level` (ok / atencao / critico) é só um resumo visual;
 * a verdade são os `facts` ao lado de cada `risk`.
 *
 * Não usa LLM, não escreve no banco, não age. Puro: dados → estrutura explicável.
 * (A projeção narrativa via LLM, marcada como hipótese, é fase 2 e mora noutro lugar.)
 */

import { db } from '../db.js';

const DAY_MS = 86_400_000;

function daysAgo(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / DAY_MS);
}

// Tags que gravamos no CONTEXT do detail das notas. "sensivel" pesa mais que "atencao".
function noteTag(detail = '') {
  const d = detail.toLowerCase();
  if (d.includes('sensivel') || d.includes('burnout')) return 'sensivel';
  if (d.includes('atencao')) return 'atencao';
  return null;
}

/**
 * Coleta os FATOS de uma pessoa a partir do banco. Tudo aqui é observável e checável.
 * @returns {Promise<object>} fatos crus (sem interpretação ainda)
 */
export async function collectFacts(name) {
  // Notas e rituais cujo people[0] === name.
  const rows = await db.all(
    `SELECT id, type, status, summary, detail, execute_at, last_notified_at,
            COALESCE(retry_count, 0) AS retry_count, completed_at, recurrence
     FROM tasks
     WHERE type IN ('person', 'ritual')
       AND json_extract(people, '$[0]') = ?`,
    [name],
  );

  const notes = rows.filter((r) => r.type === 'person');
  const rituals = rows.filter((r) => r.type === 'ritual');

  // Última interação registrada (nota ou ritual concluído / mais recente).
  const stamps = rows
    .map((r) => r.completed_at || r.last_notified_at || r.execute_at)
    .filter(Boolean)
    .map((s) => new Date(s).getTime())
    .filter((t) => !Number.isNaN(t));
  const lastTouch = stamps.length ? new Date(Math.max(...stamps)).toISOString() : null;

  const openNotes = notes.filter((n) => n.status === 'pending' || n.status === 'firing');

  const overdue = openNotes
    .filter((n) => n.execute_at && new Date(n.execute_at).getTime() < Date.now())
    .map((n) => ({ id: n.id, summary: n.summary, daysOverdue: daysAgo(n.execute_at) }));

  // Sinais sensíveis/atenção são FATOS PERMANENTES sobre a pessoa (burnout, isolamento),
  // não tarefas a fechar. Contam mesmo gravados como "done"/log — uma nota de burnout não
  // deixa de importar porque não tinha follow-up. Por isso lemos de TODAS as notas.
  const sensitiveOpen = notes
    .filter((n) => noteTag(n.detail) === 'sensivel')
    .map((n) => ({ id: n.id, summary: n.summary }));

  const attentionOpen = notes
    .filter((n) => noteTag(n.detail) === 'atencao')
    .map((n) => ({ id: n.id, summary: n.summary }));

  // Promessas que o SEAL já cobrou várias vezes e seguem abertas (ignoradas).
  const nagged = openNotes
    .filter((n) => n.retry_count >= 2)
    .map((n) => ({ id: n.id, summary: n.summary, times: n.retry_count }));

  // Dias desde o último 1:1 (ritual mais recente concluído, ou o lastTouch como proxy).
  const ritualStamps = rituals
    .map((r) => r.completed_at)
    .filter(Boolean)
    .map((s) => new Date(s).getTime());
  const lastOneOnOne = ritualStamps.length ? new Date(Math.max(...ritualStamps)).toISOString() : null;

  return {
    person: name,
    openCount: openNotes.length,
    overdue,
    sensitiveOpen,
    attentionOpen,
    nagged,
    daysSinceLastTouch: daysAgo(lastTouch),
    daysSinceOneOnOne: daysAgo(lastOneOnOne),
    hasRitual: rituals.length > 0,
  };
}

/**
 * Regras IF(fato) → risco. Cada regra retorna { risk, because[] } onde `because`
 * são os fatos exatos que a dispararam. Pesos só decidem o `level` resumido.
 */
function applyRules(f) {
  const risks = [];

  // 1. Sinal sensível aberto sem checagem recente → desengajamento.
  //    "nunca teve 1:1" (null) é o PIOR caso, não uma exceção que escapa a regra.
  const staleOneOnOne = f.daysSinceOneOnOne == null || f.daysSinceOneOnOne > 30;
  if (f.sensitiveOpen.length > 0 && staleOneOnOne) {
    risks.push({
      weight: 3,
      risk: 'Risco de desengajamento — sinal sensível em aberto sem checagem recente.',
      because: [
        ...f.sensitiveOpen.map((s) => `sinal sensível aberto: "${s.summary}"`),
        f.daysSinceOneOnOne == null
          ? 'sem 1:1 registrado ainda'
          : `${f.daysSinceOneOnOne} dias desde o último 1:1`,
      ],
    });
  }

  // 2. Follow-ups bem vencidos → erosão de confiança.
  const badlyOverdue = f.overdue.filter((o) => (o.daysOverdue ?? 0) >= 14);
  if (badlyOverdue.length > 0) {
    risks.push({
      weight: 2,
      risk: 'Erosão de confiança — você prometeu e o tempo passou.',
      because: badlyOverdue.map((o) => `"${o.summary}" vencido há ${o.daysOverdue} dias`),
    });
  }

  // 3. Acúmulo de pendências → muitos fios soltos.
  if (f.openCount >= 4) {
    risks.push({
      weight: 2,
      risk: 'Acúmulo de atrito — muitos fios soltos com a pessoa.',
      because: [`${f.openCount} pendências abertas`],
    });
  }

  // 4. Promessas cobradas e ignoradas → sinal de que algo trava a ação.
  if (f.nagged.length > 0) {
    risks.push({
      weight: 1,
      risk: 'Promessas cobradas e não resolvidas — algo está travando a ação.',
      because: f.nagged.map((n) => `"${n.summary}" cobrada ${n.times}×`),
    });
  }

  // 5. Atenção (não sensível) aberta + silêncio longo.
  if (f.attentionOpen.length > 0 && (f.daysSinceLastTouch ?? 0) > 21) {
    risks.push({
      weight: 1,
      risk: 'Sinal de atenção esfriando — sem contato recente.',
      because: [
        ...f.attentionOpen.map((s) => `atenção aberta: "${s.summary}"`),
        `${f.daysSinceLastTouch} dias sem registro de contato`,
      ],
    });
  }

  return risks;
}

function levelFrom(risks) {
  if (risks.length === 0) return 'ok';
  const max = Math.max(...risks.map((r) => r.weight));
  const total = risks.reduce((s, r) => s + r.weight, 0);
  if (max >= 3 || total >= 5) return 'critico';
  return 'atencao';
}

/**
 * Diagnóstico de uma pessoa. Honesto: sem sinal → level 'ok' e risks vazio.
 * @returns {Promise<{person, level, risks: Array<{risk, because[]}>, facts}>}
 */
export async function diagnosePerson(name) {
  const facts = await collectFacts(name);
  const risks = applyRules(facts).map(({ weight, ...rest }) => rest); // não expõe o peso bruto
  return {
    person: name,
    level: levelFrom(applyRules(facts)),
    risks,
    facts,
  };
}

/**
 * Diagnóstico de todo o time. Descobre as pessoas a partir das notas/rituais.
 * Ordena por gravidade (crítico → atenção → ok) pra o TL ver o que pega primeiro.
 */
export async function diagnoseTeam() {
  const rows = await db.all(
    `SELECT DISTINCT json_extract(people, '$[0]') AS name
     FROM tasks
     WHERE type IN ('person', 'ritual') AND json_extract(people, '$[0]') IS NOT NULL`,
  );
  const names = rows.map((r) => r.name).filter(Boolean);
  const diagnoses = await Promise.all(names.map((n) => diagnosePerson(n)));
  const order = { critico: 0, atencao: 1, ok: 2 };
  return diagnoses.sort((a, b) => order[a.level] - order[b.level]);
}
