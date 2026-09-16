'use client';

import * as React from 'react';

/**
 * One tooltip for the whole board.
 *
 * EVERY MARK ON THIS PAGE CARRIES ITS OWN ROW OF FACTS — a dot is a sale with a
 * buyer and a block, a tile is a rock with an owner and a peak — and a hundred
 * tiles each owning a mounted tooltip is a hundred subscriptions to mousemove.
 * So there is exactly one, positioned in viewport coordinates, and the marks
 * only hand it a title and some rows.
 *
 * It follows the cursor and flips before the edge rather than being clipped by
 * it, because a tooltip that opens off-screen is the one case where the reader
 * has to move the mouse to find out what they were already pointing at.
 */

type Row = [string, string];
type Show = (e: React.MouseEvent, title: string, rows: Row[]) => void;

const TipContext = React.createContext<{ show: Show; move: Show; hide: () => void } | null>(null);

export function TooltipLayer({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<{
    open: boolean;
    x: number;
    y: number;
    title: string;
    rows: Row[];
  }>({ open: false, x: 0, y: 0, title: '', rows: [] });

  const ref = React.useRef<HTMLDivElement>(null);

  const place = React.useCallback((clientX: number, clientY: number) => {
    const pad = 14;
    const node = ref.current;
    const w = node?.offsetWidth ?? 220;
    const h = node?.offsetHeight ?? 90;
    let x = clientX + pad;
    let y = clientY + pad;
    if (x + w > window.innerWidth - 8) x = clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = clientY - h - pad;
    return { x, y };
  }, []);

  const show = React.useCallback<Show>(
    (e, title, rows) => {
      const { x, y } = place(e.clientX, e.clientY);
      setState({ open: true, x, y, title, rows });
    },
    [place]
  );

  const move = React.useCallback<Show>(
    (e) => {
      const { x, y } = place(e.clientX, e.clientY);
      setState((s) => (s.open ? { ...s, x, y } : s));
    },
    [place]
  );

  const hide = React.useCallback(() => setState((s) => ({ ...s, open: false })), []);

  const value = React.useMemo(() => ({ show, move, hide }), [show, move, hide]);

  return (
    <TipContext.Provider value={value}>
      {children}
      <div
        ref={ref}
        role="tooltip"
        aria-hidden={!state.open}
        className="pointer-events-none fixed z-[200] max-w-[18rem] rounded-[var(--radius-sm)] border border-rule bg-slab px-2.5 py-2 text-[12px] shadow-[0_8px_28px_rgba(0,0,0,0.55)] transition-opacity duration-100"
        style={{ left: state.x, top: state.y, opacity: state.open ? 1 : 0 }}
      >
        <div className="mb-1 font-semibold text-bone">{state.title}</div>
        {state.rows.map(([k, v], i) => (
          <div key={i} className="flex justify-between gap-3.5 text-dim">
            <span>{k}</span>
            <b className="tnum font-semibold text-ash">{v}</b>
          </div>
        ))}
      </div>
    </TipContext.Provider>
  );
}

/**
 * Returns a spread-able set of handlers for one mark. Marks call
 * `{...tip('Rock #12', rows)}` rather than wiring three listeners each.
 */
export function useTip() {
  const ctx = React.useContext(TipContext);
  return React.useCallback(
    (title: string, rows: Row[]) => {
      if (!ctx) return {};
      return {
        onMouseEnter: (e: React.MouseEvent) => ctx.show(e, title, rows),
        onMouseMove: (e: React.MouseEvent) => ctx.move(e, title, rows),
        onMouseLeave: () => ctx.hide(),
      };
    },
    [ctx]
  );
}
