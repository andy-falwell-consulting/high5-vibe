import { useState, useEffect, useCallback } from 'react';
import { fetchKanbanOrders, setColumnOrder as postColumnOrder } from '../api/trainingsKanbanOrder';

// Shared, per-column manual card order for the Trainings board. Fetched once
// on load; each reorder overwrites just the affected column and updates
// local state optimistically (reverting to server truth if the write
// fails). Mirrors src/hooks/useKanbanOrder.js for CCS.
export function useTrainingsKanbanOrder() {
  const [orders, setOrders] = useState({});

  const refresh = useCallback(() => {
    fetchKanbanOrders().then(setOrders).catch(() => {});
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const setColumnOrder = useCallback((columnId, order) => {
    setOrders(prev => ({ ...prev, [columnId]: order }));
    postColumnOrder(columnId, order).then(setOrders).catch(() => refresh());
  }, [refresh]);

  return { orders, setColumnOrder, refresh };
}
