import { useState, useEffect, useCallback } from 'react';
import { fetchBoardIds, setBoardMembership } from '../api/trainingsKanbanBoard';

// Shared board-membership set: which Trainings recordIds the team has put on
// the Kanban board. Optimistic toggle, reverts to server truth on failure.
// Mirrors src/hooks/useKanbanBoard.js for CCS.
export function useTrainingsKanbanBoard() {
  const [ids, setIds] = useState(() => new Set());
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    fetchBoardIds()
      .then(list => setIds(new Set(list)))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const toggle = useCallback((rawId, on) => {
    const id = String(rawId);
    setIds(prev => { const n = new Set(prev); if (on) n.add(id); else n.delete(id); return n; });
    return setBoardMembership(id, on)
      .then(list => setIds(new Set(list)))
      .catch(() => refresh()); // revert to server state on error
  }, [refresh]);

  return { ids, loaded, toggle, refresh };
}
