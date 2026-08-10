import { useState } from 'react';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/useFetch.js';
import { fmtRelative } from '../lib/format.js';
import { PageHeader, Subtitle, Button, EmptyState, ErrorState } from '../components/ui.jsx';

function IngestCard({ item, onActed }) {
  const [busy, setBusy] = useState(false);
  const handler = item.suggested_handler;
  const actions = Array.isArray(item.suggested_actions) ? item.suggested_actions : [];
  const decided = !!item.decided_at;

  async function act(action) {
    setBusy(true);
    try {
      const url = action === 'teach'
        ? `/api/ingest/queue/${item.id}/teach`
        : `/api/ingest/queue/${item.id}/ignore`;
      await api.post(url, {});
      await onActed();
    } catch (err) {
      alert('Action failed: ' + err.message);
    } finally { setBusy(false); }
  }

  return (
    <div className={`ingest-card${decided ? ' decided' : ''}`}>
      <div className="ingest-header">
        <span className="ingest-source">{item.source}</span>
        <span className="ingest-time">{fmtRelative(item.received_at)}</span>
        <span className="ingest-state">{item.state}</span>
      </div>
      <pre className="ingest-data"><code>{JSON.stringify(item.data, null, 2)}</code></pre>
      {item.interpretation && <div className="ingest-interpretation"><strong>Interpretation:</strong> {item.interpretation}</div>}
      {actions.length > 0 && <div className="ingest-suggested-actions"><strong>Suggested:</strong> {actions.join(' · ')}</div>}
      {handler && (
        <div className="ingest-handler">
          <strong>Draft handler:</strong> <code>{handler.name || 'unnamed'}</code>
          {handler.description && <p className="ingest-handler-desc">{handler.description}</p>}
          {handler.match_criteria && (
            <details><summary>match criteria</summary><pre><code>{JSON.stringify(handler.match_criteria, null, 2)}</code></pre></details>
          )}
          {handler.flow_yaml && (
            <details><summary>flow.yaml</summary><pre><code>{handler.flow_yaml}</code></pre></details>
          )}
        </div>
      )}
      {!decided && (
        <div className="ingest-actions">
          {handler && <Button variant="success" size="sm" disabled={busy} onClick={() => act('teach')}>📚 Approve handler</Button>}
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => act('ignore')}>🤷 Ignore</Button>
        </div>
      )}
      {decided && (
        <div className="proposal-decided">
          State: <strong>{item.state}</strong>
          {item.handler_skill_id && <> · handler <code>{item.handler_skill_id}</code></>}
        </div>
      )}
    </div>
  );
}

export default function Ingest() {
  const { data, loading, error, reload } = useFetch('/api/ingest/queue');
  const rows = Array.isArray(data) ? data : [];
  const [source, setSource] = useState('gmail');
  const [raw, setRaw] = useState('');
  const [result, setResult] = useState('');

  async function poke() {
    setResult('Sending…');
    let parsed = {};
    if (raw.trim()) {
      try { parsed = JSON.parse(raw.trim()); }
      catch (err) { setResult('⚠ Invalid JSON: ' + err.message); return; }
    }
    try {
      const r = await api.post('/api/ingest', { source: source.trim() || 'manual', data: parsed });
      setResult(r.matched
        ? `✓ matched handler "${r.handler}" (exit ${r.result?.exit_code ?? '—'})`
        : `✓ queued as ingest #${r.ingest_id}`);
      setTimeout(reload, 300);
    } catch (err) { setResult('⚠ ' + err.message); }
  }

  return (
    <section className="page active">
      <PageHeader title="Ingest — SEAL asks back">
        <Button variant="primary" size="sm" onClick={reload}>Reload</Button>
      </PageHeader>
      <Subtitle>
        Data SEAL doesn't yet know how to handle. Approve a draft handler once — every similar future event runs through it automatically.
      </Subtitle>

      <div className="ingest-poke">
        <h4>Try it — drop data into the ingest loop</h4>
        <div className="config-row">
          <label>Source</label>
          <input type="text" placeholder="gmail, telegram, chat, …" value={source} onChange={(e) => setSource(e.target.value)} />
        </div>
        <div className="config-row">
          <label>Data (JSON)</label>
          <textarea rows="5" value={raw} onChange={(e) => setRaw(e.target.value)}
            placeholder='{"from":"client@newclient.com","subject":"Proposal review","body":"Hi, please review the attached proposal by Friday."}' />
        </div>
        <Button variant="primary" size="sm" onClick={poke}>Send to ingest</Button>
        <span className="config-hint">{result}</span>
      </div>

      <div className="ingest-list">
        {loading && <EmptyState title="Loading…" />}
        {!loading && error && <ErrorState title="Failed to load" message={error.message} />}
        {!loading && !error && rows.length === 0 && (
          <EmptyState icon="📥" title="Ingest queue is empty">
            Use the form above to drop test data into the loop, or wire a gateway to POST <code>/api/ingest</code>.
          </EmptyState>
        )}
        {!loading && !error && rows.map((item) => <IngestCard key={item.id} item={item} onActed={reload} />)}
      </div>
    </section>
  );
}
