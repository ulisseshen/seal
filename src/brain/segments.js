/**
 * Segments — formas de FATIAR os mesmos sinais de gestão (não cria tabelas novas).
 *
 * O TL pediu 4 segmentos: por pessoa (360), por comportamento/tema, por tipo, por
 * projeto/squad. Cada um é uma consulta/agrupamento sobre `tasks` + `team_members`.
 * Por-pessoa e por-tipo já têm caminhos prontos (diagnose.js / /api/tasks); aqui
 * ficam os dois que precisam de derivação: tema e projeto.
 */

import { db } from '../db.js';

// Taxonomia de temas transversais — derivada por palavra-chave do summary+detail das notas.
// Os temas vieram dos próprios 1:1 (contexto de negócio, testes, isolamento, etc).
const THEMES = [
  { key: 'contexto-negocio', label: 'Contexto de negócio', match: /neg[oó]cio|contexto de neg/i },
  { key: 'testes', label: 'Testes', match: /\bteste/i },
  { key: 'isolamento', label: 'Isolamento / proximidade', match: /isolad|isolament|sozinho|afast|pair|aproxim/i },
  { key: 'autonomia', label: 'Autonomia', match: /autonomia|task do zero|coragem/i },
  { key: 'delivery', label: 'Delivery / entregável', match: /delivery|entreg[aá]vel|prazo/i },
  { key: 'bem-estar', label: 'Bem-estar', match: /burnout|sobrecarga|ansiedade|horario|hor[aá]rio|tcc|carga/i },
  { key: 'carreira', label: 'Carreira / PDI', match: /\bpdi\b|promo|n[ií]vel|carreira/i },
  { key: 'arquitetura', label: 'Arquitetura', match: /arquitet|abstra|acoplament/i },
];

function themeOf(text = '') {
  const hits = [];
  for (const t of THEMES) if (t.match.test(text)) hits.push(t.key);
  return hits;
}

/**
 * Agrupa as notas de pessoa por TEMA transversal. Uma nota pode cair em mais de um.
 * @returns {Promise<Array<{key, label, items: [{person, summary, status}]}>>}
 */
export async function byTheme() {
  const rows = await db.all(
    `SELECT json_extract(people,'$[0]') AS person, summary, detail, status
     FROM tasks WHERE type = 'person' AND json_extract(people,'$[0]') IS NOT NULL`,
  );
  const buckets = new Map(THEMES.map((t) => [t.key, { key: t.key, label: t.label, items: [] }]));
  for (const r of rows) {
    for (const key of themeOf(`${r.summary} ${r.detail || ''}`)) {
      buckets.get(key).items.push({ person: r.person, summary: r.summary, status: r.status });
    }
  }
  // Só retorna temas com algo, ordenados por volume.
  return [...buckets.values()].filter((b) => b.items.length > 0).sort((a, b) => b.items.length - a.items.length);
}

/**
 * Agrupa por PROJETO/SQUAD. Usa o campo project das tasks + repos dos team_members.
 * @returns {Promise<Array<{project, people: string[], openTasks: number}>>}
 */
export async function byProject() {
  const rows = await db.all(
    `SELECT project, json_extract(people,'$[0]') AS person, status
     FROM tasks WHERE project IS NOT NULL AND project != ''`,
  );
  const buckets = new Map();
  for (const r of rows) {
    if (!buckets.has(r.project)) buckets.set(r.project, { project: r.project, people: new Set(), openTasks: 0 });
    const b = buckets.get(r.project);
    if (r.person) b.people.add(r.person);
    if (r.status === 'pending' || r.status === 'firing' || r.status === 'running') b.openTasks++;
  }
  return [...buckets.values()].map((b) => ({ ...b, people: [...b.people] }));
}

/**
 * Lista as pessoas conhecidas (a partir das notas/rituais) — base do segmento por-pessoa.
 */
export async function listPeople() {
  const rows = await db.all(
    `SELECT json_extract(people,'$[0]') AS name, COUNT(*) AS signals
     FROM tasks WHERE type IN ('person','ritual') AND json_extract(people,'$[0]') IS NOT NULL
     GROUP BY name ORDER BY signals DESC`,
  );
  return rows.filter((r) => r.name);
}
