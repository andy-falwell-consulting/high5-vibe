import './RecordSaveBar.css'

// Standard record-edit save bar (the CCS pattern): a floating bar that slides up
// at the bottom of the detail pane whenever there are unsaved field edits. One
// Save commits them all in a single write. Render it at the end of the module's
// scrolling content column.
//
//   <RecordSaveBar count={dirtyCount} saving={saving} status={saveStatus}
//                  errorMessage={saveErrorMsg} onSave={handleSave} onDiscard={handleDiscard} />
//
// status: null | 'saving' | 'saved' | 'error'
// errorMessage: optional specific reason (e.g. "FileMaker account not connected")
// shown in place of the generic "Save failed" text — most failures are opaque
// network/server errors, but some (like a missing write session) have a real,
// actionable reason the user should see instead of guessing.
export default function RecordSaveBar({ count = 0, saving = false, status = null, errorMessage = null, onSave, onDiscard }) {
  if (count > 0) {
    return (
      <div className="rsb-bar">
        <span className="rsb-count">{count} unsaved change{count > 1 ? 's' : ''}</span>
        {status === 'error' && <span className="rsb-err">✗ {errorMessage || 'Save failed'}</span>}
        <span className="rsb-spacer" />
        <button className="rsb-discard" onClick={onDiscard} disabled={saving}>Discard</button>
        <button className="rsb-save" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    )
  }
  if (status === 'saved') return <div className="rsb-toast">✓ Saved</div>
  return null
}
