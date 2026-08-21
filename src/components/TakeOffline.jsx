import { useState, useEffect, useCallback, useMemo } from 'react';
import { pinInspection, unpinInspection, listPinnedInspections, inspectionLabel } from '../api/offlineInspections';
import { offlineStorageAvailable } from '../api/offlineStore';
import { isControlled, applyUpdateNow, onUpdateReady, requestPersistentStorage, storageEstimate } from '../registerSW';
import './TakeOffline.css';

// Choosing what to carry into a field with no signal.
//
// The pre-flight block above the list is the part that earns its place. Three
// things can be wrong at the moment a crew is packing up, all of them invisible
// and all of them only discovered two hours away:
//
//   - THE APP ISN'T IN CHARGE YET. A service worker only controls pages loaded
//     after it activated, so on a device's very first visit the shell is cached
//     but not being served from the cache. One reload fixes it. Nothing about
//     the screen would otherwise say so.
//   - THERE IS A NEWER BUILD. Ordinarily an update waits for the next natural
//     load, which is the right default — but not when the next natural load is
//     on a mountain.
//   - THE BROWSER WON'T HOLD ANYTHING. Private browsing, or storage disabled,
//     and every download here silently achieves nothing.
//
// Sequential downloads rather than parallel, deliberately: a phone on one bar
// in a car park does better with one request at a time, and the per-row
// progress is worth more than the seconds saved.

const bytes = n => {
  if (!n) return '0 KB';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

export default function TakeOffline({ records = [], onClose, onChanged }) {
  const [pinned, setPinned] = useState([]);
  const [picked, setPicked] = useState(() => new Set());
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({});     // recordId -> phrase | 'done' | Error message
  const [updateReady, setUpdateReady] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const [estimate, setEstimate] = useState({ usage: 0, quota: 0 });
  const [online, setOnline] = useState(() => navigator.onLine);

  const refresh = useCallback(async () => {
    try { setPinned(await listPinnedInspections()); } catch { setPinned([]); }
    setEstimate(await storageEstimate());
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { offlineStorageAvailable().then(setStorageOk); }, []);
  useEffect(() => onUpdateReady(setUpdateReady), []);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const pinnedIds = useMemo(() => new Set(pinned.map(p => String(p.recordId))), [pinned]);

  // Newest first — an inspection is created for the day it is done, so the ones
  // a crew is about to carry are the ones just made.
  const candidates = useMemo(() => {
    const q = typed.trim().toLowerCase();
    const scored = records.map(r => ({
      r,
      label: inspectionLabel(r.fieldData),
      date: r.fieldData?.Date || '',
    }));
    const filtered = q
      ? scored.filter(x => x.label.toLowerCase().includes(q) || x.date.includes(q))
      : scored;
    const ms = d => {
      if (!d) return 0;
      const [m, day, y] = String(d).split(' ')[0].split('/');
      return new Date(`${y}-${m}-${day}`).getTime() || 0;
    };
    return filtered.sort((a, b) => ms(b.date) - ms(a.date)).slice(0, 60);
  }, [records, typed]);

  const toggle = id => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  async function download() {
    setBusy(true);
    await requestPersistentStorage();
    for (const id of picked) {
      const rec = records.find(r => String(r.recordId) === String(id));
      if (!rec) continue;
      try {
        await pinInspection(rec, phrase => setProgress(p => ({ ...p, [id]: phrase })));
        setProgress(p => ({ ...p, [id]: 'done' }));
      } catch (e) {
        // One site failing must not abandon the rest of the day.
        setProgress(p => ({ ...p, [id]: e?.message || 'Could not download' }));
      }
    }
    setPicked(new Set());
    await refresh();
    onChanged?.();
    setBusy(false);
  }

  async function remove(recordId) {
    await unpinInspection(recordId).catch(() => {});
    await refresh();
    onChanged?.();
  }

  const done = Object.values(progress).filter(v => v === 'done').length;
  const failed = Object.entries(progress).filter(([, v]) => v !== 'done' && !busy).length;

  return (
    <div className="h5-scrim" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="h5-modal tko-modal">
        <div className="h5-modal__head">
          <div>
            <h2 className="h5-modal__title">Take offline</h2>
            <p className="tko-sub">Download inspections so they can be opened and read with no signal.</p>
          </div>
          <button className="h5-btn h5-btn--quiet h5-btn--sm" onClick={onClose} disabled={busy}>Close</button>
        </div>

        <div className="h5-modal__body">
          {!storageOk && (
            <div className="h5-callout h5-callout--error">
              <span className="h5-callout__icon">⚠</span>
              <div className="h5-callout__body">
                <p className="h5-callout__title">This browser will not hold offline work.</p>
                Private browsing, or storage turned off. Nothing downloaded here would survive.
              </div>
            </div>
          )}

          {!online && (
            <div className="h5-callout h5-callout--warning">
              <span className="h5-callout__icon">⚑</span>
              <div className="h5-callout__body">
                <p className="h5-callout__title">No connection.</p>
                What is already downloaded is listed below and can still be opened. Nothing new can be
                fetched until there is a signal.
              </div>
            </div>
          )}

          {updateReady && (
            <div className="h5-callout h5-callout--info">
              <span className="h5-callout__icon">↻</span>
              <div className="h5-callout__body">
                <p className="h5-callout__title">There is a newer version of Vibe.</p>
                It would normally wait until the next time the app is opened. Take it now, before you
                lose signal.
                <div className="tko-callout-actions">
                  <button className="h5-btn h5-btn--secondary h5-btn--sm" onClick={applyUpdateNow} disabled={busy}>
                    Update and reload
                  </button>
                </div>
              </div>
            </div>
          )}

          {!isControlled() && (
            <div className="h5-callout h5-callout--warning">
              <span className="h5-callout__icon">↻</span>
              <div className="h5-callout__body">
                <p className="h5-callout__title">Reload once before you leave.</p>
                The app has been saved to this device but is not being served from it yet. One reload
                while there is still a signal, and it will open anywhere.
              </div>
            </div>
          )}

          <div className="tko-section">
            <div className="tko-section-head">
              <h3 className="tko-section-title">Available offline</h3>
              <span className="tko-count">{pinned.length}</span>
            </div>
            {pinned.length === 0 ? (
              <p className="tko-empty">Nothing yet. Pick the day's sites below.</p>
            ) : (
              <ul className="tko-list">
                {pinned.map(p => (
                  <li key={p.key} className="tko-row">
                    <div className="tko-row-text">
                      <span className="tko-row-name">{p.label}</span>
                      <span className="tko-row-sub">
                        {[p.date, `${(p.lines || []).length} line items`, p.attachments?.length ? `${p.attachments.length} files` : null]
                          .filter(Boolean).join(' · ')}
                      </span>
                    </div>
                    <button className="h5-btn h5-btn--quiet h5-btn--sm" onClick={() => remove(p.recordId)} disabled={busy}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="tko-section">
            <div className="tko-section-head">
              <h3 className="tko-section-title">Add inspections</h3>
              <input
                className="tko-search"
                placeholder="Search sites…"
                value={typed}
                onChange={e => setTyped(e.target.value)}
                disabled={busy}
              />
            </div>
            <ul className="tko-list tko-list--pick">
              {candidates.map(({ r, label, date }) => {
                const id = String(r.recordId);
                const already = pinnedIds.has(id);
                const state = progress[id];
                return (
                  <li key={id} className={`tko-row ${already ? 'is-pinned' : ''}`}>
                    <label className="tko-pick">
                      <input
                        type="checkbox"
                        checked={picked.has(id)}
                        onChange={() => toggle(id)}
                        disabled={busy}
                      />
                      <span className="tko-row-text">
                        <span className="tko-row-name">{label}</span>
                        <span className="tko-row-sub">{date || 'undated'}</span>
                      </span>
                    </label>
                    {state && state !== 'done' && <span className="tko-state">{state}</span>}
                    {(state === 'done' || already) && <span className="h5-badge tko-badge">offline</span>}
                  </li>
                );
              })}
              {candidates.length === 0 && <li className="tko-empty">No inspections match that.</li>}
            </ul>
          </div>
        </div>

        <div className="h5-modal__foot">
          <span className="tko-storage">
            {bytes(estimate.usage)} used{estimate.quota ? ` of ${bytes(estimate.quota)}` : ''}
            {done > 0 && !busy ? ` · ${done} downloaded` : ''}
            {failed > 0 && !busy ? ` · ${failed} failed` : ''}
          </span>
          <button
            className="h5-btn h5-btn--primary"
            onClick={download}
            disabled={busy || !picked.size || !online || !storageOk}
          >
            {busy ? 'Downloading…' : picked.size ? `Download ${picked.size}` : 'Download'}
          </button>
        </div>
      </div>
    </div>
  );
}
