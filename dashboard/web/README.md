# SEAL Dashboard — Web (Vite + React)

The dashboard UI, rewritten from vanilla JS to React 18 + Vite. It talks to the
same Express backend (`dashboard/server.js`) over the existing `/api/*` routes —
no backend behavior changed.

## Develop

```bash
cd dashboard/web
npm install
npm run dev          # Vite dev server on http://localhost:5173
```

The dev server proxies `/api/*` to `http://localhost:3457` (the running SEAL
backend). Change the target in `vite.config.js` if your backend runs elsewhere.

## Build

```bash
npm run build        # outputs static files to dashboard/web/dist
```

`server.js` serves `dashboard/web/dist` (with SPA fallback). After building,
start the backend the usual way and the React app is served at `/`.

## Layout

- `src/App.jsx` — sidebar + tab routing + footer stats.
- `src/tabs/*` — one component per tab (13 total).
- `src/components/*` — shared UI primitives, the mission modal, icons.
- `src/lib/*` — API client, date/markdown helpers, the polling fetch hook.
- `src/styles.css` — the full design system (SEAL dark/purple/pink/amber).
