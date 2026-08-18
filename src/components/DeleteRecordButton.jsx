import { useState, useEffect, useRef } from 'react';
import { removeCachedRecord, invalidateRecord } from '../api/filemaker';
import { deleteVibeRecord } from '../api/vibeRecords';
import './DeleteRecordButton.css';

// Shared "Delete record" control for every records module.
//
// PHASE A2 of docs/decoupling-plan.md: deletion is Vibe's. The record is
// tombstoned — it disappears from every list and read in Vibe and stays gone
// across syncs — and FileMaker's own row is deliberately left alone.
//
// Two consequences worth being straight about, both reflected in the dialog:
//
//  - Anyone still working in FileMaker Pro will keep seeing records that are
//    gone from Vibe. That is the honest cost of one-way decoupling, not a bug,
//    and it ends when FileMaker is retired.
//  - Because the FileMaker row survives, a deletion is recoverable by hand
//    (drop the tombstone) in a way the old FileMaker delete never was. The
//    typed confirmation stays anyway: recoverable is not the same as easy, and
//    nothing in the UI offers it.
//
// This deletes exactly ONE record — there is deliberately no cascade. Nothing
// hunts down children, and nothing needs to: children of a hidden parent are
// unreachable in the app, and the parent can be restored intact.
//
// The old /api/replica-delete call is gone with the FileMaker delete that
// needed it. That call existed because an incremental sync only ever upserts
// and never sees deletions, so a deleted row kept coming back from the replica.
// A tombstone survives every sync by construction, and leaving `repl:` intact
// is what keeps the record restorable.
export default function DeleteRecordButton({
  layout,           // layout name, e.g. 'Contacts_New'
  cacheVersion,     // the module's cacheVersion, so the list drops the row
  recordId,
  name,             // what to show in the dialog: "Delete <name>?"
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
      // Throws on failure, so there is no response code to inspect — and no
      // FileMaker privilege error to translate, since this no longer needs a
      // per-user FileMaker account at all.
      await deleteVibeRecord(layout, recordId);
      removeCachedRecord(layout, cacheVersion, recordId);
      invalidateRecord(layout, recordId);
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
              This removes the record from Vibe for everyone, including its related
              records here. There is no undo in the app.
              <br /><br />
              Its FileMaker copy is left alone, so anyone working directly in
              FileMaker Pro will still see it.
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
                {busy ? 'Deleting…' : 'Delete record'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
