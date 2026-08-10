// Thin fetch wrapper. Same-origin in production (Express serves the build);
// the Vite dev server proxies /api to the backend (see vite.config.js).

async function http(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    const msg = (data && data.error) || (typeof data === 'string' ? data : `HTTP ${res.status}`);
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => http('GET', p),
  post: (p, b) => http('POST', p, b),
  put: (p, b) => http('PUT', p, b),
  del: (p, b) => http('DELETE', p, b),
};
