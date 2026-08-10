import { useState, useMemo, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { PageHeader, EmptyState, ErrorState } from '../components/ui.jsx';

// Live tail of the events table. Polls every 5s. Source/Kind dropdowns are
// derived from the payload (kinds cascade from the selected source); Search
// filters client-side over the JSON data. Source/Since/Limit re-query;
// Search/Kind re-filter the cached payload — mirrors the original wiring.
export default function Events() {
  const [filters, setFilters] = useState({ source: '', kind: '', search: '', since: '', limit: '100' });
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  async function load() {
    const f = filtersRef.current;
    const params = new URLSearchParams();
    if (f.source) params.set('source', f.source);
    if (f.kind) params.set('kind', f.kind);
    if (f.since) params.set('since', new Date(f.since).toISOString());
    params.set('limit', f.limit || '100');
    try {
      const data = await api.get(`/api/events?${params.toString()}`);
      setEvents(Array.isArray(data) ? data : []);
      setError(null);
    } catch (err) { setError(err); }
  }

  // Re-query when source/since/limit change; poll every 5s.
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.source, filters.since, filters.limit]);

  const sources = useMemo(
    () => Array.from(new Set(events.map((e) => e.source))).sort(),
    [events]
  );
  const kinds = useMemo(() => {
    const scoped = filters.source ? events.filter((e) => e.source === filters.source) : events;
    return Array.from(new Set(scoped.map((e) => e.kind))).sort();
  }, [events, filters.source]);

  const filtered = useMemo(() => {
    const q = filters.search.toLowerCase().trim();
    let list = events;
    if (filters.kind) list = list.filter((e) => e.kind === filters.kind);
    if (q) list = list.filter((e) => {
      try { return JSON.stringify(e.data).toLowerCase().includes(q); } catch { return false; }
    });
    return list;
  }, [events, filters.kind, filters.search]);

  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const toggle = (i) => setOpen((p) => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n; });

  return (
    <section className="page active">
      <PageHeader title="Events" />
      <div className="events-filters">
        <div className="form-group">
          <label>Source</label>
          <select value={filters.source} onChange={set('source')}>
            <option value="">All</option>
            {sources.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Kind</label>
          <select value={filters.kind} onChange={set('kind')}>
            <option value="">All</option>
            {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Search</label>
          <input type="text" placeholder="Search JSON data..." value={filters.search} onChange={set('search')} />
        </div>
        <div className="form-group">
          <label>Since</label>
          <input type="datetime-local" value={filters.since} onChange={set('since')} />
        </div>
        <div className="form-group">
          <label>Limit</label>
          <input type="number" value={filters.limit} min="1" max="1000" onChange={set('limit')} />
        </div>
      </div>

      <div className="events-list">
        {error && <ErrorState title="Could not load events" message={error.message} />}
        {!error && filtered.length === 0 && (
          <EmptyState icon="👁" title="No events yet">Events will appear here as SEAL observers (git, calendar, ...) emit them.</EmptyState>
        )}
        {!error && filtered.length > 0 && (
          <table className="events-table">
            <thead><tr><th>Timestamp</th><th>Source</th><th>Kind</th><th>Data</th></tr></thead>
            <tbody>
              {filtered.map((e, i) => {
                let full = ''; let summary = '';
                try {
                  full = JSON.stringify(e.data, null, 2);
                  const oneLine = JSON.stringify(e.data);
                  summary = oneLine && oneLine.length > 80 ? oneLine.slice(0, 80) + '…' : (oneLine || '');
                } catch { full = String(e.data); summary = full.slice(0, 80); }
                const ts = e.timestamp ? new Date(e.timestamp).toLocaleString() : '';
                return (
                  <tr key={i} className={`event-row${open.has(i) ? ' expanded' : ''}`} onClick={() => toggle(i)}>
                    <td className="event-ts">{ts}</td>
                    <td><span className="event-source">{e.source}</span></td>
                    <td><span className="event-kind">{e.kind}</span></td>
                    <td>
                      <span className="event-summary">{summary}</span>
                      <pre className="event-full">{full}</pre>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
