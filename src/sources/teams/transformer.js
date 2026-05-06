/**
 * Teams source — artifact transformers.
 *
 * Transforms raw extracted.json artifacts (from teamsbot knowledge pipeline)
 * into KnowledgeItem objects for the SEAL Knowledge Engine.
 *
 * Artifact types and their JSON field mappings (from teamsbot ingest.js categories):
 *   bug       → bugs[]          — title, description
 *   flag      → featureFlags[]  — name, description
 *   decision  → decisions[]     — topic/title, decision/description
 *   rule      → businessRules[] — rule/title, context/description
 *   glossary  → glossary[]      — term, definition
 *   qa        → qaThreads[]     — question, answer
 *   timeline  → featureTimeline[] — feature/event, description
 */

/**
 * Build embedding text for an artifact based on its type.
 * Combines the most semantically meaningful fields for vector search.
 * @param {string} type - Artifact type
 * @param {object} item - Raw artifact object
 * @returns {string}
 */
export function buildEmbeddingText(type, item) {
  switch (type) {
    case 'bug':
      return [item.title, item.description, item.status].filter(Boolean).join(' — ');

    case 'flag':
      return [item.name, item.description, item.environment].filter(Boolean).join(' — ');

    case 'decision':
      return [
        item.topic || item.title,
        item.decision || item.description,
        item.rationale,
      ].filter(Boolean).join(' — ');

    case 'rule':
      return [item.rule || item.title, item.context || item.description].filter(Boolean).join(' — ');

    case 'glossary':
      return [item.term, item.definition].filter(Boolean).join(' — ');

    case 'qa':
      return [item.question, item.answer].filter(Boolean).join(' — ');

    case 'timeline':
      return [item.feature, item.event, item.description, item.milestone].filter(Boolean).join(' — ');

    default:
      return item.title || item.name || item.term || item.question || JSON.stringify(item).slice(0, 500);
  }
}

/**
 * Extract people names from an artifact.
 * Collects from all known people-related fields and deduplicates.
 * @param {object} item - Raw artifact object
 * @returns {string[]}
 */
export function extractPeople(item) {
  const names = new Set();
  const fields = [
    'participants',
    'reportedBy',
    'answeredBy',
    'askedBy',
    'owner',
    'decidedBy',
    'assignedTo',
    'fixedBy',
  ];

  for (const field of fields) {
    const val = item[field];
    if (!val) continue;
    if (Array.isArray(val)) {
      val.forEach(n => { if (n && typeof n === 'string') names.add(n.trim()); });
    } else if (typeof val === 'string') {
      names.add(val.trim());
    }
  }

  return [...names];
}

/**
 * Derive a human-readable title for an artifact based on its type.
 * @param {string} type
 * @param {object} item
 * @returns {string}
 */
function deriveTitle(type, item) {
  switch (type) {
    case 'bug':      return item.title || '';
    case 'flag':     return item.name || '';
    case 'decision': return item.topic || item.title || '';
    case 'rule':     return item.rule || item.title || '';
    case 'glossary': return item.term || '';
    case 'qa':       return item.question || '';
    case 'timeline': return item.feature || item.event || '';
    default:         return item.title || item.name || '';
  }
}

/**
 * Derive a date from an artifact based on its type.
 * Different artifact types store dates in different fields.
 * @param {object} item
 * @returns {string|null}
 */
function deriveDate(item) {
  return item.date || item.firstMentionDate || item.openedAt || item.reportedDate || item.fixedDate || null;
}

/**
 * Transform a raw artifact into a KnowledgeItem for the SEAL engine.
 * @param {string} type - Artifact type (bug, flag, decision, rule, glossary, qa, timeline)
 * @param {object} item - Raw artifact object from extracted.json
 * @param {string} convId - Conversation ID
 * @param {string} convName - Conversation display name
 * @returns {object} KnowledgeItem
 */
export function transformArtifact(type, item, convId, convName) {
  const itemId = item.id || `${type}-${hashItem(type, item)}`;

  return {
    source: 'teams',
    external_id: `teams-${convId}-${type}-${itemId}`,
    type,
    title: deriveTitle(type, item),
    content: JSON.stringify(item),
    embedding_text: buildEmbeddingText(type, item),
    date: deriveDate(item),
    people: extractPeople(item),
    project: null,
    tags: [type],
    meta: {
      conversationId: convId,
      conversationName: convName,
      sourceMessageIds: item.sourceMessageIds || [],
    },
  };
}

/**
 * Simple hash for items without an explicit id field.
 * @param {string} type
 * @param {object} item
 * @returns {string}
 */
function hashItem(type, item) {
  const key = deriveTitle(type, item) || JSON.stringify(item).slice(0, 100);
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

/**
 * Map from artifact type to the JSON field name in extracted.json.
 * Matches the teamsbot ingest.js categories array.
 */
export const TYPE_TO_FIELD = {
  bug: 'bugs',
  flag: 'featureFlags',
  decision: 'decisions',
  rule: 'businessRules',
  glossary: 'glossary',
  qa: 'qaThreads',
  timeline: 'featureTimeline',
};
