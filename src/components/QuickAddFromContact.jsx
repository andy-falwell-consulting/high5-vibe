import { useState, useRef, useEffect } from 'react';
import { getRecord, addCachedRecord, findInLayout } from '../api/filemaker';
import { createVibeRecord } from '../api/vibeRecords';
import { RCD_LAYOUT, RCD_CACHE_VERSION } from '../config/ccsCache';
import { copyProfileFields } from '../config/inspectionCopy';
import { copyLines } from '../api/inspectionLinesVibe';
import { markCarriedLines } from '../api/naFlags';
import { autoAssignOpsLead } from '../api/opsLead';
import { getCurrentEnv } from '../config/fmpEnvironments';
import { TRAININGS_LAYOUT, TRAININGS_CACHE_VERSION } from '../config/trainingsCache';
import { PIPELINE_STAGES } from '../config/trainingStatus';
import { useValueLists } from '../hooks/useValueLists';
import { displayFieldsForContact } from '../api/contactDisplay';
import './QuickAddFromContact.css';

// Shared "+ New" button for a contact: create a CCS project, Inspection,
// Estimate or Training pre-linked to that contact (_kft__Contact_ID), then jump
// straight to the new record in its module. Drop it anywhere a contact is in
// hand:
//   <QuickAddFromContact contact={selected} onNavigateTo={onNavigateTo} />
const PROJECT_TYPES = ['Inspection', 'New Construction', 'Renovation', 'Repair', 'Training', 'Other'];

// Mirrored from trainings_New's own FileMaker value lists, and used ONLY as the
// first-paint fallback — useValueLists reads the live ones, exactly as
// Trainings.jsx and CCSv2.jsx already do. A stale copy here shows briefly and is
// then replaced; an empty dropdown would not be.
const PROGRAM_TYPES = ['Adventure Basics: Level 1 Training', 'Adventure Facilitaton Training', 'Beyond Basics: Level 2 Training', 'CATSEL - custom', 'Certification Exam - custom', 'CIT Training', 'Climbing Wall/Tower & Belay Skills Training', 'Corporate Program', 'Curriculum Writing', 'Consultation', 'Dialogue', 'EOL/SEL', 'EOL Sports', 'Game Bag Training', 'Gathering Again (Games & Lows)', 'Gathering Again 2 (High Elements)', 'High Elements and Belay Skills Training', 'Leadership Development', 'Low Elements Course Training', 'Low Traverse Wall Training', 'Managing an Adventure Program', 'Mastermind/Adventure Circuit', 'New Student Orientation ', 'Portable Adventure', 'Program Review', 'Team-building', 'Team Development', 'Technical Skills Refresher', 'Technical Skills Training', 'Technical Skills Verification', 'Therapeutic', 'Virtual Team-building', 'Virtual Team Development', 'Virtual Training', 'Keynote', 'Playnote', 'Other', 'NCD'];
const AUDIENCES = ['Corporate', 'Adult', 'College', 'Youth Public', 'Youth Private', 'EOL'];
const KANBAN_FIRST_STAGE = 'New Project Inquiry';

const todayFm = () => { const d = new Date(); return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`; };
const isoToFm = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };
const fmDateMs = v => { if (!v) return 0; const [m, d, y] = String(v).split(' ')[0].split('/'); return y ? (new Date(`${y}-${m}-${d}T00:00:00`).getTime() || 0) : 0; };

const TYPES = {
  ccs: {
    label: 'CCS project', icon: '◈', layout: RCD_LAYOUT, cacheVersion: RCD_CACHE_VERSION, module: 'projects',
    build: v => ({ 'Type of Project(1)': v.projectType || '', ...(v.date ? { 'rcd start date': isoToFm(v.date) } : {}), ...(v.addToBoard ? { kanban_status: KANBAN_FIRST_STAGE } : {}) }),
  },
  inspection: {
    label: 'Inspection', icon: '⚑', layout: 'Inspections_New', cacheVersion: 1, module: 'inspections',
    build: v => {
      let copied = {};
      if (v.mode === 'copy' && v.sourceFull) {
        copied = copyProfileFields(v.sourceFull);
        // Attach the new inspection to the SAME contact/site as its predecessor —
        // inspections often point at a site contact, not the org contact the
        // user is viewing (e.g. 4-H Camp Bristol Hills org 72380 vs site 82201).
        if (v.sourceFull._kft__Contact_ID) copied._kft__Contact_ID = String(v.sourceFull._kft__Contact_ID);
      }
      return { ...copied, Date: v.date ? isoToFm(v.date) : todayFm(), ...(v.inspector ? { 'Inspectors Name': v.inspector } : {}) };
    },
  },
  estimate: {
    label: 'Estimate', icon: '◧', layout: 'Estimates_New', cacheVersion: 1, module: 'estimates',
    build: v => ({ Date: v.date ? isoToFm(v.date) : todayFm(), ...(v.title ? { Title: v.title } : {}) }),
  },
  // Trainings had no create path ANYWHERE in the app until now — the last
  // record type in that position besides OE Lookups, and a prerequisite for
  // Phase D, which freezes FileMaker and takes the FMP Pro route away.
  //
  // Nothing new was needed to make this work: trainings_New was already in
  // VIBE_OWNED, VIBE_PK and the C1 display-field map. It is only the form that
  // was missing.
  training: {
    label: 'Training', icon: '◆', layout: TRAININGS_LAYOUT, cacheVersion: TRAININGS_CACHE_VERSION, module: 'trainings',
    build: v => ({
      ...(v.programType ? { 'Type of Program': v.programType } : {}),
      // Every training starts at the top of the pipeline. Leaving Status blank
      // would drop it out of the Kanban board and every status chip at once.
      Status: v.status || PIPELINE_STAGES[0],
      ...(v.date ? { 'Start Date': isoToFm(v.date) } : {}),
      ...(v.leadTrainer ? { 'Lead Trainer': v.leadTrainer } : {}),
      ...(v.audience ? { Audience: v.audience } : {}),
    }),
  },
};

export default function QuickAddFromContact({ contact, onNavigateTo }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [type, setType] = useState(null);          // 'ccs' | 'inspection' | 'estimate'
  const [vals, setVals] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [prevInspections, setPrevInspections] = useState(null); // null = loading
  const menuRef = useRef(null);
  const trainingLists = useValueLists(TRAININGS_LAYOUT, {
    'Type of Program': PROGRAM_TYPES, 'Audience/Rate': AUDIENCES, Trainers: [],
  });

  useEffect(() => {
    if (!menuOpen) return;
    const close = e => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const contactId = contact?.fieldData?._kpt__Contact_ID;
  const contactName = contact?.fieldData?.zz__Display__ct || contact?.fieldData?.Name_Organization || '—';
  if (!contactId) return null;

  const openForm = t => {
    setType(t);
    setVals(t === 'ccs' ? { projectType: 'New Construction', addToBoard: true }
      : t === 'inspection' ? { mode: 'blank' }
      : t === 'training' ? { status: PIPELINE_STAGES[0] }
      : {});
    setError(null); setMenuOpen(false);
    if (t === 'inspection') {
      // The site's previous inspections = the contact's own Inspections portal
      // (exactly what the Contacts page shows). The portal relationship is wider
      // than _kft__Contact_ID == this contact (inspections often point at a
      // related site contact), so don't re-query by FK — reuse the portal rows.
      setPrevInspections(null);
      const portalRows = (contact?.portalData?.['Portal__Opportunities'] || []).map(r => ({
        recordId: String(r.recordId),
        date: r['cntct_INSPT::Date'] || '',
        inspector: r['cntct_INSPT::Inspectors Name'] || '',
      }));
      if (portalRows.length) {
        portalRows.sort((a, b) => fmDateMs(b.date) - fmDateMs(a.date));
        setPrevInspections(portalRows);
      } else {
        // Fallback (e.g. list-level record without portalData): direct FK query.
        findInLayout('Inspections_New', [{ _kft__Contact_ID: `==${contactId}` }], { sort: [{ fieldName: 'Date', sortOrder: 'descend' }], limit: 30 })
          .then(j => setPrevInspections((j?.response?.data || []).map(r => ({
            recordId: String(r.recordId), date: r.fieldData?.Date || '', inspector: r.fieldData?.['Inspectors Name'] || '',
          }))))
          .catch(() => setPrevInspections([]));
      }
    }
  };
  const set = (k, v) => setVals(p => ({ ...p, [k]: v }));

  // Selecting copy mode (or a different source) defaults the source to the most
  // recent inspection and pre-fills the inspector from it.
  const pickSource = (rec) => setVals(p => ({ ...p, source: rec, inspector: p.inspectorTyped ? p.inspector : (rec?.inspector || '') }));
  const setMode = (m) => {
    setVals(p => {
      const next = { ...p, mode: m };
      if (m === 'copy' && !p.source && prevInspections?.length) {
        next.source = prevInspections[0];
        if (!p.inspectorTyped) next.inspector = prevInspections[0]?.inspector || '';
      }
      return next;
    });
  };

  const doCreate = async () => {
    const cfg = TYPES[type];
    setBusy(true); setError(null);
    try {
      // Copying an inspection needs the source's full fieldData (the portal row
      // only carries date/inspector) — fetch it now.
      let v = vals;
      if (type === 'inspection' && vals.mode === 'copy' && vals.source?.recordId) {
        const full = await getRecord('Inspections_New', vals.source.recordId);
        const src = full?.response?.data?.[0]?.fieldData;
        if (!src) throw new Error('Could not load the inspection to copy.');
        v = { ...vals, sourceFull: src };
      }
      // The names and address block FileMaker used to calculate. No
      // organization hint here on purpose: the contact IS the starting point,
      // so there is no record organization to prefer yet — the resolver uses
      // the contact's primary or only affiliation, and reports `ambiguous`
      // rather than guessing when it cannot tell.
      const { fields: display } = await displayFieldsForContact(cfg.layout, contactId,
        { fallbackRecord: contact?.fieldData });

      // Display fields first, cfg.build LAST so it always wins. That ordering
      // is what keeps a copied inspection correct: copyProfileFields carries the
      // source inspection's own `Organization` AND `Address_Block_Billing`
      // across, and the source often points at a different site contact than
      // the one being viewed — so a copy's organization and address must come
      // from the source, not from this contact.
      const fieldData = {
        _kft__Contact_ID: String(contactId),
        ...display,
        ...cfg.build(v),
      };
      // All three layouts here are Vibe-owned (api/_vibeStore.js), so the record
      // is born in Vibe rather than FileMaker — same pattern as Inspections.jsx
      // and RMI.jsx. The minted `V-` id IS the record id AND the value of the
      // table's own primary key, so nothing has to be read back to discover the
      // key, and no per-user FileMaker session is required.
      const made = await createVibeRecord(cfg.layout, fieldData);
      const recordId = made?.recordId;
      if (!recordId) throw new Error('Create failed');
      // Stamp the Operations Lead from the creator's own session. Vibe-only
      // field (Redis, see api/ops-lead.js), so it can't ride along in
      // fieldData — it's a second call, and a best-effort one: the project
      // exists either way and the lead is editable on the record. The server
      // decides the name and leaves it blank for anyone off the roster.
      if (type === 'ccs' && recordId) {
        await autoAssignOpsLead(getCurrentEnv().db, recordId).catch(() => {});
      }
      // Copy the source's line items. Lines live in Vibe's store and are keyed
      // by _kpt__Inspection_ID, which createVibeRecord already minted and
      // returned — the read-back this used to need is gone with the FileMaker
      // create that made it necessary.
      if (type === 'inspection' && v.mode === 'copy' && v.source?.recordId) {
        const sourceInspectionId = v.sourceFull?._kpt__Inspection_ID;
        const newInspectionId = made.fieldData?._kpt__Inspection_ID;
        if (sourceInspectionId && newInspectionId) {
          const copied = await copyLines(sourceInspectionId, newInspectionId);
          // Flag them as carried over so last year's findings can't quietly ship
          // under this year's date — the badge clears as each line is edited.
          if (copied.length) {
            await markCarriedLines(recordId, copied.map(l => String(l.recordId))).catch(() => {});
          }
        }
      }
      // Put the fresh record in the cached list immediately (don't wait for
      // sync). createVibeRecord hands back the stored fieldData, so this no
      // longer costs a round trip either.
      addCachedRecord(cfg.layout, cfg.cacheVersion, { recordId, fieldData: made.fieldData, portalData: {} });
      setType(null);
      onNavigateTo?.(cfg.module, recordId);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="qa-wrap" ref={menuRef}>
        <button className="qa-btn" onClick={() => setMenuOpen(o => !o)}>+ New ▾</button>
        {menuOpen && (
          <div className="qa-menu">
            {Object.entries(TYPES).map(([id, t]) => (
              <button key={id} className="qa-menu-item" onClick={() => openForm(id)}><span className="qa-ic">{t.icon}</span>{t.label}</button>
            ))}
          </div>
        )}
      </div>

      {type && (
        <div className="qa-backdrop" onClick={e => e.target === e.currentTarget && setType(null)}>
          <div className="qa-modal">
            <div className="qa-head"><h2>New {TYPES[type].label}</h2><button className="qa-x" onClick={() => setType(null)}>✕</button></div>
            <div className="qa-body">
              <div className="qa-row"><label>Contact</label><span className="qa-fixed">{contactName}</span></div>

              {type === 'ccs' && (
                <>
                  <div className="qa-row"><label>Project type</label>
                    <select value={vals.projectType} onChange={e => set('projectType', e.target.value)}>
                      {PROJECT_TYPES.map(t => <option key={t}>{t}</option>)}
                    </select>
                  </div>
                  <div className="qa-row"><label>Start date</label><input type="date" value={vals.date || ''} onChange={e => set('date', e.target.value)} /></div>
                  <label className="qa-check"><input type="checkbox" checked={!!vals.addToBoard} onChange={e => set('addToBoard', e.target.checked)} /> Add to Kanban board ({KANBAN_FIRST_STAGE})</label>
                </>
              )}
              {type === 'inspection' && (
                <>
                  <div className="qa-row"><label>Start from</label>
                    <div className="qa-modes">
                      <label className="qa-mode"><input type="radio" name="qa-insp-mode" checked={vals.mode !== 'copy'} onChange={() => setMode('blank')} /> Blank</label>
                      <label className={`qa-mode${prevInspections?.length === 0 ? ' qa-mode-off' : ''}`}>
                        <input type="radio" name="qa-insp-mode" checked={vals.mode === 'copy'} disabled={prevInspections?.length === 0} onChange={() => setMode('copy')} />
                        {' '}Copy previous{prevInspections == null ? '…' : prevInspections.length === 0 ? ' (none for this site)' : ''}
                      </label>
                    </div>
                  </div>
                  {vals.mode === 'copy' && prevInspections?.length > 0 && (
                    <div className="qa-row"><label>Copy from</label>
                      <select value={vals.source?.recordId || ''} onChange={e => pickSource(prevInspections.find(r => r.recordId === e.target.value))}>
                        {prevInspections.map(r => (
                          <option key={r.recordId} value={r.recordId}>
                            {r.date || '—'} — {r.inspector || 'no inspector'}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="qa-row"><label>Date</label><input type="date" value={vals.date || ''} onChange={e => set('date', e.target.value)} /></div>
                  <div className="qa-row"><label>Inspector</label><input type="text" value={vals.inspector || ''} placeholder="Optional" onChange={e => setVals(p => ({ ...p, inspector: e.target.value, inspectorTyped: true }))} /></div>
                  {vals.mode === 'copy' && vals.source && <p className="qa-note">Copies the site's course profile (course types + equipment) <strong>and its line items</strong> from the selected inspection. Copied lines are flagged “carried over” until you review each one — last year's grades and notes come with them. Report status and QBO links start fresh.</p>}
                </>
              )}
              {type === 'estimate' && (
                <>
                  <div className="qa-row"><label>Title</label><input type="text" value={vals.title || ''} placeholder="Optional" onChange={e => set('title', e.target.value)} /></div>
                  <div className="qa-row"><label>Date</label><input type="date" value={vals.date || ''} onChange={e => set('date', e.target.value)} /></div>
                </>
              )}
              {type === 'training' && (
                <>
                  <div className="qa-row"><label>Program type</label>
                    <select value={vals.programType || ''} onChange={e => set('programType', e.target.value)}>
                      <option value="">— choose —</option>
                      {(trainingLists['Type of Program'] ?? PROGRAM_TYPES).map(t => <option key={t}>{t}</option>)}
                    </select>
                  </div>
                  <div className="qa-row"><label>Status</label>
                    <select value={vals.status || PIPELINE_STAGES[0]} onChange={e => set('status', e.target.value)}>
                      {PIPELINE_STAGES.map(t => <option key={t}>{t}</option>)}
                    </select>
                  </div>
                  <div className="qa-row"><label>Start date</label><input type="date" value={vals.date || ''} onChange={e => set('date', e.target.value)} /></div>
                  <div className="qa-row"><label>Lead trainer</label>
                    <select value={vals.leadTrainer || ''} onChange={e => set('leadTrainer', e.target.value)}>
                      <option value="">— unassigned —</option>
                      {(trainingLists.Trainers ?? []).filter(Boolean).map(t => <option key={t}>{t}</option>)}
                    </select>
                  </div>
                  <div className="qa-row"><label>Audience</label>
                    <select value={vals.audience || ''} onChange={e => set('audience', e.target.value)}>
                      <option value="">— not set —</option>
                      {(trainingLists['Audience/Rate'] ?? AUDIENCES).map(t => <option key={t}>{t}</option>)}
                    </select>
                  </div>
                  <p className="qa-note">
                    Creating a training here does <strong>not</strong> fire FileMaker&apos;s
                    “Notify CCS on New Training Record” script — script triggers never run for
                    an API write. Tell whoever relied on that notification, or rebuild it in Vibe.
                  </p>
                </>
              )}

              {error && <div className="qa-error">{error}</div>}
            </div>
            <div className="qa-foot">
              <button className="qa-ghost" onClick={() => setType(null)}>Cancel</button>
              <button className="qa-create" onClick={doCreate} disabled={busy}>{busy ? 'Creating…' : `Create ${TYPES[type].label}`}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
