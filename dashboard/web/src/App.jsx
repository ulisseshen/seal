import { useState, useEffect, useCallback } from 'react';
import { api } from './lib/api.js';
import { Icon } from './components/icons.jsx';

import Home from './tabs/Home.jsx';
import Missions from './tabs/Missions.jsx';
import Channels from './tabs/Channels.jsx';
import Chat from './tabs/Chat.jsx';
import Logs from './tabs/Logs.jsx';
import Calendar from './tabs/Calendar.jsx';
import Workspaces from './tabs/Workspaces.jsx';
import Events from './tabs/Events.jsx';
import Patterns from './tabs/Patterns.jsx';
import Proposals from './tabs/Proposals.jsx';
import Skills from './tabs/Skills.jsx';
import Team from './tabs/Team.jsx';
import Ingest from './tabs/Ingest.jsx';
import Nudges from './tabs/Nudges.jsx';
import Daily from './tabs/Daily.jsx';

// Tab registry. `cat` ties each tab to its category hue (the spine); the active
// icon and nav badge pick it up. `badge` names the live counter to surface.
const TABS = {
  home: { label: 'Home', icon: Icon.home, Comp: Home, cat: 'person' },
  calendar: { label: 'Calendário', icon: Icon.calendar, Comp: Calendar, cat: 'ritual' },
  missions: { label: 'Missions', icon: Icon.missions, Comp: Missions, cat: 'person' },
  workspaces: { label: 'Workspaces', icon: Icon.workspaces, Comp: Workspaces, cat: 'task' },
  logs: { label: 'Logs', icon: Icon.logs, Comp: Logs, cat: 'task' },
  patterns: { label: 'Patterns', icon: Icon.patterns, Comp: Patterns, cat: 'skill' },
  proposals: { label: 'Proposals', icon: Icon.proposals, Comp: Proposals, cat: 'proposal', badge: 'proposals' },
  skills: { label: 'Skills', icon: Icon.skills, Comp: Skills, cat: 'skill' },
  ingest: { label: 'Ingest', icon: Icon.ingest, Comp: Ingest, cat: 'task' },
  nudges: { label: 'Cobranças', icon: Icon.bell, Comp: Nudges, cat: 'nudge', badge: 'nudges' },
  daily: { label: 'Daily', icon: Icon.calendar, Comp: Daily, cat: 'ritual' },
  team: { label: 'Team', icon: Icon.team, Comp: Team, cat: 'person' },
  chat: { label: 'Chat', icon: Icon.chat, Comp: Chat, cat: 'ritual' },
  channels: { label: 'Channels', icon: Icon.channels, Comp: Channels, cat: 'task' },
  events: { label: 'Events', icon: Icon.events, Comp: Events, cat: 'task' },
};

// Grouped navigation — discreet section headers, expanded by default.
const SECTIONS = [
  { title: 'Visão geral', items: ['home', 'calendar'] },
  { title: 'Trabalho', items: ['missions', 'workspaces', 'logs'] },
  { title: 'Cérebro', items: ['patterns', 'proposals', 'skills', 'ingest'] },
  { title: 'Pessoas', items: ['daily', 'nudges', 'team'] },
  { title: 'Canais', items: ['chat', 'channels', 'events'] },
];

function HeaderStats() {
  const [stats, setStats] = useState(null);
  const load = useCallback(async () => {
    try { setStats(await api.get('/api/stats')); } catch { /* keep last */ }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    const h = () => load();
    window.addEventListener('seal:stats-refresh', h);
    return () => window.removeEventListener('seal:stats-refresh', h);
  }, [load]);

  if (!stats) return <div className="sidebar-stats" />;
  const byStatus = {};
  (stats.byStatus || []).forEach((s) => { byStatus[s.status] = s.count; });
  const items = [
    { label: 'Total', value: stats.total },
    { label: 'Pendentes', value: byStatus.pending || 0 },
    { label: 'Próx. 24h', value: stats.upcomingIn24h },
  ];
  return (
    <div className="sidebar-stats">
      {items.map((it) => (
        <div className="stat-item" key={it.label}>
          <span className="stat-label">{it.label}</span>
          <span className="stat-value">{it.value}</span>
        </div>
      ))}
    </div>
  );
}

// Live counters for the nav badges (cobranças firing/pending, undecided proposals).
function useNavBadges() {
  const [badges, setBadges] = useState({ nudges: 0, proposals: 0 });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [nudges, proposals] = await Promise.all([
          api.get('/api/nudges').catch(() => []),
          api.get('/api/proposals?decided=false').catch(() => []),
        ]);
        if (!alive) return;
        const n = Array.isArray(nudges) ? nudges.filter((x) => x.status !== 'done').length : 0;
        const p = Array.isArray(proposals) ? proposals.length : 0;
        setBadges({ nudges: n, proposals: p });
      } catch { /* keep last */ }
    };
    load();
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return badges;
}

export default function App() {
  const [active, setActive] = useState('home');
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('seal-sidebar-collapsed') === 'true'
  );
  const badges = useNavBadges();

  const toggle = () => {
    setCollapsed((c) => {
      localStorage.setItem('seal-sidebar-collapsed', String(!c));
      return !c;
    });
  };

  const ActiveComp = TABS[active]?.Comp || Home;

  return (
    <div className="app">
      <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
        <div className="sidebar-header">
          <img className="sidebar-logo-img" src="./seal-logo.png" alt="SEAL" width="30" height="30" />
          <span className="sidebar-brand">SEAL</span>
        </div>
        <nav className="sidebar-nav">
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <div className="nav-section-label">{section.title}</div>
              {section.items.map((id) => {
                const t = TABS[id];
                if (!t) return null;
                const count = t.badge ? badges[t.badge] : 0;
                return (
                  <button
                    key={id}
                    className={`sidebar-item${active === id ? ' active' : ''}`}
                    title={t.label}
                    style={{ '--cat': `var(--cat-${t.cat})` }}
                    onClick={() => setActive(id)}
                  >
                    {t.icon()}
                    <span className="sidebar-label">{t.label}</span>
                    {count > 0 && <span className="nav-badge">{count}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <HeaderStats />
          <button className="sidebar-collapse-btn" onClick={toggle} title="Recolher menu">
            {Icon.chevron()}
            <span className="sidebar-label">Recolher</span>
          </button>
        </div>
      </aside>

      <main className="content">
        {/* key forces a clean remount per tab — tears down any polling. */}
        <ActiveComp key={active} onNavigate={setActive} />
      </main>
    </div>
  );
}
