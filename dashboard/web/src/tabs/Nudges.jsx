import { useState } from 'react';
import { useFetch } from '../lib/useFetch.js';
import { fmtRelative } from '../lib/format.js';
import { PageHeader, Subtitle, Button, EmptyState, ErrorState, Skeleton } from '../components/ui.jsx';

const STATUS = {
  firing: { label: 'cobrando', dot: '🔔' },
  pending: { label: 'aguardando prazo', dot: '⏳' },
  done: { label: 'feito', dot: '✅' },
};

function firstPerson(n) {
  try { return JSON.parse(n.people || '[]')[0] || ''; } catch { return ''; }
}

function NudgeCard({ n, onDone }) {
  const person = firstPerson(n);
  const meta = STATUS[n.status] || { label: n.status, dot: '•' };
  const due = n.execute_at ? fmtRelative(n.execute_at) : '';
  const isDone = n.status === 'done';

  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  async function finish() {
    setSaving(true); setErr(null);
    try {
      const res = await fetch(`/api/nudges/${n.id}/done`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      setOpen(false); setNote('');
      onDone?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className={`nudge-card ${n.status}`}>
      <div className="nudge-rail" aria-hidden="true" />
      <div className="nudge-body">
        <div className="nudge-header">
          {person && <span className="nudge-person">{person}</span>}
          <span className={`nudge-status nudge-status-${n.status}`}>
            <span className="nudge-status-dot">{meta.dot}</span>{meta.label}
          </span>
          {n.nudge_count > 0 && (
            <span className="nudge-count" title="vezes que o SEAL já cobrou">cobrado {n.nudge_count}×</span>
          )}
          {due && <span className="nudge-due">{due}</span>}
        </div>
        <div className="nudge-summary">{n.summary || ''}</div>
        {n.detail && (
          <details className="nudge-note">
            <summary>nota</summary>
            <pre><code>{n.detail}</code></pre>
          </details>
        )}

        {!isDone && (
          <div className="nudge-actions">
            {!open ? (
              <Button variant="primary" size="sm" onClick={() => setOpen(true)}>✅ Finalizar</Button>
            ) : (
              <div className="nudge-finish">
                <textarea
                  className="nudge-finish-note"
                  placeholder="Nota de fechamento (opcional) — o que ficou resolvido?"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  autoFocus
                />
                {err && <div className="nudge-finish-err">⚠ {err}</div>}
                <div className="nudge-finish-buttons">
                  <Button variant="primary" size="sm" disabled={saving} onClick={finish}>
                    {saving ? 'Salvando…' : 'Confirmar feito'}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={saving} onClick={() => { setOpen(false); setNote(''); setErr(null); }}>
                    Cancelar
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export default function Nudges() {
  const { data, loading, error, reload } = useFetch('/api/nudges');
  const rows = Array.isArray(data) ? data : [];

  return (
    <section className="page active">
      <PageHeader title="Cobranças — SEAL cobra e sugere">
        <Button variant="primary" size="sm" onClick={reload}>Reload</Button>
      </PageHeader>
      <Subtitle>
        Promessas de gestão que você registrou (notas de pessoa com follow-up). SEAL cobra no prazo e
        sugere o próximo passo — os botões de ação chegam no seu Telegram. Aqui você acompanha o status.
      </Subtitle>

      <div className="nudges-list">
        {loading && <Skeleton count={3} />}
        {!loading && error && <ErrorState title="Falha ao carregar cobranças" message={error.message} />}
        {!loading && !error && rows.length === 0 && (
          <EmptyState title="Nenhuma cobrança ainda">
            Notas de pessoa com data de follow-up aparecem aqui. Use <code>/seal:note-person</code> com
            um follow-up para o SEAL começar a cobrar.
          </EmptyState>
        )}
        {!loading && !error && rows.map((n) => <NudgeCard key={n.id} n={n} onDone={reload} />)}
      </div>
    </section>
  );
}
