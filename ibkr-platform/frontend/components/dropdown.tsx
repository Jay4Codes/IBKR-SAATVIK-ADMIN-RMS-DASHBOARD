"use client";

import { ChevronDown } from "lucide-react";
import { ReactNode, useEffect, useRef } from "react";

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

    document.addEventListener("click", away, true);
    return () => document.removeEventListener("click", away, true);
  }, []);

  return (
    <details ref={ref} className={`dropdown ${className}`}>
      <summary>
        {label}
        <b>{value}</b>
        <ChevronDown size={16} strokeWidth={2.25} aria-hidden="true" className="ss-caret" />
      </summary>
      {children}
    </details>
  );
}
