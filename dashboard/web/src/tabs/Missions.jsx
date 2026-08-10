import { useState, useMemo } from 'react';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/useFetch.js';
import { relativeTime, shortPath } from '../lib/format.js';
import { PageHeader, Button, EmptyState, ErrorState, Skeleton } from '../components/ui.jsx';
import { Icon } from '../components/icons.jsx';
import MissionModal from '../components/MissionModal.jsx';

const TYPE_FILTERS = ['all', 'task', 'reminder', 'ritual', 'deadline', 'decision', 'person'];
const TYPE_LABELS = { all: 'All', task: 'Tasks', reminder: 'Reminders', ritual: 'Rituals', deadline: 'Deadlines', decision: 'Decisions', person: 'People' };
const STATUS_FILTERS = ['all', 'running', 'firing', 'pending', 'done', 'failed'];
const STATUS_LABELS = { all: 'All Status', running: 'Running', firing: 'Firing', pending: 'Pending', done: 'Done', failed: 'Failed' };

function refreshStats() {
  window.dispatchEvent(new Event('seal:stats-refresh'));
}

export default function Missions() {
  const { data, loading, error, reload } = useFetch('/api/tasks');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  const tasks = Array.isArray(data) ? data : [];

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return tasks.filter((t) => {
      if (typeFilter !== 'all' && t.type !== typeFilter) return false;
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (q && !((t.summary || '').toLowerCase().includes(q) || (t.detail || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }, [tasks, typeFilter, statusFilter, search]);

  const toggle = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  async function markDone(id) {
    await api.put(`/api/tasks/${id}`, { status: 'done', completed_at: new Date().toISOString() });
    reload(); refreshStats();
  }
  async function del(id) {
    if (!confirm('Delete this mission?')) return;
    await api.del(`/api/tasks/${id}`);
    reload(); refreshStats();
  }

  function openNew() { setEditing(null); setModalOpen(true); }
  function openEdit(task) { setEditing(task); setModalOpen(true); }
  async function onSaved() { setModalOpen(false); reload(); refreshStats(); }

  return (
    <section className="page active">
      <PageHeader title="Missions">
        <div className="search-box">
          {Icon.search()}
          <input
            type="text" placeholder="Search missions..."
            value={search} onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button variant="primary" onClick={openNew}>
          {Icon.plus()} New Mission
        </Button>
      </PageHeader>

      <div className="filters">
        {TYPE_FILTERS.map((f) => (
          <button key={f} className={`filter-chip${typeFilter === f ? ' active' : ''}`} onClick={() => setTypeFilter(f)}>
            {TYPE_LABELS[f]}
          </button>
        ))}
      </div>
      <div className="status-filters">
        {STATUS_FILTERS.map((s) => (
          <button key={s} className={`status-chip${statusFilter === s ? ' active' : ''}`} onClick={() => setStatusFilter(s)}>
            {STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      <div className="missions-list">
        {loading && <Skeleton />}
        {!loading && error && <ErrorState message="Could not load missions. Make sure the server is running." />}
        {!loading && !error && filtered.length === 0 && (
          <EmptyState icon="🜨" title="No missions found">
            {tasks.length === 0 ? 'Create your first mission using the button above.' : 'Try adjusting your filters or search query.'}
          </EmptyState>
        )}
        {!loading && !error && filtered.map((task) => (
          <div
            key={task.id}
            className={`mission-card${expanded.has(task.id) ? ' expanded' : ''}`}
            data-priority={task.priority}
            onClick={() => toggle(task.id)}
          >
            <div className="mission-top">
              <div className="mission-info">
                <span className="badge badge-type" data-type={task.type}>{task.type}</span>
                <span className="mission-summary">{task.summary}</span>
              </div>
              <div className="mission-meta">
                {task.recurrence && <span className="mission-recurrence">{task.recurrence}</span>}
                {task.next_run && <span className="mission-time">{relativeTime(task.next_run)}</span>}
                {task.project && <span className="badge badge-project">{shortPath(task.project)}</span>}
                <span className="badge badge-status" data-status={task.status}>{task.status}</span>
              </div>
            </div>
            <div className="mission-detail">
              {task.detail && <div className="detail-text">{task.detail}</div>}
              {task.prompt && <div className="detail-prompt">{task.prompt}</div>}
              <div className="detail-actions" onClick={(e) => e.stopPropagation()}>
                {task.status !== 'done' && <Button variant="success" size="sm" onClick={() => markDone(task.id)}>Mark Done</Button>}
                <Button variant="ghost" size="sm" onClick={() => openEdit(task)}>Edit</Button>
                <Button variant="danger" size="sm" onClick={() => del(task.id)}>Delete</Button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {modalOpen && (
        <MissionModal task={editing} onClose={() => setModalOpen(false)} onSaved={onSaved} />
      )}
    </section>
  );
}
