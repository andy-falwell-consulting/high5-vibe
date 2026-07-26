import { useState, useEffect } from 'react';
import { getValueLists } from '../api/filemaker';

// Drives dropdowns from FileMaker's own value lists so they can't drift from
// what FMP users see. `fallbacks` seeds the first render (and stands in if FMP
// is unreachable), keyed by value-list name:
//
//   const vl = useValueLists(LAYOUT, { 'Type of Project': PROJECT_TYPES });
//   <InlineSelect options={vl['Type of Project']} … />
export function useValueLists(layout, fallbacks = {}) {
  const [lists, setLists] = useState(fallbacks);

  useEffect(() => {
    let alive = true;
    getValueLists(layout)
      .then(fetched => { if (alive) setLists(prev => ({ ...prev, ...fetched })); })
      .catch(() => { /* keep fallbacks — a dropdown with stale options beats an empty one */ });
    return () => { alive = false; };
  }, [layout]);

  return lists;
}
