import { useState, useEffect, useRef } from 'react';
import { fetchInvoicePdfFile, invoiceFileName } from '../api/invoices';
import './AttachmentsPanel.css';

// Reusable file-attachments panel. Pass a `parentId` (the record an attachment
// belongs to) and an `api` of { list, upload, remove, freshUrl } from
// recordAttachments.makeAttachments(). Self-contained: load, upload (drag-drop),
// view (fresh URL on click), and delete.
//
// `invoiceDocNumber` (optional): when the record carries a QuickBooks invoice
// ref, shows a "Get invoice PDF" button that pulls the PDF from QBO and attaches
// it through the same upload path (replacing a prior copy of the same invoice).
// `actions` (optional): module-specific buttons rendered alongside the built-in
// ones (e.g. Inspections' report generation). `reloadSignal`: bump it to make
// the panel re-list (so an external action like "generate report" shows up).
export default function AttachmentsPanel({ parentId, api, title = 'Attachments', invoiceDocNumber = null, actions = null, reloadSignal = 0, readOnly = false }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null); // 'upload' | recordId being deleted
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on record change
    setItems([]); setError(null);
    if (!parentId) return;
    let alive = true;
    setLoading(true);
    api.list(parentId)
      .then(a => { if (alive) setItems(a); })
      .catch(() => { if (alive) setError('Could not load attachments'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [parentId, reloadSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleFiles(files) {
    if (!parentId || !files?.length) return;
    setBusy('upload'); setError(null);
    try {
      for (const file of files) {
        const card = await api.upload(parentId, file);
        setItems(a => [card, ...a]);
      }
    } catch (e) { setError(e.message || 'Upload failed'); }
    finally { setBusy(null); }
  }
  async function handleDelete(recordId) {
    setBusy(recordId); setError(null);
    try { await api.remove(recordId); setItems(a => a.filter(x => x.recordId !== recordId)); }
    catch (e) { setError(e.message || 'Delete failed'); }
    finally { setBusy(null); }
  }
  async function handleGetInvoice() {
    if (!invoiceDocNumber || !parentId) return;
    setBusy('invoice'); setError(null);
    try {
      const { file } = await fetchInvoicePdfFile(invoiceDocNumber);
      // Replace a prior copy of the same invoice so we keep one current PDF.
      const existing = items.find(x => x.name === file.name);
      if (existing) {
        try { await api.remove(existing.recordId); setItems(a => a.filter(x => x.recordId !== existing.recordId)); } catch { /* ignore */ }
      }
      const card = await api.upload(parentId, file);
      setItems(a => [card, ...a]);
    } catch (e) { setError(e.message || 'Could not fetch invoice'); }
    finally { setBusy(null); }
  }
  async function handleOpen(a) {
    setError(null);
    if (a.url && a.url.startsWith('blob:')) { window.open(a.url, '_blank', 'noopener'); return; }
    const w = window.open('', '_blank'); // open synchronously to dodge popup blockers
    try {
      const fresh = await api.freshUrl(a.recordId);
      if (!fresh) throw new Error('File is no longer available');
      const abs = fresh.startsWith('http') ? fresh : window.location.origin + fresh;
      if (w) w.location.href = abs; else window.open(abs, '_blank', 'noopener');
    } catch (e) {
      if (w) w.close();
      setError(e.message || 'Could not open file');
    }
  }

  return (
    <div className="att-panel">
      <div className="att-head">
        <span className="att-head-icon">❏</span>
        <h3>{title}</h3>
      </div>

      {!readOnly && (
        <div className="att-actions">
          {actions}
          <button className="att-btn" disabled={busy === 'upload' || !parentId} onClick={() => fileInputRef.current?.click()}>
            {busy === 'upload' ? 'Uploading…' : '⇪ Upload file'}
          </button>
          {invoiceDocNumber && (
            <button className="att-btn invoice" disabled={busy === 'invoice' || !parentId} onClick={handleGetInvoice}
              title={`QuickBooks invoice #${invoiceDocNumber}`}>
              {busy === 'invoice' ? 'Fetching…' : (items.some(x => x.name === invoiceFileName(invoiceDocNumber)) ? '↻ Refresh invoice PDF' : '⬇ Get invoice PDF')}
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={e => { handleFiles([...e.target.files]); e.target.value = ''; }}
          />
        </div>
      )}

      {error && <p className="att-error">{error}</p>}

      <div
        className={`att-drop${dragOver ? ' over' : ''}`}
        onDragOver={e => { if (readOnly) return; e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { if (readOnly) return; e.preventDefault(); setDragOver(false); handleFiles([...e.dataTransfer.files]); }}
      >
        {loading ? (
          <p className="att-empty">Loading attachments…</p>
        ) : items.length === 0 ? (
          <p className="att-empty">{readOnly ? 'No attachments.' : 'No attachments yet — drop files here, or use the button above.'}</p>
        ) : (
          <ul className="att-grid">
            {items.map(a => (
              <li key={a.recordId} className="att-card">
                <a className="att-thumb" href={a.url || undefined} onClick={e => { e.preventDefault(); if (a.hasFile) handleOpen(a); }} title={a.hasFile ? 'Open' : 'No file'}>
                  {a.isImage && a.url
                    ? <img src={a.url} alt={a.name} />
                    : <span className="att-ext">{(a.name.split('.').pop() || '?').toUpperCase()}</span>}
                </a>
                <div className="att-meta">
                  <a className="att-name" href={a.url || undefined} onClick={e => { e.preventDefault(); if (a.hasFile) handleOpen(a); }} title={a.name}>{a.name}</a>
                  <span className="att-sub">{a.created ? a.created.split(' ')[0] : 'Just now'}{a.by ? ` · ${a.by}` : ''}</span>
                </div>
                {!readOnly && (
                  <button className="att-del" title="Delete attachment" disabled={busy === a.recordId} onClick={() => handleDelete(a.recordId)}>
                    {busy === a.recordId ? '…' : '✕'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
