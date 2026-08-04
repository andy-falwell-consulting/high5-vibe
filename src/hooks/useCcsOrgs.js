import { useState, useEffect, useCallback } from 'react';

// Vibe-only organization assignments for CCS projects (see api/ccs-org.js).
// Not a FileMaker field — the whole map arrives in one request so the list and
// board can label every row without a call per record.
//
// Only the contact id is stored. The display name is resolved from the
// contacts cache by the caller, so renaming an organization in FileMaker flows
// through instead of leaving a stale label here.
export function useCcsOrgs(db) {
  const [orgs, setOrgs] = useState({});

  useEffect(() => {
    let alive = true;
    fetch(`/api/ccs-org?db=${encodeURIComponent(db)}`, { credentials: 'include' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(j => { if (alive) setOrgs(j.orgs || {}); })
      .catch(() => { /* an empty map just means no Vibe overrides — FileMaker's value still shows */ });
    return () => { alive = false; };
  }, [db]);

  // Optimistic, rolled back on failure: this is a label, so showing it briefly
  // and taking it away beats blocking the picker on a round trip.
  const assign = useCallback(async (recordId, contactId) => {
    const id = String(recordId);
    let previous;
    setOrgs(p => { previous = p[id]; const n = { ...p }; if (contactId) n[id] = String(contactId); else delete n[id]; return n; });
    try {
      const r = await fetch(`/api/ccs-org?db=${encodeURIComponent(db)}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordId: id, contactId: contactId ? String(contactId) : '' }),
      });
      if (!r.ok) throw new Error(String(r.status));
    } catch {
      setOrgs(p => { const n = { ...p }; if (previous) n[id] = previous; else delete n[id]; return n; });
    }
  }, [db]);

  const orgIdFor = useCallback(recordId => orgs[String(recordId)] || '', [orgs]);

  return { orgs, assign, orgIdFor };
}
