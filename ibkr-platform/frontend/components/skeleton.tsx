import { CSSProperties } from "react";

// Placeholder shapes shown while data loads, sized like the content they stand
// in for so nothing jumps when it arrives.
export function Shimmer({
  width = "100%",
  height,
  className = "",
}: {
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  className?: string;
}) {
  return <span aria-hidden="true" className={`shimmer ${className}`} style={{ width, height }} />;
}

export function ChartSkeleton({ label, height = 220 }: { label: string; height?: number }) {
  return (
    <div className="skeleton-block" role="status" aria-label={label}>
      <Shimmer height={height} className="shimmer-chart" />
    </div>
  );
}

export function LinesSkeleton({ label, lines = 3 }: { label: string; lines?: number }) {
  return (
    <div className="skeleton-block" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <Shimmer key={i} width={`${[92, 76, 84, 60][i % 4]}%`} />
      ))}
    </div>
  );
}

export function TilesSkeleton({ label, tiles = 4 }: { label: string; tiles?: number }) {
  return (
    <div className="kpis skeleton-tiles" role="status" aria-label={label}>
      {Array.from({ length: tiles }, (_, i) => (
        <div key={i}>
          <label>
            <Shimmer width="55%" />
          </label>
          <strong>
            <Shimmer width="70%" height="1em" />
          </strong>
          <small>
            <Shimmer width="45%" />
          </small>
        </div>
      ))}
    </div>
  );
}

export function TableRowsSkeleton({ columns, rows = 6 }: { columns: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} className="skeleton-row" aria-hidden="true">
          {Array.from({ length: columns }, (_, c) => (
            <td key={c}>
              <Shimmer width={c === 0 ? "80%" : `${50 + ((r * 7 + c * 13) % 40)}%`} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
