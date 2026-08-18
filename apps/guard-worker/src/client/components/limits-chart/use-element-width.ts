import { useLayoutEffect, useRef, useState } from "react";

/** Width of a container element in CSS pixels, tracked with ResizeObserver. */
export function useElementWidth<T extends HTMLElement>(fallback = 640): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const update = () => setWidth(Math.max(240, Math.round(element.getBoundingClientRect().width || fallback)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [fallback]);
  return [ref, width];
}
