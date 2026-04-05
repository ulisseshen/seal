import fs from 'fs';
import path from 'path';
import os from 'os';

const PROJECTS_DIR = path.join(os.homedir(), 'projects');

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
export function detectProject(message) {
  const known = getKnownProjects();
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

  return { project: null, projectName: null, cleanMessage: text };
}
