"use client";

/**
 * Net income by month: one series (so no legend; the title names it),
 * columns from a single zero baseline in the brand hue, losses below it.
 * Hover or focus a column for income, expenses and net; the same figures
 * are in the table beneath.
 */
import { useState } from "react";
import { formatMoney } from "@/lib/money/format";

export interface ChartMonth {
  month: string;
  income: string;
  expenses: string;
  net: string;
}

const W = 640;
const H = 200;
const PAD = { top: 12, right: 8, bottom: 26, left: 52 };
const BAR = 22;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function label(m: string) {
  return MONTHS[Number(m.slice(5, 7)) - 1] ?? m;
}

/** Axis labels: deterministic (no locale data), so server and browser render the same text. */
function compact(v: number, currency: string) {
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  const unit = a >= 1e9 ? ["B", 1e9] : a >= 1e6 ? ["M", 1e6] : a >= 1e3 ? ["K", 1e3] : ["", 1];
  const n = a / (unit[1] as number);
  const text = n >= 100 || unit[0] === "" ? Math.round(n).toString() : (Math.round(n * 10) / 10).toString();
  return `${sign}${currency === "USD" ? "$" : ""}${text}${unit[0]}${currency === "USD" ? "" : ` ${currency}`}`;
}

export function NetIncomeChart({ data, currency }: { data: ChartMonth[]; currency: string }) {
  const [active, setActive] = useState<number | null>(null);
  // Display-only conversion: chart geometry needs numbers; figures shown are the exact strings.
  const nets = data.map((d) => Number(d.net));
  const max = Math.max(0, ...nets);
  const min = Math.min(0, ...nets);
  const span = max - min || 1;
  const innerH = H - PAD.top - PAD.bottom;
  const innerW = W - PAD.left - PAD.right;
  const y = (v: number) => PAD.top + ((max - v) / span) * innerH;
  const band = innerW / data.length;
  const ticks = [max, (max + min) / 2, min].filter((v, i, a) => a.indexOf(v) === i);
  const a = active !== null ? data[active] : null;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Net income by month for the last twelve months; figures in the table below.">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="#e2e8f0" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" className="fill-slate-500" fontSize="10">
              {compact(t, currency)}
            </text>
          </g>
        ))}
        <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} stroke="#94a3b8" strokeWidth={1} />
        {data.map((d, i) => {
          const v = nets[i]!;
          const x = PAD.left + i * band + (band - BAR) / 2;
          const top = y(Math.max(v, 0));
          const bottom = y(Math.min(v, 0));
          const h = Math.max(bottom - top, v === 0 ? 0 : 1);
          const r = Math.min(4, h);
          // Rounded at the data end, square at the baseline.
          const path =
            v >= 0
              ? `M${x},${bottom} V${top + r} Q${x},${top} ${x + r},${top} H${x + BAR - r} Q${x + BAR},${top} ${x + BAR},${top + r} V${bottom} Z`
              : `M${x},${top} V${bottom - r} Q${x},${bottom} ${x + r},${bottom} H${x + BAR - r} Q${x + BAR},${bottom} ${x + BAR},${bottom - r} V${top} Z`;
          return (
            <g key={d.month}>
              <path d={path} fill="#013ea9" opacity={active === null || active === i ? 1 : 0.45} />
              <text x={PAD.left + i * band + band / 2} y={H - 8} textAnchor="middle" fontSize="10" className="fill-slate-500">
                {label(d.month)}
              </text>
              {/* Hit target: the whole column band, bigger than the bar. */}
              <rect
                x={PAD.left + i * band}
                y={PAD.top}
                width={band}
                height={innerH}
                fill="transparent"
                tabIndex={0}
                role="button"
                aria-label={`${label(d.month)} ${d.month.slice(0, 4)}: net ${formatMoney(d.net, currency)}`}
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              />
            </g>
          );
        })}
      </svg>
      {a && active !== null && (
        <div
          className="pointer-events-none absolute top-0 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg"
          style={{ left: `min(calc(${((PAD.left + active * band + band / 2) / W) * 100}% + 8px), calc(100% - 11rem))` }}
          role="status"
        >
          <div className="font-semibold text-slate-900">
            {label(a.month)} {a.month.slice(0, 4)}
          </div>
          <div className="num text-slate-600">Income {formatMoney(a.income, currency)}</div>
          <div className="num text-slate-600">Expenses {formatMoney(a.expenses, currency)}</div>
          <div className="num font-medium text-slate-900">Net {formatMoney(a.net, currency)}</div>
        </div>
      )}
    </div>
  );
}
