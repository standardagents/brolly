import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Development-only deep link: `?step=4` opens the wizard with steps 1-3 done.
 * Vite drops the branch from production builds, so deployed wizards ignore it.
 */
function devInitialStep(stepCount: number): number | null {
  if (!import.meta.env.DEV) return null;
  const raw = new URLSearchParams(window.location.search).get("step");
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) return null;
  return Math.min(Math.max(parsed - 1, 0), stepCount - 1);
}

export function useWizardNavigation(stepCount: number, initialStep: number, editing: boolean) {
  const start = devInitialStep(stepCount) ?? initialStep;
  const [unlocked, setUnlocked] = useState(editing ? stepCount - 1 : start);
  const [active, setActive] = useState(start);
  const sectionRefs = useRef<Array<HTMLElement | null>>([]);

  const scrollToSection = useCallback((index: number) => {
    sectionRefs.current[index]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const advance = useCallback(() => {
    const next = Math.min(unlocked + 1, stepCount - 1);
    setUnlocked(next);
    setActive(next);
    requestAnimationFrame(() => requestAnimationFrame(() => scrollToSection(next)));
  }, [scrollToSection, stepCount, unlocked]);

  useEffect(() => {
    if (start > 0) scrollToSection(start);
  }, [start, scrollToSection]);

  useEffect(() => {
    const onScroll = () => {
      let current = 0;
      for (let index = 0; index <= unlocked; index += 1) {
        const top = sectionRefs.current[index]?.getBoundingClientRect().top;
        if (top !== undefined && top <= 140) current = index;
      }
      setActive(current);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [unlocked]);

  return { active, advance, scrollToSection, sectionRefs, unlocked };
}
