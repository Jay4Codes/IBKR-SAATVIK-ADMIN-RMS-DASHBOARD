"use client";

export type Segment<T extends string> = { id: T; label: string; count?: number | string; title?: string; disabled?: boolean };

export function Segmented<T extends string>({ label, value, options, onChange, size = "md", className = "" }: {
  label: string;
  value: T;
  options: Segment<T>[];
  onChange: (next: T) => void;
  size?: "md" | "sm";
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`segmented ${size} ${className}`}>
      {options.map(option => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={option.id === value}
          className={option.id === value ? "on" : ""}
          title={option.title}
          disabled={option.disabled}
          onClick={() => onChange(option.id)}
        >
          {option.label}
          {option.count !== undefined && <small>{option.count}</small>}
        </button>
      ))}
    </div>
  );
}
