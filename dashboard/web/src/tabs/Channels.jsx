import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';
import { PageHeader, Button } from '../components/ui.jsx';

const CHANNEL_DEFS = [
  { key: 'discord', name: 'Discord', icon: '🟣', fields: [{ key: 'webhook_url', label: 'Webhook URL', type: 'text' }] },
  { key: 'telegram', name: 'Telegram', icon: '🔵', fields: [{ key: 'bot_token', label: 'Bot Token', type: 'password' }, { key: 'chat_id', label: 'Chat ID', type: 'text' }] },
  { key: 'slack', name: 'Slack', icon: '🟢', fields: [{ key: 'webhook_url', label: 'Webhook URL', type: 'text' }] },
  { key: 'system', name: 'System', icon: '💻', fields: [] },
];

const DEFAULTS = {
  discord: { enabled: false, webhook_url: '' },
  telegram: { enabled: false, bot_token: '', chat_id: '' },
  slack: { enabled: false, webhook_url: '' },
  system: { enabled: true },
};

export default function Channels() {
  const [data, setData] = useState(DEFAULTS);

  useEffect(() => {
    api.get('/api/channels').then(setData).catch(() => setData(DEFAULTS));
  }, []);

  const setField = (ch, field, value) =>
    setData((d) => ({ ...d, [ch]: { ...(d[ch] || {}), [field]: value } }));

  const toggle = (ch) =>
    setData((d) => ({ ...d, [ch]: { ...(d[ch] || {}), enabled: !(d[ch]?.enabled) } }));

  async function save() {
    try {
      const saved = await api.put('/api/channels', data);
      setData(saved);
    } catch (err) { alert('Failed to save channels: ' + err.message); }
  }

  async function test(channel) {
    try {
      const r = await api.post('/api/channels/test', { channel });
      alert(r.message || 'Test sent!');
    } catch (err) { alert('Test failed: ' + err.message); }
  }

  return (
    <section className="page active">
      <PageHeader title="Notification Channels" />
      <div className="channels-grid">
        {CHANNEL_DEFS.map((ch) => {
          const d = data[ch.key] || {};
          const enabled = !!d.enabled;
          return (
            <div className="channel-card" key={ch.key}>
              <div className="channel-header">
                <span className="channel-name">
                  <span className="channel-icon">{ch.icon}</span>{ch.name}
                </span>
                <div className={`channel-status${enabled ? ' connected' : ''}`} title={enabled ? 'Connected' : 'Disconnected'} />
              </div>
              <div className="channel-fields">
                {ch.fields.length > 0 ? ch.fields.map((f) => (
                  <div className="channel-field" key={f.key}>
                    <label>{f.label}</label>
                    <input
                      type={f.type} value={d[f.key] || ''}
                      placeholder={`Enter ${f.label.toLowerCase()}...`}
                      onChange={(e) => setField(ch.key, f.key, e.target.value)}
                    />
                  </div>
                )) : (
                  <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                    System notifications use macOS native alerts. No configuration needed.
                  </p>
                )}
              </div>
              <div className="channel-actions">
                <div className={`toggle${enabled ? ' active' : ''}`} onClick={() => toggle(ch.key)} />
                <Button variant="ghost" size="sm" onClick={save}>Save</Button>
                <Button variant="ghost" size="sm" onClick={() => test(ch.key)}>Test</Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
