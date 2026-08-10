import { useState } from 'react';
import { api } from '../lib/api.js';
import { Button } from './ui.jsx';

// Converts an ISO instant into the value a datetime-local input expects
// (local wall-clock, no timezone suffix). Mirrors the original app.js logic.
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export default function MissionModal({ task, onClose, onSaved }) {
  const editing = Boolean(task);
  const [form, setForm] = useState({
    summary: task?.summary || '',
    type: task?.type || 'task',
    priority: task?.priority || 'medium',
    detail: task?.detail || '',
    recurrence: task?.recurrence || '',
    next_run: toLocalInput(task?.next_run),
    prompt: task?.prompt || '',
    project: task?.project || '',
    notify_type: task?.notify_type || 'sound',
  });
  const [saving, setSaving] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save() {
    if (!form.summary.trim()) return;
    setSaving(true);
    const body = {
      type: form.type,
      summary: form.summary.trim(),
      detail: form.detail || null,
      recurrence: form.recurrence || null,
      next_run: form.next_run ? new Date(form.next_run).toISOString() : null,
      prompt: form.prompt || null,
      project: form.project || null,
      priority: form.priority,
      notify_type: form.notify_type,
    };
    try {
      if (editing) await api.put(`/api/tasks/${task.id}`, body);
      else await api.post('/api/tasks', body);
      onSaved();
    } catch (err) {
      alert('Failed to save mission: ' + err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal-header">
          <h3>{editing ? 'Edit Mission' : 'New Mission'}</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>Summary</label>
            <input type="text" placeholder="What needs to happen?" value={form.summary} onChange={set('summary')} autoFocus />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Type</label>
              <select value={form.type} onChange={set('type')}>
                <option value="task">Task</option>
                <option value="reminder">Reminder</option>
                <option value="ritual">Ritual</option>
                <option value="deadline">Deadline</option>
                <option value="decision">Decision</option>
                <option value="person">Person</option>
              </select>
            </div>
            <div className="form-group">
              <label>Priority</label>
              <select value={form.priority} onChange={set('priority')}>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>Detail</label>
            <textarea rows="3" placeholder="Additional context..." value={form.detail} onChange={set('detail')} />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Recurrence (cron)</label>
              <input type="text" placeholder="0 9 * * 1-5" value={form.recurrence} onChange={set('recurrence')} />
            </div>
            <div className="form-group">
              <label>Next Run</label>
              <input type="datetime-local" value={form.next_run} onChange={set('next_run')} />
            </div>
          </div>
          <div className="form-group">
            <label>Prompt / Command</label>
            <textarea rows="3" placeholder="Command to execute..." value={form.prompt} onChange={set('prompt')} />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Project</label>
              <input type="text" placeholder="/path/to/project" value={form.project} onChange={set('project')} />
            </div>
            <div className="form-group">
              <label>Notify Type</label>
              <select value={form.notify_type} onChange={set('notify_type')}>
                <option value="sound">Sound</option>
                <option value="silent">Silent</option>
                <option value="sticky">Sticky</option>
                <option value="nuclear">Nuclear</option>
                <option value="supernova">Supernova</option>
              </select>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save Mission'}
          </Button>
        </div>
      </div>
    </div>
  );
}
