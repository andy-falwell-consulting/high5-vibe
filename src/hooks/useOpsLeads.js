import { useState, useEffect, useCallback } from 'react';
import { fetchOpsLeads, setOpsLead, OPS_LEAD_FALLBACK } from '../api/opsLead';

// Operations Lead assignments for one environment, fetched once per mount.
//
// The whole map arrives in a single request (see api/ops-lead.js), so the board
// can label every card without a call per card. Writes are optimistic and roll
// back on failure — the value is a label, so showing it briefly and taking it
// away beats blocking the dropdown on a round trip.
export function useOpsLeads(db, kind) {
  const [leads, setLeads] = useState({});
  const [roster, setRoster] = useState(OPS_LEAD_FALLBACK);

  useEffect(() => {
    let alive = true;
    fetchOpsLeads(db, kind)
      .then(j => {
        if (!alive) return;
        setLeads(j.leads || {});
        if (Array.isArray(j.roster) && j.roster.length) setRoster(j.roster);
      })
      .catch(() => { /* keep the fallback roster; an empty map just shows no leads */ });
    return () => { alive = false; };
  }, [db, kind]);

  const assign = useCallback(async (recordId, name) => {
    const id = String(recordId);
    let previous;
    setLeads(p => { previous = p[id]; const n = { ...p }; if (name) n[id] = name; else delete n[id]; return n; });
    try {
      await setOpsLead(db, id, name, kind);
    } catch {
      setLeads(p => { const n = { ...p }; if (previous) n[id] = previous; else delete n[id]; return n; });
    }
  }, [db, kind]);

  // For the create path: reflect a server-side auto-assignment locally without
  // re-fetching the whole map.
  const note = useCallback((recordId, name) => {
    if (!name) return;
    setLeads(p => ({ ...p, [String(recordId)]: name }));
  }, []);

  const leadFor = useCallback(recordId => leads[String(recordId)] || '', [leads]);

  return { leads, roster, assign, note, leadFor };
}
