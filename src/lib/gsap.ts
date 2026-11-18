import { useEffect, type RefObject } from 'react';
import gsap from 'gsap';

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function usePageEnter(containerRef: RefObject<HTMLElement | null>, key?: string) {
  useEffect(() => {
    const el = containerRef.current;
    if (!el || prefersReducedMotion()) return;

    const ctx = gsap.context(() => {
      gsap.fromTo(
        el,
        { opacity: 0.92, y: 6 },
        { opacity: 1, y: 0, duration: 0.2, ease: 'power2.out', clearProps: 'opacity,transform' }
      );
    }, containerRef);

    return () => ctx.revert();
  }, [containerRef, key]);
}

export function useStaggerReveal(
  containerRef: RefObject<HTMLElement | null>,
  selector: string,
  triggerKey: unknown
) {
  useEffect(() => {
    const el = containerRef.current;
    if (!el || prefersReducedMotion()) return;

    const ctx = gsap.context(() => {
      const targets = el.querySelectorAll(selector);
      if (targets.length === 0) return;
      gsap.fromTo(
        targets,
        { opacity: 0.85, y: 6 },
        {
          opacity: 1,
          y: 0,
          duration: 0.18,
          stagger: 0.025,
          ease: 'power2.out',
          clearProps: 'opacity,transform',
        }
      );
    }, containerRef);

    return () => ctx.revert();
  }, [containerRef, selector, triggerKey]);
}

export function animateModalPanel(el: HTMLElement | null): () => void {
  if (!el || prefersReducedMotion()) return () => {};
  const ctx = gsap.context(() => {
    gsap.fromTo(
      el,
      { opacity: 0, scale: 0.97, y: 6 },
      { opacity: 1, scale: 1, y: 0, duration: 0.18, ease: 'power2.out', clearProps: 'transform' }
    );
  });
  return () => ctx.revert();
}

export function animateSaveConfirmation(el: HTMLElement | null): void {
  if (!el || prefersReducedMotion()) return;
  gsap.fromTo(
    el,
    { opacity: 0.5, scale: 0.98 },
    { opacity: 1, scale: 1, duration: 0.2, ease: 'power2.out', clearProps: 'transform' }
  );
}
