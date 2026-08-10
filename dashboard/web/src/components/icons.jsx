// Inline stroke icons (Feather-style), ported from index.html so the new app
// has zero icon-font dependency. `s` = size.
const base = (s) => ({
  width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
});

export const Icon = {
  missions: (s = 20) => (<svg {...base(s)}><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></svg>),
  channels: (s = 20) => (<svg {...base(s)}><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" /></svg>),
  chat: (s = 20) => (<svg {...base(s)}><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>),
  logs: (s = 20) => (<svg {...base(s)}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14,2 14,8 20,8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>),
  calendar: (s = 20) => (<svg {...base(s)}><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>),
  workspaces: (s = 20) => (<svg {...base(s)}><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" /></svg>),
  events: (s = 20) => (<svg {...base(s)}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>),
  patterns: (s = 20) => (<svg {...base(s)}><path d="M4 6h16M4 12h10M4 18h6" /><circle cx="18" cy="12" r="2" /><circle cx="14" cy="18" r="2" /></svg>),
  proposals: (s = 20) => (<svg {...base(s)}><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" /></svg>),
  skills: (s = 20) => (<svg {...base(s)}><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>),
  team: (s = 20) => (<svg {...base(s)}><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" /></svg>),
  ingest: (s = 20) => (<svg {...base(s)}><path d="M20 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0020 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></svg>),
  nudges: (s = 20) => (<svg {...base(s)}><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" /></svg>),
  search: (s = 16) => (<svg {...base(s)}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>),
  plus: (s = 16) => (<svg {...base(s)}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>),
  send: (s = 18) => (<svg {...base(s)}><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22,2 15,22 11,13 2,9" /></svg>),
  chevron: (s = 18) => (<svg {...base(s)}><polyline points="15 18 9 12 15 6" /></svg>),
  home: (s = 20) => (<svg {...base(s)}><path d="M3 9.5L12 3l9 6.5" /><path d="M5 10v9a1 1 0 001 1h12a1 1 0 001-1v-9" /><path d="M9 21v-6h6v6" /></svg>),
  arrowRight: (s = 16) => (<svg {...base(s)}><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>),
  activity: (s = 20) => (<svg {...base(s)}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>),
  bell: (s = 20) => (<svg {...base(s)}><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" /></svg>),
};
