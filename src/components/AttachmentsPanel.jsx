import { useState, useEffect, useRef } from 'react';
import { fetchInvoicePdfFile, invoiceFileName } from '../api/invoices';
import './AttachmentsPanel.css';

// Reusable file-attachments panel. Pass a `parentId` (the record an attachment
// belongs to) and an `api` of { list, upload, remove, freshUrl } from
// vibeFiles.makeVibeAttachments(). Self-contained: load, upload (drag-drop),
// view (fresh URL on click), and delete.
//
// `invoiceDocNumber` (optional): when the record carries a QuickBooks invoice
// ref, shows a "Get invoice PDF" button that pulls the PDF from QBO and attaches
// it through the same upload path (replacing a prior copy of the same invoice).
// `actions` (optional): module-specific buttons rendered alongside the built-in
// ones (e.g. Inspections' report generation). `reloadSignal`: bump it to make
// the panel re-list (so an external action like "generate report" shows up).
// `parentLabel` is what the record is CALLED. It never appears in this panel —
// it names the record's folder in Drive, so an attachment lands in
// "CCS/4-H Camp Bristol Hills (1234)/" rather than a folder called "1234".
// Optional everywhere; without it the folder is the bare id.
// `reportFlag` (optional): show an "In report" tick on image attachments.
// Inspections only — a photo of a frayed cable belongs in the inspection report,
// where a photo attached to a CCS project or a training has nowhere to go. It is
// a prop rather than a default because this panel serves five modules, and a
// tick that does nothing on four of them is worse than no tick at all.
// FileMaker writes '01/28/2026 09:52:54' and Vibe writes an ISO string. Only
// the date is worth showing, and splitting on a space alone left every
// Vibe-born file displaying its full timestamp down to the milliseconds —
// which photographs, all of them Vibe-born, would have made the common case.
const justDate = v => {
  const t = String(v ?? '').trim();
  if (!t) return 'Just now';
  return t.includes(' ') ? t.split(' ')[0] : t.split('T')[0];
};

export default function AttachmentsPanel({ parentId, parentLabel = '', api, title = 'Attachments', invoiceDocNumber = null, actions = null, reloadSignal = 0, readOnly = false, reportFlag = false }) {
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
        const card = await api.upload(parentId, file, undefined, parentLabel);
        setItems(a => [card, ...a]);
      }
    } catch (e) { setError(e.message || 'Upload failed'); }
    finally { setBusy(null); }
  }
  async function toggleReport(a) {
    if (!api.setFlags) return;
    setBusy(`flag:${a.recordId}`); setError(null);
    try {
      const updated = await api.setFlags(a.recordId, { inReport: !a.inReport });
      setItems(list => list.map(x => (x.recordId === a.recordId ? updated : x)));
    } catch (e) { setError(e.message || 'Could not change whether this is in the report'); }
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
      const card = await api.upload(parentId, file, undefined, parentLabel);
      setItems(a => [card, ...a]);
    } catch (e) { setError(e.message || 'Could not fetch invoice'); }
    finally { setBusy(null); }
  }
  // Mint a fresh streaming URL and fetch it ourselves (rather than blindly
  // navigating and hoping) so an expired FMP session shows up as a catchable
  // error instead of a dead tab with FileMaker's raw "unauthorized" page.
  // Reusing the fetched bytes as a blob: URL also avoids downloading twice.
  async function openFreshUrl(recordId, w) {
    const fresh = await api.freshUrl(recordId);
    if (!fresh) throw new Error('File is no longer available');
    const abs = fresh.startsWith('http') ? fresh : window.location.origin + fresh;
    const res = await fetch(abs, { credentials: 'include' });
    if (!res.ok) {
      const err = new Error(res.status === 401 ? 'Session expired' : `Could not open file (HTTP ${res.status})`);
      err.status = res.status;
      throw err;
    }
    const blobUrl = URL.createObjectURL(await res.blob());
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60 * 1000);
    if (w) w.location.href = blobUrl; else window.open(blobUrl, '_blank', 'noopener');
  }

  async function handleOpen(a) {
    setError(null);
    if (a.url && a.url.startsWith('blob:')) { window.open(a.url, '_blank', 'noopener'); return; }
    const w = window.open('', '_blank'); // open synchronously to dodge popup blockers
    try {
      await openFreshUrl(a.recordId, w);
    } catch (e) {
      // A 401 here means the FMP session that minted this URL was evicted
      // between mint and click — freshUrl() forces a brand-new session on
      // each call, so retry once before giving up.
      if (e.status === 401) {
        try { await openFreshUrl(a.recordId, w); return; } catch { /* fall through to error */ }
      }
      if (w) w.close();
      setError(e.status === 401
        ? 'Could not open this file — your FileMaker session expired. Please try again.'
        : (e.message || 'Could not open file'));
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
                  <span className="att-sub">{justDate(a.created)}{a.by ? ` · ${a.by}` : ''}</span>
                  {reportFlag && a.isImage && !readOnly && (
                    <label
                      className="att-report"
                      title={a.pending
                        ? 'Include this photo in the report — it will be marked as soon as it syncs'
                        : 'Include this photo in the generated report'}
                    >
                      <input
                        type="checkbox"
                        checked={!!a.inReport}
                        disabled={busy === `flag:${a.recordId}`}
                        onChange={() => toggleReport(a)}
                      />
                      In report
                    </label>
                  )}
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
