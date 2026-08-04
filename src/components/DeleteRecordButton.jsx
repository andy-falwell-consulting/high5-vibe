import { useState, useEffect, useRef } from 'react';
import { deleteRecord, removeCachedRecord, invalidateRecord } from '../api/filemaker';
import { getCurrentEnv } from '../config/fmpEnvironments';
import './DeleteRecordButton.css';

// Shared "Delete record" control for every records module.
//
// Deletion over the FileMaker Data API is IMMEDIATE AND PERMANENT — there is no
// trash and no undo, in the app or in FileMaker's API. Hence the typed
// confirmation rather than a plain OK.
//
// This deletes exactly ONE record — there is deliberately no cascade logic here.
// FileMaker may still remove children on its own side: "Delete related records"
// on the relationship graph is not visible over the Data API, so the app can
// neither see nor override it. The dialog says so rather than implying Vibe
// does the cascading.
//
// After a successful delete it also tells /api/replica-delete, because the
// Redis replica is populated by an incremental sync that only ever upserts
// modified records and never sees deletions (see api/_replica.js). Without
// that call the row keeps coming back from the replica until the hourly
// reconcile catches up.
export default function DeleteRecordButton({
  layout,           // FileMaker layout, e.g. 'Contacts_New'
  cacheVersion,     // the module's cacheVersion, so the list drops the row
  recordId,
  name,             // what to show in the dialog: "Delete <name>?"
  replicaKey,       // optional app key for /api/replica-delete when it differs
  onDeleted,        // called after a successful delete — clear the selection
  label = 'Delete',
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = e => { if (e.key === 'Escape' && !busy) close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy]);

  function close() { setOpen(false); setTyped(''); setError(null); }

  async function handleDelete() {
    if (typed.trim().toUpperCase() !== 'DELETE' || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await deleteRecord(layout, recordId);
      const msg = res?.messages?.[0];
      if (msg?.code !== '0') {
        // 9 / 200-ish come back when the signed-in FileMaker account has no
        // delete privilege — say so plainly rather than "something went wrong".
        const denied = msg?.code === '9' || /privilege|permission/i.test(msg?.message || '');
        setError(denied
          ? 'Your FileMaker account does not have permission to delete this record.'
          : `FileMaker refused the delete: ${msg?.message || 'unknown error'} (${msg?.code ?? '?'})`);
        return;
      }
      removeCachedRecord(layout, cacheVersion, recordId);
      invalidateRecord(layout, recordId);
      // Best-effort: a failure here only means the row lingers in the replica
      // until the hourly reconcile, so it must not look like the delete failed.
      fetch('/api/replica-delete', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ db: getCurrentEnv().db, ...(replicaKey ? { key: replicaKey } : { layout }), recordId: String(recordId) }),
      }).catch(() => {});
      close();
      onDeleted?.();
    } catch (e) {
      setError(e?.message || 'Delete failed.');
    } finally {
      setBusy(false);
    }
  }

  const armed = typed.trim().toUpperCase() === 'DELETE';

  return (
    <>
      <button className="drb-btn" onClick={() => setOpen(true)} title="Delete this record">🗑 {label}</button>

      {open && (
        <div className="drb-backdrop" onClick={e => e.target === e.currentTarget && !busy && close()}>
          <div className="drb-panel" role="dialog" aria-modal="true">
            <div className="drb-title">Delete {name ? <strong>{name}</strong> : 'this record'}?</div>
            <p className="drb-warn">
              This permanently deletes this one record in FileMaker. It cannot be undone.
              Related records are not deleted by Vibe, but FileMaker may remove them
              if the relationship is set to cascade.
            </p>
            <label className="drb-label" htmlFor="drb-confirm">Type <strong>DELETE</strong> to confirm</label>
            <input
              id="drb-confirm"
              ref={inputRef}
              className="drb-input"
              value={typed}
              disabled={busy}
              onChange={e => setTyped(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && armed) handleDelete(); }}
              placeholder="DELETE"
              autoComplete="off"
            />
            {error && <div className="drb-error">{error}</div>}
            <div className="drb-actions">
              <button className="drb-cancel" onClick={close} disabled={busy}>Cancel</button>
              <button className="drb-confirm" onClick={handleDelete} disabled={!armed || busy}>
                {busy ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
