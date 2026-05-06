/**
 * Knowledge Engine — Embedding provider abstraction.
 * Wraps Ollama (or compatible) embedding API with retry logic.
 */

const DEFAULTS = {
  provider: 'ollama',
  model: 'bge-m3',
  url: 'http://localhost:11434',
  dimensions: 1024,
};

export class EmbeddingProvider {
  constructor(config = {}) {
    this.provider = config.provider || DEFAULTS.provider;
    this.model = config.model || DEFAULTS.model;
    this.url = config.url || DEFAULTS.url;
    this.dimensions = config.dimensions || DEFAULTS.dimensions;
    this._apiUrl = `${this.url}/api/embeddings`;
  }

  /**
   * Generate embedding for a text string.
   * Returns a Float32Array of `this.dimensions` length, or null if text is too short.
   * Retries up to 3 times on failure.
   */
  async embed(text) {
    if (!text || text.length < 3) return null;

    const truncated = text.slice(0, 8000);
    let lastErr;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(this._apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, prompt: truncated }),
        });
        if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
        const data = await res.json();
        return new Float32Array(data.embedding);
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }

    console.log(`[seal:knowledge] Embedding failed after 3 attempts: ${lastErr.message}`);
    return null;
  }

  /**
   * Convert a Float32Array to a Buffer suitable for sqlite-vec queries.
   */
  toBuffer(embedding) {
    if (!embedding) return null;
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  }

  /**
   * Check if the embedding service is reachable.
   */
  async healthy() {
    try {
      const res = await fetch(`${this.url}/api/tags`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
