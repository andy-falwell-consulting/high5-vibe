import { useCallback, useEffect, useRef, useState } from 'react';

// The record navigation panel's width, drag handle and memory.
//
// ONE COPY, BECAUSE THERE WERE TWELVE. Every module that lists records had its
// own `sidebarWidth` state and its own near-identical `onMouseDown`, and the
// copies had drifted in the ways copies do:
//
//   - ELEVEN OF TWELVE FORGOT THE WIDTH ON RELOAD. Only Contacts persisted it
//     (`contacts-v2-nav-width`). Everywhere else, widening the panel lasted
//     until the next refresh — which is why it never felt worth doing.
//   - TRANSACTIONS HAD NO HANDLE AT ALL, pinned at 340px in CSS. Its rows carry
//     a type chip, a document number, an amount, a customer and a date, and
//     none of that could be given more room. That is the complaint this fixes.
//   - The drag was MOUSE-ONLY. On an iPad — the device the build team uses in
//     the field — there was no way to resize anything.
//
// Pointer events rather than mouse events, so a stylus and a finger work too,
// and `setPointerCapture` keeps the drag alive when the cursor outruns the
// 4px handle, which a fast drag reliably does.

const MIN = 220;
const MAX = 720;   // was 520; Transactions' rows genuinely want the room

const clamp = w => Math.max(MIN, Math.min(MAX, Math.round(w)));

/**
 * @param {string} key    Unique per module — it names the stored width.
 * @param {number} initial Width before anything is stored.
 * @returns {{ width: number, onPointerDown: function, reset: function }}
 */
export function useRecordPanel(key, initial = 300, legacyKey = null) {
  const storageKey = `panel-width:${key}`;

  const [width, setWidth] = useState(() => {
    // Read once, at first paint, so the panel never opens at the default and
    // then jumps to the stored width.
    const read = k => {
      const v = Number(localStorage.getItem(k));
      return Number.isFinite(v) && v >= MIN && v <= MAX ? v : null;
    };
    // `legacyKey` carries a width someone already chose under an older name.
    // Contacts was the one module that persisted this, and losing that setting
    // to a refactor would be a small, avoidable insult.
    return read(storageKey) ?? (legacyKey && read(legacyKey)) ?? clamp(initial);
  });

  // Written on settle rather than on every pointermove: a drag fires dozens of
  // events and localStorage is synchronous.
  const settled = useRef(width);
  useEffect(() => {
    const t = setTimeout(() => {
      if (settled.current === width) return;
      settled.current = width;
      try { localStorage.setItem(storageKey, String(width)); } catch { /* private mode */ }
    }, 150);
    return () => clearTimeout(t);
  }, [width, storageKey]);

  const onPointerDown = useCallback(e => {
    // Ignore anything but the primary button, so a right-click on the handle
    // does not start a drag that only ends on the next click.
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startW = width;
    try { handle.setPointerCapture(e.pointerId); } catch { /* not supported */ }

    // Without these, dragging selects whatever text the pointer sweeps over and
    // the cursor flickers between col-resize and text. Contacts was the only
    // module that got this right; now everything does.
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = ev => setWidth(clamp(startW + ev.clientX - startX));
    const onUp = () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }, [width]);

  const reset = useCallback(() => setWidth(clamp(initial)), [initial]);

  return { width, onPointerDown, reset };
}
