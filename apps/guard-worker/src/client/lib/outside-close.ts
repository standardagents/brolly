import { useEffect, type RefObject } from "react";

/**
 * Calls `onClose` on a pointer press outside every `ref` (or on Escape) while
 * `open` is true. Pass several refs when a menu renders through a portal and
 * its trigger lives elsewhere in the tree.
 */
export function useOutsideClose(ref: RefObject<HTMLElement | null> | RefObject<HTMLElement | null>[], open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const refs = Array.isArray(ref) ? ref : [ref];
    const onPointer = (event: PointerEvent) => {
      const inside = refs.some(item => item.current?.contains(event.target as Node));
      if (refs.some(item => item.current) && !inside) onClose();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, open, ref]);
}
