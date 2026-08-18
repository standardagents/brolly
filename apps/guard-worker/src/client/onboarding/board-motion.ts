import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Motion helpers for the alert level board: FLIP transitions for reordered
 * children, delayed removal so leaving items can animate out, and a
 * pointer-driven drag session with edge auto-scroll. No dependencies.
 */

const EASE = "cubic-bezier(.2,.7,.2,1)";

/**
 * FLIP: after every render, children of `container` carrying
 * `data-flip-key` slide from their previous position to the new one.
 * Elements with `data-flip-skip` (the ghost, the dragged item) are ignored.
 */
export function useFlip(container: RefObject<HTMLElement | null>, durationMs = 220): void {
  const previous = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const nodes = [...root.querySelectorAll<HTMLElement>("[data-flip-key]")].filter(node => !node.hasAttribute("data-flip-skip"));
    const next = new Map<string, DOMRect>();
    for (const node of nodes) {
      const key = node.dataset.flipKey!;
      const rect = node.getBoundingClientRect();
      next.set(key, rect);
      const before = previous.current.get(key);
      if (!before) continue;
      const dx = before.left - rect.left;
      const dy = before.top - rect.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      node.style.transition = "none";
      node.style.transform = `translate(${dx}px, ${dy}px)`;
      // Force a layout so the inverse transform is applied before it eases away.
      void node.offsetWidth;
      node.style.transition = `transform ${durationMs}ms ${EASE}`;
      node.style.transform = "";
      const clear = () => { node.style.transition = ""; node.removeEventListener("transitionend", clear); };
      node.addEventListener("transitionend", clear);
    }
    previous.current = next;
  });
}

/**
 * Keep removed items around for `ms` so they can animate out. Returns the
 * current items followed by leaving ones, each flagged.
 */
export function useLeaving<T>(items: readonly T[], key: (item: T) => string, ms = 180): Array<{ item: T; leaving: boolean }> {
  const [leaving, setLeaving] = useState<Map<string, T>>(new Map());
  const seen = useRef(new Map<string, T>());
  useEffect(() => {
    const current = new Map(items.map(item => [key(item), item]));
    const gone = [...seen.current.entries()].filter(([id]) => !current.has(id));
    seen.current = current;
    if (!gone.length) return;
    setLeaving(state => new Map([...state, ...gone]));
    const timer = setTimeout(() => setLeaving(state => { const next = new Map(state); for (const [id] of gone) next.delete(id); return next; }), ms);
    return () => clearTimeout(timer);
  }, [items, key, ms]);
  const present = new Set(items.map(key));
  return [
    ...items.map(item => ({ item, leaving: false })),
    ...[...leaving.entries()].filter(([id]) => !present.has(id)).map(([, item]) => ({ item, leaving: true })),
  ];
}

export interface DragSession<T> {
  data: T;
  /** Pointer position, viewport coordinates. */
  x: number;
  y: number;
  /** Where inside the dragged element the pointer grabbed it. */
  grabX: number;
  grabY: number;
  width: number;
  height: number;
}

/**
 * Pointer-based drag with a small activation threshold. `onMove` receives
 * the live session; `onDrop` the last one. While active, the scroller
 * given to `startDrag` auto-scrolls when the pointer nears its edges.
 */
export function useDragSession<T>(handlers: { onMove?(session: DragSession<T>): void; onDrop(session: DragSession<T>): void }) {
  const [session, setSession] = useState<DragSession<T> | null>(null);
  const pending = useRef<{ data: T; startX: number; startY: number; element: HTMLElement; scroller: HTMLElement | null; pointerId: number } | null>(null);
  const live = useRef<DragSession<T> | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const frame = useRef<number | null>(null);

  const stopAutoScroll = () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; };
  const autoScroll = (scroller: HTMLElement | null) => {
    if (!scroller) return;
    const tick = () => {
      const current = live.current;
      if (!current) { frame.current = null; return; }
      const rect = scroller.getBoundingClientRect();
      const edge = 48;
      const speed = 12;
      if (current.x > rect.right - edge) scroller.scrollLeft += speed;
      else if (current.x < rect.left + edge) scroller.scrollLeft -= speed;
      frame.current = requestAnimationFrame(tick);
    };
    if (frame.current === null) frame.current = requestAnimationFrame(tick);
  };

  const startDrag = (event: React.PointerEvent, data: T, element: HTMLElement, scroller: HTMLElement | null) => {
    if (event.button !== 0) return;
    pending.current = { data, startX: event.clientX, startY: event.clientY, element, scroller, pointerId: event.pointerId };
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture?.(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const start = pending.current;
      if (!start) return;
      if (!live.current) {
        if (Math.hypot(moveEvent.clientX - start.startX, moveEvent.clientY - start.startY) < 5) return;
        const rect = start.element.getBoundingClientRect();
        live.current = { data: start.data, x: moveEvent.clientX, y: moveEvent.clientY, grabX: start.startX - rect.left, grabY: start.startY - rect.top, width: rect.width, height: rect.height };
        document.body.style.userSelect = "none";
        autoScroll(start.scroller);
      } else {
        live.current = { ...live.current, x: moveEvent.clientX, y: moveEvent.clientY };
      }
      setSession(live.current);
      handlersRef.current.onMove?.(live.current);
    };
    const finish = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", finish);
      document.body.style.userSelect = "";
      stopAutoScroll();
      const last = live.current;
      live.current = null;
      pending.current = null;
      setSession(null);
      if (last) handlersRef.current.onDrop(last);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", finish);
  };

  return { session, startDrag };
}

/** Index of the slot the pointer is over, given slot rects along one axis. */
export function slotIndexAt(rects: DOMRect[], coordinate: number, axis: "x" | "y"): number {
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index]!;
    const middle = axis === "x" ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
    if (coordinate < middle) return index;
  }
  return rects.length;
}
