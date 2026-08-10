import { useMemo } from 'react';
import { useFetch } from '../lib/useFetch.js';
import { categoryOf, expandOccurrences } from '../lib/format.js';
import { PageHeader, Subtitle, ErrorState, Skeleton } from '../components/ui.jsx';

// Vertical agenda (timeline). Tasks (recurrence/next_run/execute_at) and
// nudges (follow-ups) are expanded into dated occurrences over the next 30
// days, grouped into Hoje / Amanhã / Esta semana / Mais adiante. Each item is
// a row with its time, a category-colored dot, and the title.

const DOW = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

const LEGEND = [
  ['person', '1:1 / pessoa'],
  ['ritual', 'ritual'],
  ['deadline', 'deadline'],
  ['nudge', 'cobrança'],
  ['task', 'task'],
];

function dayKey(d) { return d.toISOString().slice(0, 10); }

function bucketFor(date, today) {
  const diff = Math.round((date - today) / 86400000);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff <= 7) return 'week';
  return 'later';
}

const BUCKET_META = {
  today: { title: 'Hoje', order: 0 },
  tomorrow: { title: 'Amanhã', order: 1 },
  week: { title: 'Esta semana', order: 2 },
  later: { title: 'Mais adiante', order: 3 },
};

export default function Calendar() {
  const tasks = useFetch('/api/tasks?status=pending', { pollMs: 30000 });
  const nudges = useFetch('/api/nudges', { pollMs: 30000 });

  const loading = tasks.loading;
  const error = tasks.error;

  const groups = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const items = [];

    const taskRows = Array.isArray(tasks.data) ? tasks.data : [];
    for (const t of taskRows) {
      if (!t.recurrence && !t.next_run && !t.execute_at) continue;
      for (const occ of expandOccurrences(t, 30)) {
        items.push({
          date: occ.date, time: occ.time, title: t.summary || '(sem título)',
          cat: categoryOf(t.type), sub: t.type, project: t.project,
        });
      }
    }

    const nudgeRows = Array.isArray(nudges.data) ? nudges.data : [];
    for (const n of nudgeRows) {
      if (n.status === 'done' || !n.execute_at) continue;
      const d = new Date(n.execute_at);
      if (Number.isNaN(d.getTime())) continue;
      const day = new Date(d); day.setHours(0, 0, 0, 0);
      const within = (day - today) / 86400000;
      if (within < 0 || within > 30) continue;
      const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
      let person = '';
      try { person = JSON.parse(n.people || '[]')[0] || ''; } catch { /* ignore */ }
      items.push({
        date: day,
        time: hasTime ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : null,
        title: `${person ? person + ' — ' : ''}${n.summary || 'follow-up'}`,
        cat: 'nudge', sub: n.status === 'firing' ? 'cobrando' : 'cobrança',
      });
    }

    // Group by bucket → by day.
    const buckets = {};
    for (const it of items) {
      const b = bucketFor(it.date, today);
      const dk = dayKey(it.date);
      buckets[b] = buckets[b] || { days: {} };
      buckets[b].days[dk] = buckets[b].days[dk] || { date: it.date, items: [] };
      buckets[b].days[dk].items.push(it);
    }

    return Object.entries(buckets)
      .map(([key, val]) => {
        const days = Object.values(val.days).sort((a, b) => a.date - b.date);
        days.forEach((d) => d.items.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99')));
        const count = days.reduce((s, d) => s + d.items.length, 0);
        return { key, ...BUCKET_META[key], days, count };
      })
      .sort((a, b) => a.order - b.order);
  }, [tasks.data, nudges.data]);

  const total = groups.reduce((s, g) => s + g.count, 0);

  return (
    <section className="page active">
      <PageHeader title="Agenda" />
      <Subtitle>
        Sua linha do tempo de gestão — 1:1s, rituais, deadlines e cobranças nos próximos 30 dias,
        em ordem cronológica.
      </Subtitle>

      <div className="agenda-legend">
        {LEGEND.map(([cat, label]) => (
          <span className="agenda-legend-item" key={cat}>
            <span className="agenda-legend-dot" style={{ background: `var(--cat-${cat})` }} />
            {label}
          </span>
        ))}
      </div>

      {loading && <div className="agenda"><Skeleton count={5} /></div>}
      {!loading && error && <ErrorState title="Agenda indisponível" message="Não foi possível carregar a agenda." />}
      {!loading && !error && total === 0 && (
        <div className="agenda-empty-day">Nada agendado nos próximos 30 dias.</div>
      )}

      {!loading && !error && total > 0 && (
        <div className="agenda">
          {groups.map((g) => (
            <div key={g.key} className="agenda-group">
              <div className="agenda-group-head">
                <span className="agenda-group-title">{g.title}</span>
                <span className="agenda-group-count">{g.count} {g.count === 1 ? 'item' : 'itens'}</span>
              </div>
              {g.days.map((d) => (
                <div className="agenda-day" key={dayKey(d.date)}>
                  {g.key !== 'today' && g.key !== 'tomorrow' && (
                    <div className="agenda-day-label">
                      {d.date.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}
                      <span className="dow">{DOW[d.date.getDay()]}</span>
                    </div>
                  )}
                  <div className="agenda-items">
                    {d.items.map((it, i) => (
                      <div className="agenda-item" key={i} style={{ '--cat': `var(--cat-${it.cat})` }}>
                        <span className={`agenda-item-time${it.time ? '' : ' allday'}`}>{it.time || 'dia todo'}</span>
                        <span className="agenda-item-dot" />
                        <span className="agenda-item-text">
                          <span className="agenda-item-title">{it.title}</span>
                          {it.sub && <span className="agenda-item-sub">{it.sub}</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
