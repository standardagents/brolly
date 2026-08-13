import { useCallback, useEffect, useRef, useState } from "react";

export function useWizardNavigation(stepCount: number, initialStep: number, editing: boolean) {
  const [unlocked, setUnlocked] = useState(editing ? stepCount - 1 : initialStep);
  const [active, setActive] = useState(initialStep);
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
    if (initialStep > 0) scrollToSection(initialStep);
  }, [initialStep, scrollToSection]);

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
