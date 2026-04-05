import http from 'http';
import { insertTask } from './db.js';
import { transcribeBuffer } from './transcribe.js';
import crypto from 'crypto';

/**
 * HTTP server for SEAL ingestion.
 *
 * Endpoints:
 *   POST /email   → Cloudflare Email Worker posts incoming emails here
 *   GET  /health  → Health check
 *
 * WhatsApp is handled separately by Baileys (src/whatsapp.js).
 */
export function startIngestServer(config) {
  const port = config.server?.port || 3456;

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/email') {
        const body = await readBody(req);
        res.writeHead(200);
        res.end('OK');
        await handleEmail(body, config);
        return;
      }

      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'seal-ingest' }));
        return;
      }

      res.writeHead(404);
      res.end();
    } catch (err) {
      console.error('[ingest] Server error:', err.message);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal error');
      }
    }
  });

  server.listen(port, () => {
    console.log(`[ingest] Email webhook listening on port ${port} → POST /email`);
  });

  return server;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve(body); }
    });
    req.on('error', reject);
  });
}

function parsePrefix(text) {
  const prefixes = {
    '[reminder]': { type: 'reminder', notifyType: 'nuclear' },
    '[decision]': { type: 'decision', notifyType: 'silent' },
    '[person]':   { type: 'person',   notifyType: 'silent' },
    '[deadline]': { type: 'deadline', notifyType: 'nuclear' },
    '[task]':     { type: 'task',     notifyType: 'sound' },
  };

  const lower = text.toLowerCase().trim();
  for (const [prefix, meta] of Object.entries(prefixes)) {
    if (lower.startsWith(prefix)) {
      return { ...meta, clean: text.slice(prefix.length).trim() };
    }
  }

  return { type: 'task', notifyType: 'sound', clean: text.trim() };
}

async function handleEmail(data, config) {
  try {
    const { from, subject, body, attachments } = data;
    const senderName = from || 'Unknown';

    let audioText = '';
    if (attachments && Array.isArray(attachments)) {
      for (const att of attachments) {
        const ext = (att.filename || '').split('.').pop().toLowerCase();
        if (['ogg', 'mp3', 'm4a', 'wav', 'opus', 'webm'].includes(ext)) {
          try {
            console.log(`[ingest:email] Transcribing: ${att.filename}`);
            const buffer = Buffer.from(att.content, 'base64');
            const text = transcribeBuffer(buffer, att.filename, config);
            audioText += `\n[Voice: ${att.filename}]\n${text}`;
          } catch (err) {
            console.error(`[ingest:email] Transcription failed:`, err.message);
          }
        }
      }
    }

    const detail = [body, audioText].filter(Boolean).join('\n').trim();
    const { type, notifyType, clean } = parsePrefix(subject || 'No subject');

    const task = {
      id: crypto.randomUUID().slice(0, 8),
      type,
      summary: clean.slice(0, 80),
      detail: detail ? `From: ${senderName}\n${detail}` : `From: ${senderName}`,
      execute_at: null,
      recurrence: null,
      next_run: null,
      prompt: null,
      project: null,
      allowed_tools: '[]',
      permission_mode: 'auto',
      notify_type: notifyType,
      notify_channel: 'email',
      people: JSON.stringify([senderName]),
      priority: type === 'reminder' ? 'high' : 'medium',
      status: 'pending',
      created: new Date().toISOString(),
      max_runs: null,
    };

    insertTask(task);
    console.log(`[ingest:email] ${type} from ${senderName}: "${task.summary}" (${task.id})`);
  } catch (err) {
    console.error('[ingest:email] Error:', err.message);
  }
}
