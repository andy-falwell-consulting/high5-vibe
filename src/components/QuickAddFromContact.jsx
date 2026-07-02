import { useState, useRef, useEffect } from 'react';
import { createRecord, getRecord, addCachedRecord } from '../api/filemaker';
import { RCD_LAYOUT, RCD_CACHE_VERSION } from '../config/ccsCache';
import './QuickAddFromContact.css';

// Shared "+ New" button for a contact: create a CCS project, Inspection, or
// Estimate pre-linked to that contact (_kft__Contact_ID), then jump straight
// to the new record in its module. Drop it anywhere a contact is in hand:
//   <QuickAddFromContact contact={selected} onNavigateTo={onNavigateTo} />
const PROJECT_TYPES = ['Inspection', 'New Construction', 'Renovation', 'Repair', 'Training', 'Other'];
const KANBAN_FIRST_STAGE = 'New Project Inquiry';

const todayFm = () => { const d = new Date(); return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`; };
const isoToFm = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };

const TYPES = {
  ccs: {
    label: 'CCS project', icon: '◈', layout: RCD_LAYOUT, cacheVersion: RCD_CACHE_VERSION, module: 'projects',
    build: v => ({ 'Type of Project(1)': v.projectType || '', ...(v.date ? { 'rcd start date': isoToFm(v.date) } : {}), ...(v.addToBoard ? { kanban_status: KANBAN_FIRST_STAGE } : {}) }),
  },
  inspection: {
    label: 'Inspection', icon: '⚑', layout: 'Inspections_New', cacheVersion: 1, module: 'inspections',
    build: v => ({ Date: v.date ? isoToFm(v.date) : todayFm(), ...(v.inspector ? { 'Inspectors Name': v.inspector } : {}) }),
  },
  estimate: {
    label: 'Estimate', icon: '◧', layout: 'Estimates_New', cacheVersion: 1, module: 'estimates',
    build: v => ({ Date: v.date ? isoToFm(v.date) : todayFm(), ...(v.title ? { Title: v.title } : {}) }),
  },
};

export default function QuickAddFromContact({ contact, onNavigateTo }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [type, setType] = useState(null);          // 'ccs' | 'inspection' | 'estimate'
  const [vals, setVals] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = e => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const contactId = contact?.fieldData?._kpt__Contact_ID;
  const contactName = contact?.fieldData?.zz__Display__ct || contact?.fieldData?.Name_Organization || '—';
  if (!contactId) return null;

  const openForm = t => { setType(t); setVals(t === 'ccs' ? { projectType: 'New Construction', addToBoard: true } : {}); setError(null); setMenuOpen(false); };
  const set = (k, v) => setVals(p => ({ ...p, [k]: v }));

  const doCreate = async () => {
    const cfg = TYPES[type];
    setBusy(true); setError(null);
    try {
      const fieldData = { _kft__Contact_ID: String(contactId), ...cfg.build(vals) };
      const res = await createRecord(cfg.layout, fieldData);
      if (res.messages?.[0]?.code !== '0') throw new Error(res.messages?.[0]?.message || 'Create failed');
      const recordId = res.response?.recordId;
      // Put the fresh record in the cached list immediately (don't wait for sync).
      try {
        const full = await getRecord(cfg.layout, recordId);
        const rec = full?.response?.data?.[0];
        if (rec) addCachedRecord(cfg.layout, cfg.cacheVersion, rec);
      } catch { /* list will pick it up on next sync */ }
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
                  <div className="qa-row"><label>Date</label><input type="date" value={vals.date || ''} onChange={e => set('date', e.target.value)} /></div>
                  <div className="qa-row"><label>Inspector</label><input type="text" value={vals.inspector || ''} placeholder="Optional" onChange={e => set('inspector', e.target.value)} /></div>
                </>
              )}
              {type === 'estimate' && (
                <>
                  <div className="qa-row"><label>Title</label><input type="text" value={vals.title || ''} placeholder="Optional" onChange={e => set('title', e.target.value)} /></div>
                  <div className="qa-row"><label>Date</label><input type="date" value={vals.date || ''} onChange={e => set('date', e.target.value)} /></div>
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
