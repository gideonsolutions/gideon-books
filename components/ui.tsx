/**
 * Presentational building blocks (server-safe: no state, no effects).
 * Interactive pieces are in components/client.
 */
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { formatDate, formatMoney } from "@/lib/money/format";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ── Buttons ─────────────────────────────────────────────────────────────────

type Variant = "primary" | "secondary" | "danger" | "ghost";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 shadow-sm disabled:bg-brand-600/50",
  secondary: "bg-white text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 shadow-sm disabled:text-slate-400",
  danger: "bg-danger-600 text-white hover:bg-danger-700 shadow-sm disabled:bg-danger-600/50",
  ghost: "text-slate-700 hover:bg-slate-100 disabled:text-slate-400",
};
const SIZES = { sm: "px-2.5 py-1.5 text-xs", md: "px-3.5 py-2 text-sm", lg: "px-5 py-2.5 text-base" };

export function buttonClass(variant: Variant = "primary", size: keyof typeof SIZES = "md", extra?: string) {
  return cx(
    "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed whitespace-nowrap",
    VARIANTS[variant],
    SIZES[size],
    extra,
  );
}

export function Button({ variant = "primary", size = "md", className, ...props }: ComponentProps<"button"> & { variant?: Variant; size?: keyof typeof SIZES }) {
  return <button type={props.type ?? "button"} className={buttonClass(variant, size, className)} {...props} />;
}

export function LinkButton({ variant = "primary", size = "md", className, ...props }: ComponentProps<typeof Link> & { variant?: Variant; size?: keyof typeof SIZES }) {
  return <Link className={buttonClass(variant, size, className)} {...props} />;
}

// ── Layout ──────────────────────────────────────────────────────────────────

export function PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <div className="mb-6">
      {back && (
        <Link href={back.href} className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600">
          <span aria-hidden="true">←</span> {back.label}
        </Link>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {description && <div className="mt-1 max-w-3xl text-sm text-slate-600">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2 sm:max-w-[65%] sm:shrink-0 sm:justify-end no-print">{actions}</div>}
      </div>
    </div>
  );
}

export function Card({ title, actions, children, className, padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx("rounded-lg border border-slate-200 bg-white shadow-sm", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? "p-4" : ""}>{children}</div>
    </section>
  );
}

export function Grid({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  const c = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-2 lg:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4" }[cols];
  return <div className={cx("grid gap-4", c)}>{children}</div>;
}

export function Stat({ label, value, hint, href, tone }: { label: string; value: ReactNode; hint?: ReactNode; href?: string; tone?: "default" | "warning" | "danger" | "good" }) {
  const toneClass = { default: "text-slate-900", warning: "text-amber-700", danger: "text-danger-700", good: "text-emerald-700" }[tone ?? "default"];
  const body = (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cx("num mt-1 text-2xl font-semibold", toneClass)}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
  return href ? (
    <Link href={href} className="block focus-visible:rounded-lg">
      {body}
    </Link>
  ) : (
    body
  );
}

export function DescriptionList({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((i) => (
        <div key={i.label}>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{i.label}</dt>
          <dd className="mt-0.5 text-sm text-slate-900">{i.value ?? <span className="text-slate-400">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Feedback ────────────────────────────────────────────────────────────────

export function Alert({ tone = "info", title, children }: { tone?: "info" | "warning" | "danger" | "success"; title?: ReactNode; children?: ReactNode }) {
  const t = {
    info: "border-brand-200 bg-brand-50 text-brand-800",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
    danger: "border-danger-100 bg-danger-50 text-danger-700",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  }[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cx("rounded-md border px-4 py-3 text-sm", t)}>
      {title && <div className="font-semibold">{title}</div>}
      {children && <div className={title ? "mt-1" : ""}>{children}</div>}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <div className="text-base font-semibold text-slate-900">{title}</div>
      {children && <div className="mt-1 max-w-md text-sm text-slate-600">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

const BADGE_TONES = {
  gray: "bg-slate-100 text-slate-700 ring-slate-200",
  blue: "bg-brand-50 text-brand-700 ring-brand-200",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-danger-50 text-danger-700 ring-danger-100",
};
export type BadgeTone = keyof typeof BADGE_TONES;

export function Badge({ tone = "gray", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap", BADGE_TONES[tone])}>{children}</span>;
}

/** A tone for common status words. */
export function statusTone(status: string): BadgeTone {
  if (/overdue|void|dead|failed|declined|cancelled|error|bounced/i.test(status)) return "red";
  if (/draft|pending|queued|unreviewed|partially|in progress|running|sent/i.test(status)) return "amber";
  if (/paid|posted|closed|complete|succeeded|reconciled|matched|received|accepted|active|delivered/i.test(status)) return "green";
  if (/issued|open/i.test(status)) return "blue";
  return "gray";
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone(status)}>{status}</Badge>;
}

// ── Figures ─────────────────────────────────────────────────────────────────

export function Money({ amount, currency, className, showZero = true }: { amount: string | null | undefined; currency: string; className?: string; showZero?: boolean }) {
  if (amount === null || amount === undefined) return <span className="text-slate-400">—</span>;
  const isZero = /^-?0(\.0+)?$/.test(amount);
  if (isZero && !showZero) return <span className="text-slate-400">—</span>;
  const neg = amount.startsWith("-") && !isZero;
  return <span className={cx("num", neg && "text-danger-700", className)}>{formatMoney(amount, currency)}</span>;
}

export function DateText({ date }: { date: string | null | undefined }) {
  if (!date) return <span className="text-slate-400">—</span>;
  return <time dateTime={date}>{formatDate(date)}</time>;
}

// ── Tables ──────────────────────────────────────────────────────────────────

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm", className)}>
      <table className="min-w-full divide-y divide-slate-200 text-sm">{children}</table>
    </div>
  );
}

export function Th({ children, align = "left", className }: { children?: ReactNode; align?: "left" | "right" | "center"; className?: string }) {
  return (
    <th scope="col" className={cx("whitespace-nowrap bg-slate-50 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-600", align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left", className)}>
      {children}
    </th>
  );
}

export function Td({ children, align = "left", className, colSpan }: { children?: ReactNode; align?: "left" | "right" | "center"; className?: string; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={cx("px-3 py-2.5 align-top text-slate-800", align === "right" ? "text-right" : align === "center" ? "text-center" : "", className)}>
      {children}
    </td>
  );
}

/** A sortable column header: links toggle ?sort=<key>_asc|_desc, keeping other params. */
export function SortTh({ label, sortKey, current, params, align }: { label: string; sortKey: string; current?: string | null; params: Record<string, string | undefined>; align?: "left" | "right" }) {
  const asc = `${sortKey}_asc`;
  const desc = `${sortKey}_desc`;
  const next = current === asc ? desc : asc;
  const q = new URLSearchParams(Object.entries({ ...params, sort: next, page: undefined }).filter(([, v]) => v !== undefined && v !== "") as [string, string][]);
  const arrow = current === asc ? "↑" : current === desc ? "↓" : "";
  return (
    <Th align={align}>
      <Link href={`?${q.toString()}`} className="inline-flex items-center gap-1 hover:text-brand-700" aria-sort={current === asc ? "ascending" : current === desc ? "descending" : "none"}>
        {label} <span aria-hidden="true">{arrow}</span>
      </Link>
    </Th>
  );
}

export function Pagination({ page, pageSize, total, params }: { page: number; pageSize: number; total: number; params: Record<string, string | undefined> }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return total > 0 ? <p className="mt-3 text-xs text-slate-500">{total} shown</p> : null;
  const href = (p: number) => {
    const q = new URLSearchParams(Object.entries({ ...params, page: String(p) }).filter(([, v]) => v !== undefined && v !== "") as [string, string][]);
    return `?${q.toString()}`;
  };
  return (
    <nav className="mt-3 flex items-center justify-between text-sm" aria-label="Pagination">
      <span className="text-slate-500">
        {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link className={buttonClass("secondary", "sm")} href={href(page - 1)} rel="prev">
            Previous
          </Link>
        ) : (
          <span className={buttonClass("secondary", "sm", "opacity-50")}>Previous</span>
        )}
        {page < pages ? (
          <Link className={buttonClass("secondary", "sm")} href={href(page + 1)} rel="next">
            Next
          </Link>
        ) : (
          <span className={buttonClass("secondary", "sm", "opacity-50")}>Next</span>
        )}
      </div>
    </nav>
  );
}

/** A GET form for search and filters; it keeps the URL as the source of truth. */
export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <form method="get" className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm no-print" role="search">
      {children}
      <button type="submit" className={buttonClass("secondary", "md")}>
        Apply
      </button>
    </form>
  );
}

export function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
      {label}
      {children}
    </label>
  );
}

export const inputClass =
  "block w-full rounded-md border-0 bg-white px-2.5 py-1.5 text-sm text-slate-900 shadow-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-inset focus:ring-brand-600 disabled:bg-slate-50 disabled:text-slate-500 aria-[invalid=true]:ring-danger-600";

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-slate-300 bg-slate-50 px-1 font-mono text-[11px] text-slate-600">{children}</kbd>;
}

export function Breadcrumb({ items }: { items: { href?: string; label: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-2 text-sm text-slate-500">
      {items.map((i, n) => (
        <span key={n}>
          {n > 0 && <span className="mx-1.5 text-slate-300">/</span>}
          {i.href ? (
            <Link href={i.href} className="hover:text-brand-600">
              {i.label}
            </Link>
          ) : (
            <span className="text-slate-700">{i.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
