// Roteador de mensagem solta (áudio transcrito ou texto) para o ritual certo.
//
// O Ulisses responde os rituais "na sequência": manda um áudio no Telegram sem
// dizer a que ritual se refere. O SEAL precisa descobrir sozinho.
//
// Sem isso, todo áudio virava `type='task'` com a primeira linha como summary —
// o TL Log viraria uma tarefa solta, sem estrutura e sem vínculo com o ritual
// que o pediu. Na revisão de 25/08 não haveria o que contar.
//
// ESTRATÉGIA — duas pistas, porque nenhuma sozinha é confiável:
//
//   1. CONTEÚDO (principal): o texto parece um TL Log (aprendizado, risco,
//      decisão, quem ajudei) ou um radar de incidentes (incidente, impacto,
//      hipótese, dono)? Robusto a horário, frágil em áudio curto/ambíguo.
//
//   2. RITUAL PENDENTE (desempate): existe ritual que disparou há pouco e não
//      foi respondido? Frágil sozinho — responder o radar às 11h ou o TL Log na
//      manhã seguinte faz a janela de tempo mentir — mas ótimo para desempatar.
//
// E o principal: quando a confiança é baixa, NÃO adivinha. Pergunta.
// Classificar errado em silêncio corrompe o dado exatamente onde ele importa.

import { getBreaker } from '../circuit-breaker.js';
import { getProvider } from '../providers/index.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SEAL_DIR = process.env.SEAL_DIR || join(process.env.HOME, '.config', 'seal');
const CHAT_CONFIG = join(SEAL_DIR, 'chat-config.json');

// Janela em que um ritual disparado ainda conta como "esperando resposta".
// 20h porque o TL Log das 17:30 pode ser respondido na manhã seguinte, antes
// do radar das 09:15. Mais que isso e as duas janelas se sobrepõem sempre.
const PENDING_WINDOW_HOURS = 20;

function readChatConfig() {
  if (!existsSync(CHAT_CONFIG)) return { provider: 'claude' };
  try { return JSON.parse(readFileSync(CHAT_CONFIG, 'utf-8')); }
  catch { return { provider: 'claude' }; }
}

function extractJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw.trim()); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }
  const a = raw.indexOf('{'); const b = raw.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(raw.slice(a, b + 1)); } catch {} }
  return null;
}

async function askLLM(systemPrompt, userPrompt) {
  const cfg = readChatConfig();
  const providerName = cfg.provider || 'claude';
  const model = cfg.model || undefined;
  const breaker = getBreaker(providerName, { threshold: 3, cooldownMs: 30 * 60 * 1000 });
  if (!breaker.canExecute()) throw new Error(`circuit breaker open for ${providerName}`);

  const provider = getProvider(providerName, { model });
  if (!provider.available()) throw new Error(`provider ${providerName} not available`);

  let raw = '';
  try {
    for await (const chunk of provider.stream([{ role: 'user', content: userPrompt }], systemPrompt)) {
      raw += chunk;
    }
    breaker.recordSuccess();
  } catch (err) {
    breaker.recordFailure();
    throw err;
  }
  return raw;
}

// ─── Heurística determinística ──────────────────────────────────────────────
// Roda ANTES da IA. Se o texto é claramente um ou outro, não gasta chamada de
// LLM nem depende do circuit breaker. Também é o fallback quando a IA morre —
// importante, porque a IA do SEAL já caiu inteira uma vez (chat-config com
// model gpt-5 que o codex rejeitava).

const TL_LOG_HINTS = [
  'aprendi', 'aprendizado', 'descobri', 'entendi',
  'risco', 'decisão', 'decisao', 'decidi', 'decidimos',
  'ajudei', 'ajudar', 'pairing', 'revisei',
  'amanhã', 'amanha', 'lembrar',
];

const RADAR_HINTS = [
  'incidente', 'incidentes', 'caiu', 'quebrou', 'erro em produção',
  'erro em producao', 'alerta', 'impacto', 'cliente afetado',
  'hipótese', 'hipotese', 'Hugo', 'triagem', 'rollback',
  'flutter', 'legado',
];

function scoreHints(text, hints) {
  const lower = text.toLowerCase();
  return hints.reduce((n, h) => (lower.includes(h) ? n + 1 : n), 0);
}

// Teste de microfone. Em 10/08 o Ulisses mandou "Alô, um, dois, três,
// testando" e isso virou uma tarefa no banco — e o SEAL ainda perguntou em que
// projeto salvar, prendendo a conversa num interrogatório. Um teste de áudio
// não é conteúdo: é o usuário conferindo se o canal funciona.
const MIC_TEST_PATTERNS = [
  /^\s*(al[oô]+|ol[aá]|ei|hey|test\w*)\b/i,
  /\btest(ando|e|ing)\b/i,
  /\bum,?\s*dois,?\s*(tr[eê]s)?\b/i,
  /\bmicrofone\b/i,
  /\bt[aá]\s*(me\s*)?(ouvindo|gravando|funcionando)\b/i,
];

/**
 * É só um teste de microfone? Precisa ser curto E casar um padrão — "testando
 * o fluxo de aprovação em staging hoje" é conteúdo real, não teste de áudio.
 */
export function isMicTest(text) {
  const t = text.trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words > 8) return false;
  return MIC_TEST_PATTERNS.some((re) => re.test(t));
}

/**
 * Classificação sem IA. Retorna {kind, confidence} onde kind é
 * 'tl-log' | 'radar' | 'unknown'.
 */
export function classifyByHeuristic(text) {
  const tl = scoreHints(text, TL_LOG_HINTS);
  const radar = scoreHints(text, RADAR_HINTS);

  if (tl === 0 && radar === 0) return { kind: 'unknown', confidence: 0 };
  if (tl > radar * 2) return { kind: 'tl-log', confidence: Math.min(0.9, 0.5 + tl * 0.1) };
  if (radar > tl * 2) return { kind: 'radar', confidence: Math.min(0.9, 0.5 + radar * 0.1) };

  // Os dois pontuaram parecido — um TL Log costuma MENCIONAR incidentes, então
  // empate não é ruído, é ambiguidade real. Deixa para a IA ou para o usuário.
  return { kind: 'unknown', confidence: 0.3 };
}

const CLASSIFY_SYSTEM = [
  'Você classifica uma mensagem de voz de um Tech Lead brasileiro.',
  'Ela responde a UM de dois rituais diários:',
  '',
  '- "tl-log": fechamento do dia. Fala de aprendizado sobre o sistema, risco que',
  '  apareceu, decisão técnica, bug que merece prevenção, quem ele ajudou, o que',
  '  lembrar amanhã. Tom retrospectivo, sobre o dia inteiro.',
  '- "radar": leitura matinal do grupo de incidentes. Fala de incidente específico,',
  '  o que afeta, se tem dono, hipótese, se o Hugo já atuou. Tom de triagem, sobre',
  '  um ou mais incidentes concretos.',
  '- "outro": não é nenhum dos dois (uma tarefa solta, um lembrete, uma nota sobre',
  '  uma pessoa do time).',
  '',
  'ATENÇÃO: um tl-log frequentemente MENCIONA incidentes — isso sozinho não faz',
  'dele um radar. O que decide é o enquadramento: retrospectiva do dia (tl-log)',
  'versus triagem do que está aberto agora (radar).',
  '',
  'Responda APENAS JSON: {"kind":"tl-log|radar|outro","confidence":0.0-1.0,"why":"<10 palavras>"}',
  'Seja honesto na confiança. Áudio curto e vago merece confiança baixa.',
].join('\n');

/**
 * Classifica com IA, caindo para a heurística se a IA falhar.
 */
export async function classifyMessage(text, { pendingRitual } = {}) {
  const heuristic = classifyByHeuristic(text);

  // Heurística confiante o bastante: não gasta IA.
  if (heuristic.confidence >= 0.7) {
    return { ...heuristic, source: 'heuristic' };
  }

  let ctx = `Mensagem:\n"""${text.trim()}"""`;
  if (pendingRitual) {
    // A pista temporal entra como CONTEXTO para a IA, nunca como decisão
    // automática — senão qualquer áudio mandado depois do TL Log vira TL Log.
    ctx += `\n\nPista: o ritual "${pendingRitual.summary}" disparou há ${pendingRitual.hoursAgo}h e ainda não foi respondido. Isso é uma pista fraca, não uma resposta — pese o conteúdo acima de tudo.`;
  }

  try {
    const raw = await askLLM(CLASSIFY_SYSTEM, ctx);
    const parsed = extractJson(raw);
    if (parsed && parsed.kind) {
      return {
        kind: parsed.kind === 'outro' ? 'unknown' : parsed.kind,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        why: parsed.why,
        source: 'llm',
      };
    }
  } catch (err) {
    // IA fora do ar (breaker aberto, provider quebrado). Degrada para a
    // heurística em vez de perder a mensagem.
    return { ...heuristic, source: 'heuristic-fallback', error: err.message };
  }

  return { ...heuristic, source: 'heuristic-fallback' };
}

// ─── Extração multi-item ────────────────────────────────────────────────────
// A classificação single-label acima resolve o caso simples (um áudio, um
// assunto). Mas o Ulisses não fala em compartimento: às 17:30, cansado, a fala
// real é "o incidente do login foi token expirando, aprendi que ninguém
// documentou o fluxo, e lembra de cobrar o Felipe" — radar + tl-log + tarefa
// numa frase só. Escolher UM rótulo joga o resto fora.
//
// Então o modo principal é EXTRAIR N itens de uma fala. Cada item vira sua
// própria linha, do seu tipo. O que não encaixa em nada vira tarefa genérica,
// nunca é descartado.

const EXTRACT_SYSTEM = [
  'Você quebra a fala de um Tech Lead brasileiro em itens separados.',
  'O texto vem de transcrição de voz: tem hesitação, repetição e erro em nome',
  'próprio. Limpe isso. NUNCA invente conteúdo que ele não disse.',
  '',
  'Uma fala pode conter VÁRIOS itens de tipos diferentes. Extraia todos.',
  '',
  'Tipos:',
  '- "radar": incidente concreto. Algo caiu/quebrou/está aberto agora.',
  '- "tl-log": retrospectiva do dia. Aprendizado sobre o sistema, risco que',
  '  apareceu, prevenção, quem ele ajudou.',
  '- "pessoa": observação sobre alguém do time (humor, dificuldade, evolução,',
  '  algo para retomar no 1:1). Ex: "a Carla tá desmotivada".',
  '- "tarefa": algo que ELE precisa fazer. Ex: "lembra de cobrar o Felipe".',
  '- "decisao": escolha técnica ou de produto tomada, com o porquê se ele disse.',
  '  Ex: "decidimos segurar o rollout em 10%".',
  '- "outro": tem conteúdo mas não encaixa em nenhum acima.',
  '',
  'REGRAS QUE IMPORTAM:',
  '1. Um tl-log frequentemente MENCIONA um incidente. Se a fala é retrospectiva',
  '   ("aprendi com o incidente de ontem"), é tl-log. Se é triagem do que está',
  '   aberto ("o login está caindo agora"), é radar. Na dúvida, os dois podem',
  '   coexistir como itens separados.',
  '2. NÃO force. Fala com um assunto só gera UM item. Não invente itens para',
  '   parecer completo.',
  '2b. "Não teve nada", "nada novo no grupo", "dia tranquilo" É UM RADAR VÁLIDO',
  '   (tipo "radar", texto "nada novo"). O valor do ritual está em ter olhado —',
  '   classificar isso como "outro" apagaria um ritual cumprido.',
  '3. Preserve o texto dele. `texto` é o que ele disse sobre AQUELE item,',
  '   limpo mas não parafraseado.',
  '',
  'Responda APENAS JSON:',
  '{"itens":[{"tipo":"radar|tl-log|pessoa|tarefa|decisao|outro",',
  '  "texto":"<o que ele disse sobre este item>",',
  '  "resumo":"<até 60 caracteres>",',
  '  "pessoa":"<nome citado, ou null>",',
  '  "campo":"<só para tl-log: aprendizado|risco|decisao|prevencao|ajudei|amanha>",',
  '  "confianca":0.0-1.0}]}',
].join('\n');

/**
 * Extrai N itens de uma fala. Este é o caminho principal do áudio.
 *
 * Se a IA falhar, devolve um único item 'outro' com o texto cru — a fala do
 * usuário nunca se perde por causa de provider fora do ar.
 */
export async function extractItems(text) {
  try {
    const raw = await askLLM(EXTRACT_SYSTEM, `Fala:\n"""${text.trim()}"""`);
    const parsed = extractJson(raw);
    if (parsed && Array.isArray(parsed.itens) && parsed.itens.length) {
      const itens = parsed.itens
        .filter((i) => i && i.texto && String(i.texto).trim())
        .map((i) => ({
          tipo: VALID_TYPES.has(i.tipo) ? i.tipo : 'outro',
          texto: String(i.texto).trim(),
          resumo: (i.resumo || String(i.texto)).slice(0, 60).trim(),
          pessoa: i.pessoa || null,
          campo: i.campo || null,
          confianca: typeof i.confianca === 'number' ? i.confianca : 0.5,
        }));
      if (itens.length) return { itens, degraded: false };
    }
  } catch (err) {
    return { itens: [fallbackItem(text)], degraded: true, error: err.message };
  }
  return { itens: [fallbackItem(text)], degraded: true };
}

const VALID_TYPES = new Set(['radar', 'tl-log', 'pessoa', 'tarefa', 'decisao', 'outro']);

function fallbackItem(text) {
  // IA fora do ar: tenta ao menos acertar o tipo pela heurística, e guarda a
  // fala inteira como um item só. Melhor um item mal-rotulado que zero itens.
  const h = classifyByHeuristic(text);
  return {
    tipo: h.kind === 'unknown' ? 'outro' : h.kind,
    texto: text.trim(),
    resumo: text.trim().slice(0, 60),
    pessoa: null,
    campo: null,
    confianca: h.confidence,
  };
}

const TYPE_ICON = {
  radar: '📕',
  'tl-log': '📗',
  pessoa: '📙',
  tarefa: '📘',
  decisao: '📓',
  outro: '📄',
};

const TYPE_LABEL = {
  radar: 'RADAR',
  'tl-log': 'TL LOG',
  pessoa: 'PESSOA',
  tarefa: 'TAREFA',
  decisao: 'DECISÃO',
  outro: 'NOTA',
};

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Monta a lista numerada que o usuário vê. É isso que torna o erro visível na
 * hora em vez de aparecer contaminado na revisão de 25/08.
 *
 * Formata em HTML do Telegram: o rótulo do tipo em negrito, o conteúdo em linha
 * própria. Sem isso vira um bloco de texto corrido em que não dá para bater o
 * olho e achar o item errado — que é justamente o ponto da confirmação.
 *
 * @param {boolean} html - false devolve texto puro (usado nos testes e no
 *                         fallback quando o Telegram recusa o parse).
 */
export function renderItems(itens, { html = true } = {}) {
  const lines = [];
  itens.forEach((item, idx) => {
    const icon = TYPE_ICON[item.tipo] || '📄';
    const label = TYPE_LABEL[item.tipo] || 'NOTA';
    const campo = item.tipo === 'tl-log' && item.campo ? ` · ${item.campo}` : '';
    const quem = item.pessoa ? ` · ${item.pessoa}` : '';

    if (html) {
      lines.push(`${idx + 1}. ${icon} <b>${escHtml(label)}</b><i>${escHtml(campo + quem)}</i>`);
      lines.push(`     ${escHtml(item.resumo)}`);
    } else {
      lines.push(`${idx + 1}. ${icon} ${label}${campo}${quem}`);
      lines.push(`     ${item.resumo}`);
    }
    // Linha em branco entre itens: numa lista de 5, o bloco colado é ilegível
    // no celular, que é onde ele vai ler isso.
    if (idx < itens.length - 1) lines.push('');
  });
  return lines.join('\n');
}

const STRUCTURE_TL_LOG = [
  'Você estrutura o log diário de um Tech Lead brasileiro, falado por voz.',
  'O texto vem de transcrição automática: pode ter repetição, hesitação e erro',
  'de grafia em nomes próprios. Limpe isso, mas NÃO invente conteúdo.',
  '',
  'Extraia em JSON:',
  '{',
  '  "aprendizado": "<o que aprendeu sobre o sistema, ou null>",',
  '  "risco": "<risco que apareceu, ou null>",',
  '  "decisao": "<decisão técnica tomada, ou null>",',
  '  "prevencao": "<incidente/bug que merece prevenção, ou null>",',
  '  "ajudei": "<quem ele ajudou, ou null>",',
  '  "amanha": "<o que lembrar amanhã, ou null>",',
  '  "resumo": "<uma linha, até 80 caracteres>"',
  '}',
  '',
  'Campo que ele não mencionou é null. NÃO preencha por simetria — um log com',
  '2 de 6 campos preenchidos é um log honesto, e a ausência é sinal.',
].join('\n');

const STRUCTURE_RADAR = [
  'Você estrutura a leitura matinal do grupo de incidentes de um Tech Lead.',
  'O texto vem de transcrição de voz: limpe hesitação, não invente conteúdo.',
  '',
  'Extraia em JSON:',
  '{',
  '  "incidentes": [',
  '    {"o_que":"<descrição curta>","impacto":"<quem/o que afeta, ou null>",',
  '     "sistema":"<flutter|novo|backend|desconhecido>","dono":"<nome ou null>",',
  '     "hipotese":"<hipótese, ou null>","proximo_passo":"<ação, ou null>"}',
  '  ],',
  '  "nada_novo": <true se ele disse que não teve nada>,',
  '  "resumo": "<uma linha, até 80 caracteres>"',
  '}',
  '',
  '"Não teve nada hoje" é resposta VÁLIDA: nada_novo=true e incidentes=[].',
  'Isso conta como ritual cumprido — o valor está em ter olhado.',
].join('\n');

/**
 * Estrutura o texto conforme o tipo de ritual. Se a IA falhar, devolve o texto
 * cru marcado como não-estruturado — a resposta do usuário nunca se perde só
 * porque a IA está fora.
 */
export async function structureResponse(text, kind) {
  const system = kind === 'radar' ? STRUCTURE_RADAR : STRUCTURE_TL_LOG;
  try {
    const raw = await askLLM(system, text.trim());
    const parsed = extractJson(raw);
    if (parsed) return { structured: parsed, raw: text, degraded: false };
  } catch (err) {
    return { structured: null, raw: text, degraded: true, error: err.message };
  }
  return { structured: null, raw: text, degraded: true };
}

/**
 * Renderiza a estrutura de volta para texto legível, que é o que fica gravado
 * em `detail` e o que o usuário vê na confirmação.
 */
export function renderStructured(kind, structured, rawText) {
  if (!structured) return rawText;

  if (kind === 'radar') {
    const lines = [];
    if (structured.nada_novo && !(structured.incidentes || []).length) {
      lines.push('Nada novo no grupo de incidentes.');
    }
    for (const inc of structured.incidentes || []) {
      lines.push(`• ${inc.o_que}`);
      if (inc.impacto) lines.push(`  impacto: ${inc.impacto}`);
      if (inc.sistema && inc.sistema !== 'desconhecido') lines.push(`  sistema: ${inc.sistema}`);
      if (inc.dono) lines.push(`  dono: ${inc.dono}`);
      if (inc.hipotese) lines.push(`  hipótese: ${inc.hipotese}`);
      if (inc.proximo_passo) lines.push(`  próximo passo: ${inc.proximo_passo}`);
    }
    return lines.join('\n') || rawText;
  }

  const labels = {
    aprendizado: 'Aprendi',
    risco: 'Risco',
    decisao: 'Decisão',
    prevencao: 'Prevenção',
    ajudei: 'Ajudei',
    amanha: 'Amanhã',
  };
  const lines = [];
  for (const [key, label] of Object.entries(labels)) {
    if (structured[key]) lines.push(`${label}: ${structured[key]}`);
  }
  return lines.join('\n') || rawText;
}
