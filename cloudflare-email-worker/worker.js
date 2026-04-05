/**
 * Cloudflare Email Worker for SEAL.
 *
 * Receives emails to seal@hens.com.br and POSTs them to SEAL's webhook.
 * Deploy: wrangler deploy
 *
 * Setup in Cloudflare Dashboard:
 *   1. Email Routing → Routes → seal@hens.com.br → "Send to Worker"
 *   2. Point to this worker
 */

export default {
  async email(message, env) {
    const { from, to } = message;
    const subject = message.headers.get('subject') || 'No subject';

    // Read the raw email body
    const rawBody = await readStream(message.raw);

    // Extract plain text from raw email (simple extraction)
    const body = extractTextBody(rawBody);

    // Extract attachments (base64 encoded)
    const attachments = extractAttachments(rawBody);

    // POST to SEAL ingest server
    const sealUrl = env.SEAL_WEBHOOK_URL || 'https://your-tunnel.com/email';

    try {
      const response = await fetch(sealUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to,
          subject,
          body,
          attachments,
          receivedAt: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        console.error(`SEAL webhook failed: ${response.status}`);
      }
    } catch (err) {
      console.error(`SEAL webhook error: ${err.message}`);
    }
  },
};

async function readStream(stream) {
  const reader = stream.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const arr = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    arr.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(arr);
}

function extractTextBody(raw) {
  // Look for plain text part in multipart email
  const boundaryMatch = raw.match(/boundary="?([^"\r\n]+)"?/);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = raw.split(`--${boundary}`);
    for (const part of parts) {
      if (part.includes('Content-Type: text/plain')) {
        const bodyStart = part.indexOf('\r\n\r\n');
        if (bodyStart !== -1) {
          return part.slice(bodyStart + 4).trim().replace(/--$/, '').trim();
        }
      }
    }
  }

  // Fallback: strip headers, return rest
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd !== -1) {
    return raw.slice(headerEnd + 4).trim();
  }

  return raw;
}

function extractAttachments(raw) {
  const attachments = [];
  const boundaryMatch = raw.match(/boundary="?([^"\r\n]+)"?/);
  if (!boundaryMatch) return attachments;

  const boundary = boundaryMatch[1];
  const parts = raw.split(`--${boundary}`);

  for (const part of parts) {
    const filenameMatch = part.match(/filename="?([^"\r\n]+)"?/);
    if (!filenameMatch) continue;

    const filename = filenameMatch[1];
    const ext = filename.split('.').pop().toLowerCase();

    // Only keep audio attachments
    if (!['ogg', 'mp3', 'm4a', 'wav', 'opus', 'webm'].includes(ext)) continue;

    // Extract base64 content
    if (part.includes('Content-Transfer-Encoding: base64')) {
      const bodyStart = part.indexOf('\r\n\r\n');
      if (bodyStart !== -1) {
        const content = part.slice(bodyStart + 4).replace(/[\r\n-]/g, '').trim();
        attachments.push({ filename, content });
      }
    }
  }

  return attachments;
}
