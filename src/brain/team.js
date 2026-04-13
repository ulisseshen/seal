/**
 * SEAL — team model builder
 *
 * Hooks into the event bus and auto-populates team_members from
 * git.commit events. When a previously-unseen author appears, SEAL
 * fires an ingest-style alert so the TL can annotate the person with
 * a role and notes (or ignore them).
 *
 * This module is started from runner.js alongside the detector and
 * proposer loops. It listens on the event bus, not on a timer.
 */

import {
  upsertTeamMember,
  getTeamMember,
  listTeamMembers,
} from '../db.js';
import { sendAlert } from './alert.js';

let listening = false;

/**
 * Start listening for git.commit events on the event bus.
 * Safe to call multiple times — idempotent.
 */
export function startTeamBuilder(eventBus) {
  if (listening || !eventBus) return;
  listening = true;

  eventBus.on('observation:git', async (event) => {
    if (event.kind !== 'git.commit') return;
    const d = event.data || {};
    const email = d.author_email;
    const name = d.author_name;
    if (!email) return;

    try {
      const existed = await getTeamMember(email);
      await upsertTeamMember({ email, name, repo: d.repo || d.repo_path });

      if (!existed) {
        console.log(`[team] new contributor: ${name} <${email}>`);
        try {
          sendAlert({
            kind: 'new_contributor',
            title: `New contributor: ${name || email}`,
            body: `First commit seen from ${name} <${email}> in ${d.repo || 'unknown repo'}. Check the Team tab to add role/notes.`,
            path: '/#team',
          });
        } catch {}
      }
    } catch (err) {
      console.warn(`[team] upsert failed for ${email}: ${err.message}`);
    }
  });

  console.log('[team] builder listening on event bus (git.commit → team_members)');
}

// Re-export for dashboard endpoints.
export { listTeamMembers, getTeamMember, setTeamMemberInfo } from '../db.js';
