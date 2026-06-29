import { useState, useRef, useEffect } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getCurrentEnv } from '../config/fmpEnvironments';
import './AgentPanel.css';

const SUGGESTIONS = [
  'Which inspections need repair?',
  'How many Shopify products were added in the last 3 months?',
  'What are our open invoices in QuickBooks?',
  'Summarize the most recent project',
];

const MODULE_LABEL = { inspections: 'Inspection', contacts: 'Contact', projects: 'Project', products: 'Product' };

export default function AgentPanel({ open, onClose, onOpenRecord, seedQuery, onSeedConsumed }) {
  const [messages, setMessages] = useState([]); // { role, content, sources?, error? }
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const seededRef = useRef(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  // When opened from the command palette with a query, auto-send it once.
  useEffect(() => {
    if (!open) { seededRef.current = null; return; }
    if (seedQuery && seededRef.current !== seedQuery) {
      seededRef.current = seedQuery;
      send(seedQuery);
      onSeedConsumed?.();
    }
  }, [open, seedQuery]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading, status]);

  // Patch the last (streaming) assistant message.
  const patchLast = updater => setMessages(m => {
    const copy = m.slice();
    const i = copy.length - 1;
    copy[i] = { ...copy[i], ...updater(copy[i]) };
    return copy;
  });

  async function send(text) {
    const q = (text ?? input).trim();
    if (!q || loading) return;
    const history = [...messages, { role: 'user', content: q }];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setInput('');
    setLoading(true);
    setStatus('');
    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ db: getCurrentEnv().db, messages: history.map(m => ({ role: m.role, content: m.content })) }),
      });
      if (!res.ok || !res.body) {
        const detail = res.status === 404
          ? 'The assistant only runs on the deployed app, not in local preview.'
          : (await res.json().catch(() => ({}))).error || `Request failed (${res.status})`;
        patchLast(() => ({ content: `⚠️ ${detail}`, error: true }));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, idx).split('\n').find(l => l.startsWith('data:'));
          buf = buf.slice(idx + 2);
          if (!line) continue;
          let evt; try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (evt.type === 'delta') { setStatus(''); patchLast(cur => ({ content: (cur.content || '') + evt.text })); }
          else if (evt.type === 'status') setStatus(evt.text);
          else if (evt.type === 'sources') patchLast(() => ({ sources: evt.sources }));
          else if (evt.type === 'error') patchLast(cur => ({ content: cur.content || `⚠️ ${evt.error}`, error: !cur.content }));
        }
      }
      patchLast(cur => (cur.content ? {} : { content: '(no answer)' }));
    } catch (e) {
      patchLast(() => ({ content: `⚠️ ${e.message || 'Network error'}`, error: true }));
    } finally {
      setLoading(false);
      setStatus('');
    }
  }

  if (!open) return null;

  return (
    <div className="agent-panel">
      <div className="agent-head">
        <span className="agent-title"><span className="agent-spark">✦</span> Assistant</span>
        <div className="agent-head-right">
          {messages.length > 0 && <button className="agent-clear" onClick={() => setMessages([])} title="Clear conversation">Clear</button>}
          <button className="agent-close" onClick={onClose} title="Close">✕</button>
        </div>
      </div>

      <div className="agent-body" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="agent-empty">
            <p className="agent-empty-title">Ask about your records</p>
            <p className="agent-empty-sub">FileMaker records, Shopify store, and QuickBooks — read-only.</p>
            <div className="agent-suggest">
              {SUGGESTIONS.map(s => (
                <button key={s} className="agent-chip" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`agent-msg ${m.role}${m.error ? ' error' : ''}`}>
              <div className="agent-bubble">
                {m.role === 'assistant' && m.content
                  ? <div className="agent-markdown"><Markdown remarkPlugins={[remarkGfm]}>{m.content}</Markdown></div>
                  : m.content || (m.role === 'assistant' && loading && i === messages.length - 1
                    ? <span className="agent-typing"><span></span><span></span><span></span></span>
                    : '')}
              </div>
              {m.sources?.length > 0 && (
                <div className="agent-sources">
                  {m.sources.map(s => (
                    <button key={`${s.module}:${s.recordId}`} className="agent-source" title={`Open in ${s.module}`}
                      onClick={() => onOpenRecord?.(s.module, s.recordId)}>
                      <span className="agent-source-mod">{MODULE_LABEL[s.module] || s.module}</span>
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
        {status && <div className="agent-status">{status}</div>}
      </div>

      <form className="agent-input" onSubmit={e => { e.preventDefault(); send(); }}>
        <textarea
          ref={inputRef}
          value={input}
          rows={1}
          placeholder="Ask a question…"
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <button type="submit" disabled={!input.trim() || loading} title="Send">↑</button>
      </form>
    </div>
  );
}
