import { useState, useEffect, useCallback } from 'react';
import { fetchNaFlags, setNaFlag } from '../api/naFlags';

// N/A flags for the currently-selected record's checklist items — shared
// across the team (Redis), refetched whenever recordId changes. Optimistic
// toggle, reverts to server truth on failure.
export function useNaFlags(recordId) {
  const [keys, setKeys] = useState(() => new Set());

  const refresh = useCallback(() => {
    (recordId ? fetchNaFlags(recordId) : Promise.resolve([]))
      .then(list => setKeys(new Set(list)))
      .catch(() => {});
  }, [recordId]);

  useEffect(() => { refresh(); }, [refresh]);

  const toggle = useCallback((itemKey, on) => {
    if (!recordId) return;
    setKeys(prev => { const n = new Set(prev); if (on) n.add(itemKey); else n.delete(itemKey); return n; });
    setNaFlag(recordId, itemKey, on).then(list => setKeys(new Set(list))).catch(() => refresh());
  }, [recordId, refresh]);

  return { keys, toggle };
}
