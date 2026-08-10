import { useState } from 'react';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/useFetch.js';
import { fmtRelative } from '../lib/format.js';
import { PageHeader, Subtitle, Button, EmptyState, ErrorState } from '../components/ui.jsx';

const FILTERS = [['pending', 'Pending'], ['decided', 'Decided'], ['all', 'All']];
const ACTIONS = [
  { key: 'approved_saved', label: '✅ Approve + save', variant: 'success' },
  { key: 'approved_once', label: '🔁 Once only', variant: 'ghost' },
  { key: 'modified', label: '✏️ Modify', variant: 'ghost' },
  { key: 'denied', label: '❌ Deny', variant: 'ghost' },
  { key: 'suppressed', label: '🚫 Suppress', variant: 'ghost' },
];

function ProposalCard({ p, onDecide, busy }) {
  const decided = !!p.decided_at;
  const risks = Array.isArray(p.risks) ? p.risks : [];
  return (
    <div className={`proposal-card${decided ? ' decided' : ''}`}>
      <div className="proposal-header">
        <h3>{p.name}</h3>
        <span className="proposal-provider">{p.provider || '—'}{p.model ? ` · ${p.model}` : ''}</span>
        <span className="proposal-ttl">{decided ? 'decided' : `expires ${fmtRelative(p.expires_at)}`}</span>
      </div>
      <p className="proposal-explanation">{p.explanation}</p>
      {p.invocation && <div className="proposal-invocation"><code>{p.invocation}</code></div>}
      <pre className="proposal-script"><code>{p.script}</code></pre>
      {risks.length > 0 && (
        <div className="proposal-risks"><strong>⚠ Risks:</strong> {risks.join('; ')}</div>
      )}
      {decided ? (
        <div className="proposal-decided">Decision: <strong>{p.decision}</strong> · {fmtRelative(p.decided_at)}</div>
      ) : (
        <div className="proposal-actions">
          {ACTIONS.map((a) => (
            <Button key={a.key} variant={a.variant} size="sm" disabled={busy}
              onClick={() => onDecide(p, a.key)}>{a.label}</Button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Proposals() {
  const [filter, setFilter] = useState('pending');
  const [busyId, setBusyId] = useState(null);
  let qs = '';
  if (filter === 'pending') qs = '?decided=false';
  else if (filter === 'decided') qs = '?decided=true';
  const { data, loading, error, reload } = useFetch(`/api/proposals${qs}`);
  const [drafting, setDrafting] = useState(false);
  const rows = Array.isArray(data) ? data : [];

  async function decide(p, action) {
    let finalScript = null;
    if (action === 'modified') {
      finalScript = window.prompt('Edit the script before approving:', p.script);
      if (finalScript === null) return;
    }
    setBusyId(p.id);
    try {
      await api.post(`/api/proposals/${p.id}/decision`, { decision: action, final_script: finalScript });
      await reload();
    } catch (err) {
      alert('Decision failed: ' + err.message);
    } finally { setBusyId(null); }
  }

  async function draft() {
    setDrafting(true);
    try {
      const r = await api.post('/api/proposals/draft');
      if (r.skipped === 'fatigue') alert('Proposal fatigue gate hit — max 3 per day.');
      await reload();
    } finally { setDrafting(false); }
  }

  return (
    <section className="page active">
      <PageHeader title="Pending Proposals">
        <div className="log-filters">
          {FILTERS.map(([k, l]) => (
            <button key={k} className={`filter-chip${filter === k ? ' active' : ''}`} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
        <Button variant="primary" size="sm" onClick={draft} disabled={drafting}>{drafting ? 'Drafting…' : 'Draft now'}</Button>
      </PageHeader>
      <Subtitle>
        The LLM drafts automations from observed patterns. Approving the plan approves every future match — there's no escalation ladder.
        Max 3 proposals per day. 7-day TTL.
      </Subtitle>

      <div className="proposals-list">
        {loading && <EmptyState title="Loading…" />}
        {!loading && error && <ErrorState title="Failed to load proposals" message={error.message} />}
        {!loading && !error && rows.length === 0 && (
          <EmptyState icon="💬" title="No proposals yet">
            SEAL drafts proposals from observed patterns every 15 minutes. Click <strong>Draft now</strong> to run the drafter on demand.
          </EmptyState>
        )}
        {!loading && !error && rows.map((p) => (
          <ProposalCard key={p.id} p={p} onDecide={decide} busy={busyId === p.id} />
        ))}
      </div>
    </section>
  );
}
