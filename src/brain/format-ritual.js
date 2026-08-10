// Formatação da mensagem de ritual no Telegram.
//
// O `detail` do ritual guarda o template em texto puro, com metadados
// administrativos (PREP_OFFSET, ATTENDEES, FREQUENCY) que servem para o SEAL e
// não para quem lê. Mandar isso cru produz um bloco cinza e feio — e essa é a
// mensagem que o usuário recebe DUAS VEZES POR DIA. Se ela dá preguiça de ler,
// o ritual morre por design ruim, não por indisciplina.
//
// Aqui a gente: tira os metadados, destaca o título, transforma os itens em
// lista legível, e mantém a pergunta de ação no fim.

const META_PREFIXES = ['PREP_OFFSET:', 'ATTENDEES:', 'FREQUENCY:', 'TEMPLATE:'];

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Remove as linhas de metadado do template, preservando o corpo.
 */
export function stripMeta(detail) {
  return String(detail || '')
    .split('\n')
    .filter((line) => !META_PREFIXES.some((p) => line.trim().startsWith(p)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Monta a mensagem HTML de um ritual disparando.
 *
 * Formato: título em negrito, corpo com bullets destacados, e as linhas de
 * comando (que o usuário pode querer copiar) em <code>.
 */
export function formatRitualMessage(ritual) {
  const titulo = esc(ritual.summary || 'Ritual');
  const corpo = stripMeta(ritual.detail);

  if (!corpo) return `⏰ <b>${titulo}</b>`;

  const linhas = corpo.split('\n').map((raw) => {
    const line = raw.trimEnd();
    if (!line.trim()) return '';

    // Comando shell → monospace, para dar toque-e-copia no celular.
    if (/^\s*(sqlite3|node|npm|git|tail|cd)\s/.test(line)) {
      return `<code>${esc(line.trim())}</code>`;
    }

    // Item de lista ("- foo" ou "• foo") → bullet limpo.
    const bullet = line.match(/^\s*[-•*]\s+(.*)$/);
    if (bullet) return `  •  ${esc(bullet[1])}`;

    // Item numerado ("1. foo") → mantém o número em negrito.
    const num = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (num) return `  <b>${num[1]}.</b> ${esc(num[2])}`;

    // Opção de decisão ("[A] foo") → destaca a letra.
    const opt = line.match(/^\s*\[([A-Z])\]\s*(.*)$/);
    if (opt) return `  <b>[${opt[1]}]</b> ${esc(opt[2])}`;

    // Cabeçalho de seção: linha curta terminada em ":" → negrito.
    if (/^[^\s].{0,60}:$/.test(line.trim())) {
      return `<b>${esc(line.trim())}</b>`;
    }

    return esc(line);
  });

  return `⏰ <b>${titulo}</b>\n<i>─────────────────</i>\n\n${linhas.join('\n')}`;
}
