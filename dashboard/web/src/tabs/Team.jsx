import { useFetch } from '../lib/useFetch.js';
import { fmtRelative } from '../lib/format.js';
import { PageHeader, Subtitle, EmptyState, ErrorState, Skeleton } from '../components/ui.jsx';

export default function Team() {
  const { data, loading, error } = useFetch('/api/team');
  const rows = Array.isArray(data) ? data : [];

  return (
    <section className="page active">
      <PageHeader title="Team" />
      <Subtitle>
        Auto-populated from git commits. Add roles and notes so SEAL knows who does what.
        New contributors trigger an alert the first time they appear.
      </Subtitle>
      <div className="team-list">
        {loading && <Skeleton count={4} />}
        {!loading && error && <ErrorState title="Failed to load team" message={error.message} />}
        {!loading && !error && rows.length === 0 && (
          <EmptyState icon="👥" title="No team members yet">SEAL auto-populates this from git commit authors. Add a workspace to start.</EmptyState>
        )}
        {!loading && !error && rows.length > 0 && (
          <table className="team-table">
            <thead><tr><th>Name</th><th>Email</th><th>Commits</th><th>Repos</th><th>Role</th><th>Last seen</th></tr></thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.email} className={m.is_me ? 'team-me' : ''}>
                  <td><strong>{m.name}</strong>{m.is_me && <span className="team-badge">you</span>}</td>
                  <td className="team-email">{m.email}</td>
                  <td>{m.commit_count}</td>
                  <td>{(Array.isArray(m.repos) ? m.repos : []).length}</td>
                  <td>{m.role || <span className="dim">—</span>}</td>
                  <td>{fmtRelative(m.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
