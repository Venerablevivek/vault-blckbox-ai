'use client';

import { useId, useState } from 'react';
import { formatBytes } from '@/lib/api';

/**
 * Two hand-rolled SVG charts. No chart library: each is ~100 lines, has exactly the marks
 * it needs, and follows one set of rules —
 *   - thin bars with a 4px rounded data-end anchored to the baseline;
 *   - recessive gridlines, one y-axis, selective labels (never a number on every bar);
 *   - hover tooltips with hit targets wider than the mark;
 *   - a table view, so no value is reachable only by pointer or only by colour;
 *   - text in ink colours, never in the series colour.
 */

/** Categorical slots, validated as an ordered set (adjacent CVD ΔE ≥ 9.1 on white). */
export const CATEGORY_COLORS: Record<string, string> = {
  PDF: '#2a78d6',
  Documents: '#eb6834',
  Spreadsheets: '#1baf7a',
  Presentations: '#eda100',
  Images: '#e87ba4',
  'Text & other': '#008300',
};
/** Fixed order. Segments follow the entity, never their rank, so a filter never repaints them. */
export const CATEGORY_ORDER = Object.keys(CATEGORY_COLORS);

function barPath(x: number, base: number, width: number, height: number): string {
  if (height <= 0) return '';
  const r = Math.min(4, width / 2, height);
  const y = base - height;
  return `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${base} Z`;
}

function niceMax(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function DailyBars({
  title,
  unit,
  color,
  data,
}: {
  title: string;
  unit: string;
  color: string;
  data: Array<{ day: string; value: number }>;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const tableId = useId();

  const width = 520;
  const height = 180;
  const pad = { top: 12, right: 8, bottom: 24, left: 28 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const base = pad.top + plotH;
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const slot = plotW / Math.max(1, data.length);
  const barW = Math.max(6, Math.min(18, slot * 0.55));
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const hovered = hover === null ? null : data[hover];

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">{title}</p>
          <p className="mt-0.5 text-xs text-ink-muted">
            <span className="text-base font-semibold text-ink">{total}</span> {unit} in the last {data.length} days
          </p>
        </div>
        <button
          className="text-xs text-ink-muted hover:text-ink"
          onClick={() => setAsTable((v) => !v)}
          aria-controls={tableId}
        >
          {asTable ? 'View chart' : 'View table'}
        </button>
      </div>

      {asTable ? (
        <div id={tableId} className="mt-3 max-h-48 overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-ink-muted">
                <th className="py-1 font-medium">Day</th>
                <th className="py-1 text-right font-medium">{unit}</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {data.map((d) => (
                <tr key={d.day} className="border-t border-line">
                  <td className="py-1">{dayLabel(d.day)}</td>
                  <td className="py-1 text-right">{d.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative mt-3">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="h-auto w-full"
            role="img"
            aria-label={`${title}: ${total} ${unit} over ${data.length} days`}
          >
            {[0, 0.5, 1].map((f) => {
              const y = base - plotH * f;
              return (
                <g key={f}>
                  <line
                    x1={pad.left}
                    x2={width - pad.right}
                    y1={y}
                    y2={y}
                    stroke={f === 0 ? '#d3d8e3' : '#eef0f5'}
                    strokeWidth={1}
                  />
                  <text x={pad.left - 6} y={y + 3} textAnchor="end" className="fill-slate-400 text-[10px] tabular-nums">
                    {Math.round(max * f)}
                  </text>
                </g>
              );
            })}
            {data.map((d, i) => {
              const x = pad.left + slot * i + (slot - barW) / 2;
              const h = (d.value / max) * plotH;
              return (
                <g key={d.day}>
                  {hover === i ? (
                    <rect
                      x={pad.left + slot * i + 1}
                      y={pad.top}
                      width={slot - 2}
                      height={plotH}
                      rx={6}
                      fill="#f1f3f9"
                    />
                  ) : null}
                  <path d={barPath(x, base, barW, h)} fill={color} opacity={hover === null || hover === i ? 1 : 0.45} />
                  {/* Hit target: the whole column, far wider than the bar. */}
                  <rect
                    x={pad.left + slot * i}
                    y={pad.top}
                    width={slot}
                    height={plotH}
                    fill="transparent"
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                  />
                </g>
              );
            })}
            {[0, Math.floor((data.length - 1) / 2), data.length - 1].map((i) =>
              data[i] ? (
                <text
                  key={i}
                  x={pad.left + slot * i + slot / 2}
                  y={height - 6}
                  textAnchor="middle"
                  className="fill-slate-400 text-[10px]"
                >
                  {dayLabel(data[i]!.day)}
                </text>
              ) : null,
            )}
          </svg>
          {hovered && hover !== null ? (
            <div
              className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-lg bg-ink px-2.5 py-1.5 text-xs text-white shadow-lift"
              style={{ left: `${((pad.left + slot * hover + slot / 2) / width) * 100}%` }}
            >
              <span className="font-semibold tabular-nums">{hovered.value}</span> {unit}
              <span className="ml-1.5 text-slate-300">{dayLabel(hovered.day)}</span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function StorageBreakdown({ items }: { items: Array<{ category: string; count: number; bytes: number }> }) {
  const [hover, setHover] = useState<string | null>(null);
  const total = items.reduce((sum, i) => sum + i.bytes, 0);
  const ordered = CATEGORY_ORDER.map((c) => items.find((i) => i.category === c)).filter(
    (i): i is { category: string; count: number; bytes: number } => Boolean(i),
  );

  return (
    <div className="card p-5">
      <p className="text-sm font-semibold">Storage by type</p>
      <p className="mt-0.5 text-xs text-ink-muted">
        <span className="text-base font-semibold text-ink">{formatBytes(total)}</span> across{' '}
        {items.reduce((s, i) => s + i.count, 0)} files
      </p>

      {total === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-line-strong py-8 text-center text-sm text-ink-muted">
          Nothing stored yet
        </p>
      ) : (
        <>
          {/* Segments in fixed category order with a 2px surface gap between them. */}
          <div
            className="mt-4 flex h-3 w-full gap-[2px] overflow-hidden rounded-full"
            role="img"
            aria-label="Storage by file type"
          >
            {ordered.map((item) => (
              <div
                key={item.category}
                className="h-full transition-opacity first:rounded-l-full last:rounded-r-full"
                style={{
                  width: `${Math.max(1.5, (item.bytes / total) * 100)}%`,
                  background: CATEGORY_COLORS[item.category],
                  opacity: hover === null || hover === item.category ? 1 : 0.35,
                }}
                onMouseEnter={() => setHover(item.category)}
                onMouseLeave={() => setHover(null)}
                title={`${item.category}: ${formatBytes(item.bytes)}`}
              />
            ))}
          </div>

          {/* The legend carries every value as text: identity is never colour alone, and the
              lighter swatches (below 3:1 on white) always have a label beside them. */}
          <ul className="mt-4 space-y-1">
            {ordered.map((item) => (
              <li
                key={item.category}
                className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors ${hover === item.category ? 'bg-slate-50' : ''}`}
                onMouseEnter={() => setHover(item.category)}
                onMouseLeave={() => setHover(null)}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ background: CATEGORY_COLORS[item.category] }}
                  aria-hidden
                />
                <span className="flex-1">{item.category}</span>
                <span className="text-xs text-ink-muted tabular-nums">
                  {item.count} file{item.count === 1 ? '' : 's'}
                </span>
                <span className="w-16 text-right text-xs font-medium tabular-nums">{formatBytes(item.bytes)}</span>
                <span className="w-10 text-right text-xs text-ink-muted tabular-nums">
                  {Math.round((item.bytes / total) * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
