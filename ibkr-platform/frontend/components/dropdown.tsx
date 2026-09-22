"use client";

import { ReactNode, useEffect, useRef } from "react";

/** A disclosure menu that closes when you click away from it.
 *
 *  `<details>` is used rather than a hand-built popover because it already
 *  handles the keyboard, focus and Escape correctly. The one thing it does not
 *  do is close on an outside click, which every menu is expected to — so that
 *  single behaviour is added here rather than reimplementing the rest.
 */
export function Dropdown({
  label,
  value,
  className = "",
  children,
}: {
  label: string;
  value: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const away = (event: MouseEvent) => {
      if (node.open && !node.contains(event.target as Node)) node.open = false;
    };
    // Captured, so a click on something that stops propagation still closes it.
    document.addEventListener("click", away, true);
    return () => document.removeEventListener("click", away, true);
  }, []);

  return (
    <details ref={ref} className={`dropdown ${className}`}>
      <summary>
        {label}
        <b>{value}</b>
      </summary>
      {children}
    </details>
  );
}
