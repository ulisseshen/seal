import { useState } from 'react';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/useFetch.js';
import { fmtRelative } from '../lib/format.js';
import { PageHeader, Subtitle, Button, EmptyState, ErrorState } from '../components/ui.jsx';

const STATES = [['all', 'All'], ['observing', 'Observing'], ['proposed', 'Proposed'], ['active', 'Active']];

function PatternDetail({ p }) {
  const meta = p.metadata || {};
  if (p.kind === 'sequence' && meta.a && meta.b) {
    return <span><code>{meta.a}</code> → <code>{meta.b}</code> within {Math.round((meta.window_ms || 0) / 60000)}m</span>;
  }
  if (p.kind === 'naming' && meta.label) {
    const examples = (meta.examples || []).slice(0, 3);
    return (
      <span>
        {meta.field} · <code>{meta.label}</code>
        {examples.length > 0 && <><br /><span className="pattern-examples">{examples.map((e, i) => <code key={i}>{e} </code>)}</span></>}
      </span>
    );
  }
  return <code>{p.signature}</code>;
}

export default function Patterns() {
  const [state, setState] = useState('all');
  const [scanning, setScanning] = useState(false);
  const path = state === 'all' ? '/api/patterns' : `/api/patterns?state=${state}`;
  const { data, loading, error, reload } = useFetch(path);
  const rows = Array.isArray(data) ? data : [];

  async function scan() {
    setScanning(true);
    try { await api.post('/api/patterns/scan'); await reload(); }
    finally { setScanning(false); }
  }

  return (
    <section className="page active">
      <PageHeader title="Detected Patterns">
        <div className="log-filters">
          {STATES.map(([k, l]) => (
            <button key={k} className={`filter-chip${state === k ? ' active' : ''}`} onClick={() => setState(k)}>{l}</button>
          ))}
        </div>
        <Button variant="primary" size="sm" onClick={scan} disabled={scanning}>{scanning ? 'Scanning…' : 'Scan now'}</Button>
      </PageHeader>
      <Subtitle>
        SEAL watches the event stream and surfaces repeated shapes.
        No automation runs from here yet — patterns become proposals in v0.5.0.
      </Subtitle>

      <div className="patterns-list">
        {loading && <EmptyState title="Loading…" />}
        {!loading && error && <ErrorState title="Failed to load patterns" message={error.message} />}
        {!loading && !error && rows.length === 0 && (
          <EmptyState icon="👀" title="No patterns yet">
            SEAL will surface repeated shapes from the event stream as it accumulates activity. Add a watched repo under <strong>Workspaces</strong> to start feeding events.
          </EmptyState>
        )}
        {!loading && !error && rows.map((p) => (
          <div className="pattern-card" key={p.id}>
            <div className="pattern-header">
              <span className={`pattern-kind pattern-kind-${p.kind}`}>{p.kind}</span>
              <span className={`pattern-state pattern-state-${p.state}`}>{p.state}</span>
              <span className="pattern-confidence">{Math.round((p.confidence || 0) * 100)}% confidence</span>
              <span className="pattern-evidence">{p.evidence_count} obs</span>
            </div>
            <div className="pattern-body"><PatternDetail p={p} /></div>
            <div className="pattern-footer">
              <span className="pattern-time">last seen {fmtRelative(p.last_seen)}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
