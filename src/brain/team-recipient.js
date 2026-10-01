import fs from 'fs';
import os from 'os';
import path from 'path';

const domainOf = (email) => email.split('@')[1]?.toLowerCase() || '';
const firstName = (name) => (name || '').trim().split(/\s+/)[0].toLowerCase();

export function resolveTeamRecipient(person, members) {
  const wanted = String(person || '').trim();
  if (!wanted || wanted.includes('@')) return wanted;
  const usable = (members || []).filter((member) => member.email?.includes('@') && !domainOf(member.email).endsWith('.local'));
  const key = wanted.toLowerCase();
  const matches = usable.filter((member) => firstName(member.name).startsWith(key));
  if (matches.length === 0) return wanted;
  const counts = new Map();
  for (const member of usable) counts.set(domainOf(member.email), (counts.get(domainOf(member.email)) || 0) + 1);
  const teamDomain = [...counts.entries()].sort((left, right) => right[1] - left[1])[0][0];
  const inTeam = matches.filter((member) => domainOf(member.email) === teamDomain);
  const pool = inTeam.length > 0 ? inTeam : matches;
  return pool.length === 1 ? pool[0].email : wanted;
}

export const TEAM_FILE = process.env.SEAL_TEAM_FILE || path.join(os.homedir(), '.config', 'seal', 'team.json');

export function readCheckinPeople(file = TEAM_FILE) {
  try {
    const people = JSON.parse(fs.readFileSync(file, 'utf8')).checkin;
    return Array.isArray(people) ? people.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}
