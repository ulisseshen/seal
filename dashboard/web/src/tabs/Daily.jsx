import { useState } from 'react';
import { useFetch } from '../lib/useFetch.js';
import { PageHeader, Subtitle, Button, EmptyState, ErrorState, Skeleton } from '../components/ui.jsx';

function firstPerson(d) {
  try { return JSON.parse(d.people || '[]')[0] || ''; } catch { return ''; }
}

export default function Daily() {
  const { data, loading, error, reload } = useFetch('/api/daily');
  const rows = Array.isArray(data) ? data : [];

  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const [savedMsg, setSavedMsg] = useState(null);

  async function save() {
    if (!text.trim()) return;
    setSaving(true); setSaveErr(null); setSavedMsg(null);
    try {
      const res = await fetch('/api/daily/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setSavedMsg(`${body.saved?.length || 0} daily(s) registrada(s): ${(body.saved || []).map((s) => s.person).join(', ')}`);
      setText('');
      reload();
    } catch (e) {
      setSaveErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="page active">
      <PageHeader title="Daily — alimenta o check-in contextual">
        <Button variant="primary" size="sm" onClick={reload}>Reload</Button>
      </PageHeader>
      <Subtitle>
        Cole o que cada pessoa falou na daily. A IA estrutura (Fez / Vai fazer / Bloqueios /
        Compromissos / Humor) no histórico dela — e o check-in passa a perguntar algo que mostra
        que você prestou atenção. Pode colar a daily inteira que o SEAL separa por pessoa.
      </Subtitle>

      <div className="daily-input">
        <textarea
          className="daily-textarea"
          placeholder="Ex: Gus: terminou o endpoint de pedidos, hoje pega a tela de listagem, travado numa dúvida de Vue.&#10;Carla: fechou a migração do tela de clientes, vai começar os testes. Tranquila."
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
        />
        {saveErr && <div className="daily-err">⚠ {saveErr}</div>}
        {savedMsg && <div className="daily-ok">✅ {savedMsg}</div>}
        <div className="daily-actions">
          <Button variant="primary" size="sm" disabled={saving || !text.trim()} onClick={save}>
            {saving ? 'Estruturando…' : 'Salvar daily'}
          </Button>
        </div>
      </div>

      <h3 className="daily-feed-title">Dailies recentes</h3>
      <div className="daily-feed">
        {loading && <Skeleton count={3} />}
        {!loading && error && <ErrorState title="Falha ao carregar" message={error.message} />}
        {!loading && !error && rows.length === 0 && (
          <EmptyState title="Nenhuma daily ainda">
            Cole a primeira acima, ou use <code>/seal:daily</code> no Claude Code.
          </EmptyState>
        )}
        {!loading && !error && rows.map((d) => (
          <article key={d.id} className="daily-card">
            <div className="daily-card-head">
              <span className="daily-person">{firstPerson(d)}</span>
              <span className="daily-date">{(d.execute_at || '').slice(0, 10)}</span>
            </div>
            <pre className="daily-detail">{d.detail}</pre>
          </article>
        ))}
      </div>
    </section>
  );
}
