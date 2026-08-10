import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { renderMarkdown } from '../lib/markdown.jsx';
import { Button } from '../components/ui.jsx';

const SESSION = 'default';

function Bubble({ role, content, streaming }) {
  // user/assistant content is markdown; streaming text is plain (escaped by React).
  if (streaming) {
    return <div className="chat-message ai streaming">{content}</div>;
  }
  return (
    <div
      className={`chat-message ${role === 'user' ? 'user' : 'ai'}`}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
    />
  );
}

export default function Chat() {
  const [messages, setMessages] = useState([]); // {role, content}
  const [streaming, setStreaming] = useState(null); // string while assistant streams
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [cfg, setCfg] = useState({ providers: [], provider: '', model: '', system_prompt: '', secrets_backend: '' });
  const scrollRef = useRef(null);

  useEffect(() => {
    api.get('/api/chat-config').then((c) => {
      setCfg({
        providers: c.providers || [],
        provider: c.provider || (c.providers || []).find((p) => p.is_default)?.name || '',
        model: c.model || '',
        system_prompt: c.system_prompt || '',
        secrets_backend: c.secrets_backend || '',
      });
    }).catch(() => {});
    api.get(`/api/chat/history?session_id=${SESSION}&limit=100`).then((rows) => {
      if (Array.isArray(rows)) {
        setMessages(rows.filter((r) => r.role === 'user' || r.role === 'assistant')
          .map((r) => ({ role: r.role, content: r.content })));
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  async function saveConfig() {
    try {
      await api.put('/api/chat-config', {
        provider: cfg.provider, model: cfg.model || null, system_prompt: cfg.system_prompt,
      });
    } catch (err) { alert('Failed to save chat config: ' + err.message); }
  }

  async function send() {
    if (busy) return;
    const text = input.trim();
    if (!text) return;

    const history = [...messages, { role: 'user', content: text }];
    setMessages(history);
    setInput('');
    setStreaming('');
    setBusy(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: cfg.provider || undefined,
          model: cfg.model || undefined,
          system_prompt: cfg.system_prompt || undefined,
          messages: history,
          session_id: SESSION,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setStreaming(null);
        setMessages((m) => m.slice(0, -1)); // drop user turn so they can retry
        setMessages((m) => [...m, { role: 'assistant', content: `⚠ ${err.error}` }]);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';
      let hadError = null;

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let event = 'message';
          let data = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          let payload;
          try { payload = JSON.parse(data); } catch { continue; }
          if (event === 'chunk' && payload.text) {
            accumulated += payload.text;
            setStreaming(accumulated);
          } else if (event === 'error') {
            hadError = payload.message;
          }
        }
      }

      setStreaming(null);
      if (hadError) {
        setMessages((m) => m.slice(0, -1));
        setMessages((m) => [...m, { role: 'assistant', content: `⚠ ${hadError}` }]);
      } else {
        setMessages((m) => [...m, { role: 'assistant', content: accumulated }]);
      }
    } catch (err) {
      setStreaming(null);
      setMessages((m) => m.slice(0, -1));
      setMessages((m) => [...m, { role: 'assistant', content: `⚠ ${err.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  const empty = messages.length === 0 && streaming === null;

  return (
    <section className="page active">
      <div className="chat-container">
        <div className="chat-messages" ref={scrollRef}>
          {empty && (
            <div className="chat-welcome">
              <div className="chat-welcome-icon">
                <img className="sidebar-logo-img" src="./seal-logo.png" alt="SEAL" width="64" height="64" />
              </div>
              <h3>SEAL Chat</h3>
              <p>Talk to your autonomous assistant. Configure the AI model below to get started.</p>
            </div>
          )}
          {messages.map((m, i) => <Bubble key={i} role={m.role} content={m.content} />)}
          {streaming !== null && <Bubble role="assistant" content={streaming} streaming />}
        </div>

        <div className="chat-input-area">
          <input
            type="text" placeholder="Type a message..." value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <Button variant="primary" className="btn-send" onClick={send} disabled={busy}>
            {Icons.send}
          </Button>
        </div>

        <div className="chat-config">
          <h4>Chat Configuration</h4>
          <div className="config-row">
            <label>Provider</label>
            <select value={cfg.provider} onChange={(e) => setCfg((c) => ({ ...c, provider: e.target.value }))}>
              {cfg.providers.map((p) => (
                <option key={p.name} value={p.name} disabled={!p.available}>
                  {p.name}{p.available ? '' : ' (not configured)'}
                </option>
              ))}
            </select>
          </div>
          <div className="config-row">
            <label>Model</label>
            <input type="text" placeholder="(provider default)" value={cfg.model}
              onChange={(e) => setCfg((c) => ({ ...c, model: e.target.value }))} />
          </div>
          <div className="config-row">
            <label>System Prompt</label>
            <textarea rows="3" placeholder="You are SEAL..." value={cfg.system_prompt}
              onChange={(e) => setCfg((c) => ({ ...c, system_prompt: e.target.value }))} />
          </div>
          <p className="config-hint">
            API keys live in your OS keychain (<span>{cfg.secrets_backend}</span>).
            Configure credentials with: <code>seal setup provider &lt;name&gt;</code>
          </p>
          <Button variant="primary" size="sm" onClick={saveConfig}>Save Config</Button>
        </div>
      </div>
    </section>
  );
}

const Icons = {
  send: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22,2 15,22 11,13 2,9" />
    </svg>
  ),
};
