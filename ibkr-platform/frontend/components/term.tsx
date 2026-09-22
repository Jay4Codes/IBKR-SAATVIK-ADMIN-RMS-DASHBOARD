"use client";

import { ReactNode, useEffect, useId, useRef, useState } from "react";

const HOVER_DELAY = 300;

/**
 * A defined term. Hover or focus shows the definition after a short delay;
 * on touch it toggles. The tip is positioned in viewport space so it is
 * never clipped by a scrolling grid, and it sits on the tooltip layer.
 */
export function Term({ children, hint, className = "" }: { children: ReactNode; hint: ReactNode; className?: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const place = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const above = rect.top > 120;
    setPos({
      left: Math.min(Math.max(rect.left + rect.width / 2, 12), window.innerWidth - 12),
      top: above ? rect.top - 8 : rect.bottom + 8,
      above,
    });
  };
  const show = () => { place(); setOpen(true); };
  const hide = () => { if (timer.current) clearTimeout(timer.current); setOpen(false); };
  const enter = () => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(show, HOVER_DELAY); };

  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => {
      if (!trigger.current?.contains(event.target as Node)) hide();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [open]);

  return (
    <span className={`term ${className}`}>
      <button
        ref={trigger}
        type="button"
        className="term-trigger"
        aria-describedby={open ? id : undefined}
        onMouseEnter={enter}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => (open ? hide() : show())}
      >
        {children}
      </button>
      {open && pos && (
        <span
          role="tooltip"
          id={id}
          className={`tip ${pos.above ? "above" : "below"}`}
          style={{ left: pos.left, top: pos.top }}
        >
          {hint}
        </span>
      )}
    </span>
  );
}
