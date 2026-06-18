import { useEffect, useState } from 'react';
import { getAllRecords } from '../api/filemaker';

export function useAllRecords(layout, { slimForStorage, cacheVersion, findQuery, refreshKey } = {}) {
  const [state, setState] = useState({ records: [], total: 0, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ records: [], total: 0, loading: true });

    getAllRecords(layout, {
      onProgress: ({ records, total }) => {
        if (cancelled) return;
        setState({ records: [...records], total, loading: false, error: null });
      },
      slimForStorage,
      cacheVersion,
      findQuery,
    }).catch((err) => {
      if (cancelled || err.name === 'AbortError') return;
      setState((s) => ({ ...s, loading: false, error: err.message ?? String(err) }));
    });

    return () => { cancelled = true; };
  }, [layout, refreshKey]);

  return state;
}
