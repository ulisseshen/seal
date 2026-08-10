import { useState } from 'react';
import { useFetch } from '../lib/useFetch.js';
import { formatDuration } from '../lib/format.js';
import { PageHeader, EmptyState, ErrorState, Skeleton } from '../components/ui.jsx';

const FILTERS = [['all', 'All'], ['success', 'Success'], ['failed', 'Failed']];

export default function Logs() {
  const [filter, setFilter] = useState('all');
  const path = filter !== 'all' ? `/api/logs?status=${filter}` : '/api/logs';
  const { data, loading, error } = useFetch(path);
  const [open, setOpen] = useState(() => new Set());
  const logs = Array.isArray(data) ? data : [];

  const toggle = (i) => setOpen((p) => {
    const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n;
  });

  return (
    <section className="page active">
      <PageHeader title="Execution Logs">
        <div className="log-filters">
          {FILTERS.map(([k, l]) => (
            <button key={k} className={`filter-chip${filter === k ? ' active' : ''}`} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
      </PageHeader>

      <div className="logs-list">
        {loading && <Skeleton />}
        {!loading && error && <ErrorState title="Failed to load logs" message={error.message} />}
        {!loading && !error && logs.length === 0 && (
          <EmptyState icon="📋" title="No execution logs yet">Logs will appear here as SEAL runs your missions.</EmptyState>
        )}
        {!loading && !error && logs.map((log, i) => {
          const success = log.exit_code === 0 || log.exit_code === null;
          return (
            <div key={i} className={`log-entry${open.has(i) ? ' expanded' : ''}`} onClick={() => toggle(i)}>
              <div className={`log-status-dot ${success ? 'success' : 'failed'}`} />
              <div className="log-info">
                <div className="log-summary">{log.summary || log.task_id}</div>
                <div className="log-time">{new Date(log.started_at).toLocaleString()}</div>
              </div>
              {log.type && <span className="badge badge-type" data-type={log.type}>{log.type}</span>}
              <span className="log-duration">{formatDuration(log.started_at, log.finished_at)}</span>
              <div className="log-detail">
                {log.stdout_preview && <div className="log-output">{log.stdout_preview}</div>}
                {log.stderr_preview && <div className="log-output" style={{ color: 'var(--error)' }}>{log.stderr_preview}</div>}
                {!log.stdout_preview && !log.stderr_preview && <div className="log-output">No output captured.</div>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
