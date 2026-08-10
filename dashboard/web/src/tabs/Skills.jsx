import { useState } from 'react';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/useFetch.js';
import { PageHeader, Subtitle, Button, EmptyState, ErrorState } from '../components/ui.jsx';

function SkillCard({ s, onRan }) {
  const params = Array.isArray(s.parameters) ? s.parameters : [];
  const [args, setArgs] = useState(() => params.map(() => ''));
  const [output, setOutput] = useState(null);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    setOutput('→ invoking…\n');
    const sent = args.filter((v) => v.length > 0);
    try {
      const result = await api.post(`/api/skills/${encodeURIComponent(s.name)}/run`, { args: sent });
      const pieces = [];
      if (result.stdout) pieces.push(result.stdout);
      if (result.stderr) pieces.push('--- stderr ---\n' + result.stderr);
      pieces.push(`\n(exit ${result.exit_code}, ${result.duration_ms}ms)`);
      setOutput(pieces.join('\n'));
    } catch (err) {
      setOutput('⚠ ' + err.message);
    } finally {
      setRunning(false);
      onRan();
    }
  }

  return (
    <div className="skill-card">
      <div className="skill-header">
        <h3>{s.name}</h3>
        <span className={`skill-state skill-state-${s.state}`}>{s.state}</span>
        <span className="skill-stats">{s.run_count} runs · {s.success_count} ok · {s.failure_count} fail</span>
      </div>
      <p className="skill-description">{s.description || ''}</p>
      <div className="skill-run-row">
        {params.map((p, i) => (
          <input
            key={i} type="text" className="skill-arg" value={args[i]}
            placeholder={`${p.name || `arg ${i + 1}`}${p.example ? ` (e.g. ${p.example})` : ''}`}
            onChange={(e) => setArgs((a) => { const n = [...a]; n[i] = e.target.value; return n; })}
          />
        ))}
        <Button variant="primary" size="sm" onClick={run} disabled={running}>{running ? 'Running…' : 'Run'}</Button>
      </div>
      {output !== null && <pre className="skill-output">{output}</pre>}
    </div>
  );
}

export default function Skills() {
  const { data, loading, error, reload } = useFetch('/api/skills');
  const rows = Array.isArray(data) ? data : [];

  return (
    <section className="page active">
      <PageHeader title="Skills" />
      <Subtitle>
        Approved proposals become persistent skills. Invoke manually here or via <code>seal run &lt;name&gt;</code>.
      </Subtitle>
      <div className="skills-list">
        {loading && <EmptyState title="Loading…" />}
        {!loading && error && <ErrorState title="Failed to load skills" message={error.message} />}
        {!loading && !error && rows.length === 0 && (
          <EmptyState icon="🌟" title="No skills yet">
            Approve a proposal with <strong>Approve + save</strong> or <strong>Modify</strong> to create your first skill.
          </EmptyState>
        )}
        {!loading && !error && rows.map((s) => <SkillCard key={s.id} s={s} onRan={reload} />)}
      </div>
    </section>
  );
}
