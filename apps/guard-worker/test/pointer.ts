/**
 * Pointer-event helpers for interaction tests. They encode the event names
 * React's delegated handlers expect in happy-dom: onPointerEnter/Leave fire
 * from `pointerover`/`pointerout`, never from `pointerenter`/`pointerleave`.
 */
export function pointer(target: Element, type: string, init: PointerEventInit = {}): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, ...init }));
}

export const hover = (target: Element, init: PointerEventInit = {}) => pointer(target, "pointerover", init);
export const leave = (target: Element, init: PointerEventInit = {}) => pointer(target, "pointerout", init);
export const pointerMove = (target: Element, init: PointerEventInit = {}) => pointer(target, "pointermove", init);

