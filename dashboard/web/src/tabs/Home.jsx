import { useMemo } from 'react';
import { useFetch } from '../lib/useFetch.js';
import { relativeTime, fmtRelative, categoryColor, expandOccurrences } from '../lib/format.js';
import { Icon } from '../components/icons.jsx';

// The landing surface: a grid of summary cards, each a window into one tab.
// Every card carries its category hue (the spine) so the whole page reads at a
// glance, and clicking a card jumps straight to that tab.

function firstPerson(n) {
  try { return JSON.parse(n.people || '[]')[0] || ''; } catch { return ''; }
}

function HomeCard({ cat, icon, title, count, onOpen, linkLabel, children }) {
  const style = cat ? { '--cat': `var(--cat-${cat})` } : undefined;
  return (
    <div
      className="home-card" style={style} role="button" tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
    >
      <div className="home-card-rail" />
      <div className="home-card-head">
        <span className="home-card-icon">{icon}</span>
        <span className="home-card-title">{title}</span>
        {count != null && <span className="home-card-count">{count}</span>}
      </div>
      {children}
      <div className="home-card-link">{linkLabel} {Icon.arrowRight(14)}</div>
    </div>
  );
}

function Rows({ items, empty }) {
  if (!items.length) return <div className="home-card-empty">{empty}</div>;
  return (
    <div className="home-card-body">
      {items.map((it, i) => (
        <div className="home-row" key={i}>
          <span className="home-row-dot" style={it.color ? { background: it.color } : undefined} />
          <span className="home-row-text">{it.text}</span>
          {it.meta && <span className="home-row-meta">{it.meta}</span>}
        </div>
      ))}
    </div>
  );
}

export default function Home({ onNavigate }) {
  const tasks = useFetch('/api/tasks?status=pending', { pollMs: 30000 });
  const nudges = useFetch('/api/nudges', { pollMs: 30000 });
  const proposals = useFetch('/api/proposals?decided=false', { pollMs: 30000 });
  const events = useFetch('/api/events?limit=8', { pollMs: 15000 });
  const stats = useFetch('/api/stats', { pollMs: 30000 });

  // Upcoming 1:1s & rituals — expand recurrence/next_run, sort by soonest.
  const upcoming = useMemo(() => {
    const rows = Array.isArray(tasks.data) ? tasks.data : [];
    const relevant = rows.filter((t) => ['ritual', 'person', 'deadline', 'reminder'].includes(t.type) || t.recurrence || t.next_run);
    const occ = [];
    for (const t of relevant) {
      const list = expandOccurrences(t, 30);
      if (!list.length) continue;
      const next = list.sort((a, b) => a.date - b.date)[0];
      const when = new Date(next.date);
      if (next.time) { const [h, m] = next.time.split(':'); when.setHours(+h, +m); }
      occ.push({ task: t, when, time: next.time });
    }
    occ.sort((a, b) => a.when - b.when);
    return occ.slice(0, 5);
  }, [tasks.data]);

  const nudgeRows = Array.isArray(nudges.data) ? nudges.data : [];
  const activeNudges = nudgeRows.filter((n) => n.status !== 'done');
  const propRows = Array.isArray(proposals.data) ? proposals.data : [];
  const eventRows = Array.isArray(events.data) ? events.data : [];

  const byStatus = {};
  (stats.data?.byStatus || []).forEach((s) => { byStatus[s.status] = s.count; });

  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <section className="page active">
      <div className="home-greeting">
        <h1 className="page-title">Visão geral</h1>
        <div className="home-date">{today.charAt(0).toUpperCase() + today.slice(1)} · seu painel de gestão</div>
      </div>

      <div className="home-grid">
        {/* Upcoming 1:1s & rituals */}
        <HomeCard
          cat="ritual" icon={Icon.calendar(20)} title="Próximos 1:1 e rituais"
          count={upcoming.length} onOpen={() => onNavigate('calendar')} linkLabel="Abrir agenda"
        >
          <Rows
            empty="Nada agendado nos próximos 30 dias."
            items={upcoming.map((o) => ({
              color: categoryColor(o.task.type),
              text: o.task.summary,
              meta: o.time
                ? `${o.when.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })} ${o.time}`
                : o.when.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }),
            }))}
          />
        </HomeCard>

        {/* Pending nudges */}
        <HomeCard
          cat="nudge" icon={Icon.bell(20)} title="Cobranças pendentes"
          count={activeNudges.length} onOpen={() => onNavigate('nudges')} linkLabel="Ver cobranças"
        >
          <Rows
            empty="Nenhuma cobrança em aberto."
            items={activeNudges.slice(0, 5).map((n) => ({
              color: n.status === 'firing' ? 'var(--cat-nudge)' : 'var(--cat-task)',
              text: `${firstPerson(n) ? firstPerson(n) + ' — ' : ''}${n.summary || ''}`,
              meta: n.status === 'firing' ? 'cobrando' : (n.execute_at ? fmtRelative(n.execute_at) : ''),
            }))}
          />
        </HomeCard>

        {/* Proposals awaiting */}
        <HomeCard
          cat="proposal" icon={Icon.proposals(20)} title="Propostas aguardando"
          count={propRows.length} onOpen={() => onNavigate('proposals')} linkLabel="Decidir propostas"
        >
          <Rows
            empty="Nenhuma proposta aguardando decisão."
            items={propRows.slice(0, 5).map((p) => ({
              color: 'var(--cat-proposal)',
              text: p.title || p.name || p.explanation || p.id,
              meta: p.provider || '',
            }))}
          />
        </HomeCard>

        {/* Recent activity */}
        <HomeCard
          cat="task" icon={Icon.activity(20)} title="Atividade recente"
          onOpen={() => onNavigate('events')} linkLabel="Ver eventos"
        >
          <Rows
            empty="Sem eventos recentes."
            items={eventRows.slice(0, 5).map((e) => ({
              text: `${e.source || '?'} · ${e.kind || ''}`,
              meta: e.timestamp ? fmtRelative(e.timestamp) : '',
            }))}
          />
        </HomeCard>

        {/* Stats */}
        <HomeCard
          cat="person" icon={Icon.missions(20)} title="Missions"
          onOpen={() => onNavigate('missions')} linkLabel="Abrir missions"
        >
          <div className="home-stats-strip">
            <div className="home-stat">
              <span className="home-stat-value">{stats.data?.total ?? '—'}</span>
              <span className="home-stat-label">Total</span>
            </div>
            <div className="home-stat">
              <span className="home-stat-value">{byStatus.pending ?? 0}</span>
              <span className="home-stat-label">Pendentes</span>
            </div>
            <div className="home-stat">
              <span className="home-stat-value">{byStatus.running ?? 0}</span>
              <span className="home-stat-label">Rodando</span>
            </div>
            <div className="home-stat">
              <span className="home-stat-value">{stats.data?.upcomingIn24h ?? 0}</span>
              <span className="home-stat-label">Próximas 24h</span>
            </div>
          </div>
        </HomeCard>
      </div>
    </section>
  );
}
