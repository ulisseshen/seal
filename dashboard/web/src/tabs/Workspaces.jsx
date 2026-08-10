import { useState } from 'react';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/useFetch.js';
import { PageHeader, Button, EmptyState, ErrorState } from '../components/ui.jsx';
import { Icon } from '../components/icons.jsx';

export default function Workspaces() {
  const { data, loading, error, reload } = useFetch('/api/workspaces', { pollMs: 10000 });
  const repos = Array.isArray(data) ? data : [];

  const [showAdd, setShowAdd] = useState(false);
  const [pickedPath, setPickedPath] = useState(null);
  const [scan, setScan] = useState([]);       // [{path,name,already_watched}]
  const [selected, setSelected] = useState(() => new Set());
  const [status, setStatus] = useState('');
  const [scanState, setScanState] = useState('idle'); // idle | scanning | done | error

  function resetAdd() {
    setShowAdd(false); setPickedPath(null); setScan([]); setSelected(new Set());
    setStatus(''); setScanState('idle');
  }

  async function pickFolder() {
    setStatus('');
    try {
      const d = await api.post('/api/pick-folder');
      if (d.cancelled) return;
      if (!d.path) throw new Error(d.error || 'pick failed');
      setPickedPath(d.path);
      await runScan(d.path);
    } catch (err) { setStatus(`Picker failed: ${err.message}`); }
  }

  async function runScan(parentPath) {
    setScanState('scanning'); setScan([]); setSelected(new Set()); setStatus('');
    try {
      const d = await api.post('/api/workspaces/scan', { parent_path: parentPath });
      setScan(d.repos || []);
      setScanState('done');
    } catch (err) {
      setStatus(`Scan failed: ${err.message}`);
      setScanState('error');
    }
  }

  async function watchSelected() {
    const paths = Array.from(selected);
    if (paths.length === 0) return;
    setStatus(`Installing hooks in ${paths.length} repo(s)…`);
    try {
      const d = await api.post('/api/workspaces/bulk', { paths });
      const ok = (d.added || []).length;
      const failed = (d.failed || []).length;
      setStatus(`Added ${ok}${failed ? `, ${failed} failed` : ''}.`);
      reload();
    } catch (err) { setStatus(`Bulk install failed: ${err.message}`); }
  }

  async function remove(id) {
    if (!confirm('Stop watching this workspace? SEAL will uninstall its git hooks (and restore any backup).')) return;
    try { await api.del(`/api/workspaces/${id}`); reload(); }
    catch (err) { alert(`Failed to remove workspace: ${err.message}`); }
  }

  const toggleSel = (path) => setSelected((p) => {
    const n = new Set(p); n.has(path) ? n.delete(path) : n.add(path); return n;
  });

  return (
    <section className="page active">
      <PageHeader title="Workspaces">
        <Button variant="primary" onClick={() => setShowAdd((s) => !s)}>{Icon.plus()} Add workspace</Button>
      </PageHeader>

      {showAdd && (
        <div className="workspace-add-panel">
          <h4>Scan a parent folder for git repos</h4>
          <div className="workspace-add-row">
            <Button variant="primary" size="sm" onClick={pickFolder}>Browse…</Button>
            {pickedPath && <span className="workspace-picked-path">{pickedPath}</span>}
            <Button variant="ghost" size="sm" onClick={resetAdd}>Cancel</Button>
          </div>
          <div className="workspace-scan-results">
            {scanState === 'scanning' && <div className="ws-scan-loading">Scanning…</div>}
            {scanState === 'done' && scan.length === 0 && (
              <div className="ws-scan-empty">No git repositories found directly under <code>{pickedPath}</code>.</div>
            )}
            {scanState === 'done' && scan.map((r) => (
              <label className={`ws-scan-row${r.already_watched ? ' watching' : ''}`} key={r.path}>
                <input type="checkbox" disabled={r.already_watched}
                  checked={selected.has(r.path)} onChange={() => toggleSel(r.path)} />
                <span className="ws-scan-name">{r.name}</span>
                <span className="ws-scan-path">{r.path}</span>
                {r.already_watched && <span className="ws-scan-tag">watching</span>}
              </label>
            ))}
          </div>
          {scanState === 'done' && scan.length > 0 && (
            <div className="workspace-scan-actions">
              <Button variant="success" size="sm" onClick={watchSelected}>Watch selected</Button>
              <span className="workspace-scan-status">{status}</span>
            </div>
          )}
          {(scanState === 'error' || (scanState !== 'done' && status)) && (
            <span className="workspace-scan-status">{status}</span>
          )}
        </div>
      )}

      <div className="workspaces-list">
        {loading && !data && <EmptyState title="Loading…" />}
        {!loading && error && <ErrorState title="Could not load workspaces" message={error.message} />}
        {!error && repos.length === 0 && (
          <EmptyState icon="📁" title="No workspaces watched yet">
            Click "Add workspace" above to scan a parent folder for git repositories.
          </EmptyState>
        )}
        {!error && repos.length > 0 && (
          <table className="workspaces-table">
            <thead><tr><th>Name</th><th>Path</th><th>Installed</th><th>Hook status</th><th></th></tr></thead>
            <tbody>
              {repos.map((r) => {
                const installed = r.installed_at ? new Date(r.installed_at).toLocaleString() : '—';
                const hooksOk = r.hooks_installed && r.has_seal_hooks;
                const statusLabel = hooksOk ? 'installed' : (r.fallback_scraper ? 'fallback only' : 'missing');
                const statusClass = hooksOk ? 'ok' : (r.fallback_scraper ? 'warn' : 'err');
                return (
                  <tr key={r.id}>
                    <td><strong>{r.name}</strong></td>
                    <td className="ws-path" title={r.path}>{r.path}</td>
                    <td>{installed}</td>
                    <td><span className={`ws-hook-badge ${statusClass}`}>{statusLabel}</span></td>
                    <td className="ws-actions"><Button variant="danger" size="sm" onClick={() => remove(r.id)}>Remove</Button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
