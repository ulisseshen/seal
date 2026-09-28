import fs from 'fs';
import path from 'path';
import os from 'os';

const PROJECTS_DIR = path.join(os.homedir(), 'projects');
const ALIASES_PATH = process.env.SEAL_PROJECT_ALIASES || path.join(os.homedir(), '.config', 'seal', 'project-aliases.json');
const SUMMARY_MAX = 80;

export function readProjectAliases() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ALIASES_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordIn = (lower, word) => new RegExp(`(^|[^\\p{L}\\p{N}_-])${escapeRegex(word.toLowerCase())}($|[^\\p{L}\\p{N}_-])`, 'u').test(lower);

export function splitSummary(text) {
  const lines = String(text || '').trim().split('\n');
  const first = lines[0].trim();
  if (lines.length > 1) return { summary: first.slice(0, SUMMARY_MAX), detail: lines.slice(1).join('\n').trim() || null };
  if (first.length <= SUMMARY_MAX) return { summary: first, detail: null };
  const cut = first.slice(0, SUMMARY_MAX - 1);
  const atWord = cut.lastIndexOf(' ') > SUMMARY_MAX / 2 ? cut.slice(0, cut.lastIndexOf(' ')) : cut;
  return { summary: `${atWord}…`, detail: first };
}

/**
 * Get list of known projects by scanning ~/projects/.
 * Each directory with a pubspec.yaml, package.json, or .git is a project.
 */
export function getKnownProjects() {
  try {
    const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(name => {
        const dir = path.join(PROJECTS_DIR, name);
        return (
          fs.existsSync(path.join(dir, '.git')) ||
          fs.existsSync(path.join(dir, 'package.json')) ||
          fs.existsSync(path.join(dir, 'pubspec.yaml'))
        );
      });
  } catch {
    return [];
  }
}

/**
 * Detect a project name from a message.
 * Returns { project, cleanMessage } or { project: null, cleanMessage }.
 *
 * Formats supported:
 *   "valenty: run tests"         → project=valenty, msg="run tests"
 *   "valenty run tests"          → project=valenty, msg="run tests" (if first word is a project)
 *   "run tests on valenty"       → project=valenty, msg="run tests"
 *   "run tests"                  → project=null
 */
export function detectProject(message, { known = getKnownProjects(), aliases = readProjectAliases() } = {}) {
  if (known.length === 0) return { project: null, cleanMessage: message };

  const text = message.trim();
  const lower = text.toLowerCase();

  // Pattern 1: "project: message"
  const colonMatch = lower.match(/^(\S+)\s*:\s*(.+)/);
  if (colonMatch) {
    const candidate = colonMatch[1];
    const found = known.find(p => p.toLowerCase() === candidate);
    if (found) {
      return {
        project: path.join(PROJECTS_DIR, found),
        projectName: found,
        cleanMessage: text.slice(text.indexOf(':') + 1).trim(),
      };
    }
  }

  // Pattern 2: first word is a project name
  const firstWord = lower.split(/\s+/)[0];
  const firstMatch = known.find(p => p.toLowerCase() === firstWord);
  if (firstMatch) {
    return {
      project: path.join(PROJECTS_DIR, firstMatch),
      projectName: firstMatch,
      cleanMessage: text.slice(firstWord.length).trim(),
    };
  }

  // Pattern 3: "on <project>" or "in <project>" or "for <project>"
  for (const prep of ['on', 'in', 'for']) {
    const regex = new RegExp(`\\b${prep}\\s+(\\S+)\\s*$`, 'i');
    const match = lower.match(regex);
    if (match) {
      const candidate = match[1];
      const found = known.find(p => p.toLowerCase() === candidate);
      if (found) {
        return {
          project: path.join(PROJECTS_DIR, found),
          projectName: found,
          cleanMessage: text.replace(regex, '').trim(),
        };
      }
    }
  }

  for (const [alias, target] of Object.entries(aliases)) {
    const found = known.find((p) => p.toLowerCase() === String(target).toLowerCase());
    if (found && wordIn(lower, alias)) return { project: path.join(PROJECTS_DIR, found), projectName: found, alias, cleanMessage: text };
  }
  const byWord = known.find((p) => /[-_]/.test(p) && wordIn(lower, p));
  if (byWord) return { project: path.join(PROJECTS_DIR, byWord), projectName: byWord, cleanMessage: text };

  return { project: null, projectName: null, cleanMessage: text };
}
