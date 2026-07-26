import { useState, useEffect, useCallback } from 'react';
import { fetchKanbanOrders, setColumnOrder as postColumnOrder } from '../api/kanbanOrder';

// Shared, per-column manual card order. Fetched once on board load; each
// reorder overwrites just the affected column and updates local state
// optimistically (reverting to server truth if the write fails).
export function useKanbanOrder() {
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
