import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import os from 'os';
import { insertTask } from './db.js';
import { transcribeBuffer } from './transcribe.js';
import { resolveSecret } from './config.js';
import { detectProject, getKnownProjects } from './projects.js';
import crypto from 'crypto';

let lastSeenUid = null;

/**
 * Poll Gmail for emails sent to your SEAL address.
 *
 * Two modes:
 *   mode: "sent"  → Polls your Sent folder for emails TO sealAddress
 *   mode: "inbox" → Polls INBOX for emails (if Cloudflare forwards to you)
 *
 * Default: "sent" — zero infra, just send from Gmail to seal@yourdomain.com
 */
export async function pollGmail(config) {
  if (!config.email.enabled) return;

  const { user, appPassword: configPass, sealAddress, mode } = config.email;

  // Resolve password: config > env > keychain
  const appPassword = resolveSecret(configPass, 'SEAL_GMAIL_PASS', 'seal-gmail-app-password');

  if (!user || !appPassword) {
    console.log('[ingest:gmail] Missing credentials. Need email.user + appPassword (config, env, or keychain).');
    return;
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass: appPassword },
    logger: false,
  });

  try {
    await client.connect();

    // Find Sent folder by specialUse flag (works in any language)
    let folder = 'INBOX';
    if (mode !== 'inbox') {
      const mailboxes = await client.list();
      const sent = mailboxes.find(mb => mb.specialUse === '\\Sent');
      folder = sent ? sent.path : '[Gmail]/Sent Mail';
    }

    const lock = await client.getMailboxLock(folder);

    try {
      // On first run: scan last 20 messages. After: by UID.
      let searchCriteria;
      if (lastSeenUid) {
        searchCriteria = { uid: `${lastSeenUid + 1}:*` };
      } else {
        // First run — get mailbox status and scan recent messages
        const status = await client.status(folder, { messages: true });
        const startSeq = Math.max(1, status.messages - 19);
        searchCriteria = { seq: `${startSeq}:*` };
      }

      const messages = [];
      for await (const msg of client.fetch(searchCriteria, {
        envelope: true,
        source: true,
        uid: true,
      })) {
        messages.push(msg);
      }

      let processed = 0;
      for (const msg of messages) {
        try {
          const parsed = await simpleParser(msg.source);

          // In "sent" mode: only process emails TO the seal address
          if (mode !== 'inbox') {
            const toAddresses = (parsed.to?.value || []).map(a => a.address?.toLowerCase());
            if (sealAddress && !toAddresses.includes(sealAddress.toLowerCase())) {
              lastSeenUid = Math.max(lastSeenUid || 0, msg.uid);
              continue; // Skip emails not addressed to SEAL
            }
          }

          await processEmail(parsed, config);
          processed++;
          lastSeenUid = Math.max(lastSeenUid || 0, msg.uid);

          // Mark as seen (so we don't re-process)
          await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
        } catch (err) {
          console.error(`[ingest:gmail] Failed to process email ${msg.uid}:`, err.message);
        }
      }

      if (processed > 0) {
        console.log(`[ingest:gmail] Processed ${processed} email(s)`);
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    console.error(`[ingest:gmail] Connection error:`, err.message);
  }
}

async function processEmail(parsed, config) {
  const subject = (parsed.subject || '').trim();
  const body = (parsed.text || '').trim();
  const from = parsed.from?.value?.[0]?.address || 'Unknown';

  // Transcribe audio attachments
  let audioText = '';
  if (parsed.attachments?.length > 0) {
    for (const att of parsed.attachments) {
      const ext = (att.filename || '').split('.').pop().toLowerCase();
      if (['ogg', 'mp3', 'm4a', 'wav', 'opus', 'webm'].includes(ext)) {
        try {
          console.log(`[ingest:gmail] Transcribing: ${att.filename}`);
          const text = transcribeBuffer(att.content, att.filename, config);
          audioText += `\n${text}`;
        } catch (err) {
          console.error(`[ingest:gmail] Transcription failed:`, err.message);
        }
      }
    }
  }

  // Merge all content
  const allContent = [subject, body, audioText].filter(Boolean).join('\n').trim();
  if (!allContent) return;

  // Detect project from subject or body
  const { project, projectName, cleanMessage } = detectProject(allContent);

  const summary = (cleanMessage.split('\n')[0] || 'No subject').slice(0, 80);
  const detail = cleanMessage.length > summary.length
    ? cleanMessage.slice(summary.length).trim()
    : null;

  const projects = getKnownProjects();
  const needsProject = !project && projects.length > 1;

  const task = {
    id: crypto.randomUUID().slice(0, 8),
    type: 'task',
    summary,
    detail: needsProject
      ? `[NEEDS PROJECT] ${detail || ''}\nAvailable: ${projects.join(', ')}`.trim()
      : detail || null,
    execute_at: null,
    recurrence: null,
    next_run: null,
    prompt: null,
    project: project || (projects.length === 1 ? `${os.homedir()}/projects/${projects[0]}` : null),
    allowed_tools: '[]',
    permission_mode: 'auto',
    notify_type: 'sound',
    notify_channel: 'email',
    people: JSON.stringify([from]),
    priority: 'medium',
    status: 'pending',
    created: new Date().toISOString(),
    max_runs: null,
  };

  await insertTask(task);
  const label = projectName || (projects.length === 1 ? projects[0] : 'no project');
  console.log(`[ingest:gmail] "${task.summary}" → ${label} (${task.id})`);
}

