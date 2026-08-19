import { useState, useEffect } from 'react';
import { getValueLists } from '../api/filemaker';
import { getVibeValueLists } from '../api/valueLists';

// Drives dropdowns from a vocabulary that survives FileMaker's retirement.
//
//   const vl = useValueLists(LAYOUT, { 'Type of Project': PROJECT_TYPES });
//   <InlineSelect options={vl['Type of Project']} … />
//
// Three sources, in order, and the ORDER is the whole point (PHASE C3):
//
//   1. VIBE — `/api/value-lists`. Once a layout is seeded this is the answer,
//      and it keeps working after cutover. The endpoint itself reads through to
//      FileMaker for a layout nobody has seeded yet, so adopting this changed
//      nothing on the day it shipped.
//   2. FILEMAKER, direct from the browser — the old path, kept only as a net
//      for the window where Vibe is unreachable but FileMaker is not. Delete
//      this branch at cutover; it is the last direct FMP read in the app.
//   3. FALLBACKS — the hard-coded array in the component. Never stale-proof:
//      measured 2026-08-19, CCS's `Lead Builder` fallback was already missing a
//      real builder the live list had. It exists so a dropdown is never EMPTY,
//      not so it can be relied on.
//
// `fallbacks` seeds the first render, so a select is populated immediately and
// then upgraded in place.
export function useValueLists(layout, fallbacks = {}) {
  const [lists, setLists] = useState(fallbacks);

  useEffect(() => {
    let alive = true;
    (async () => {
      const vibe = await getVibeValueLists(layout).catch(() => null);
      if (!alive) return;
      if (vibe && Object.keys(vibe.lists).length) {
        setLists(prev => ({ ...prev, ...vibe.lists }));
        return;
      }
      // Vibe had nothing to say — unreachable, or seeded-then-emptied. Fall
      // back to the direct FileMaker read while that still works.
      try {
        const fetched = await getValueLists(layout);
        if (alive && fetched) setLists(prev => ({ ...prev, ...fetched }));
      } catch { /* keep fallbacks — stale options beat an empty dropdown */ }
    })();
    return () => { alive = false; };
  }, [layout]);

  return lists;
}
