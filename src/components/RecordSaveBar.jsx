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
//
// blockedReason: optional. Saving CANNOT succeed right now and we know why, so
// say so instead of offering a button that will fail. Offline inspections are
// the case this exists for: with no signal there is nothing to save to, and
// letting an inspector press Save and watch it error teaches them their work is
// in danger when it is not — it is held on the device either way. Discard stays
// live, because abandoning changes needs no network.
export default function RecordSaveBar({ count = 0, saving = false, status = null, errorMessage = null, blockedReason = null, onSave, onDiscard }) {
  if (count > 0) {
    return (
      <div className="rsb-bar">
        <span className="rsb-count">{count} unsaved change{count > 1 ? 's' : ''}</span>
        {blockedReason && <span className="rsb-blocked">{blockedReason}</span>}
        {status === 'error' && !blockedReason && <span className="rsb-err">✗ {errorMessage || 'Save failed'}</span>}
        <span className="rsb-spacer" />
        <button className="h5-btn h5-btn--secondary h5-btn--sm" onClick={onDiscard} disabled={saving}>Discard</button>
        <button className="h5-btn h5-btn--primary h5-btn--sm" onClick={onSave} disabled={saving || !!blockedReason}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    )
  }
  if (status === 'saved') return <div className="rsb-toast">✓ Saved</div>
  return null
}
