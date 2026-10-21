"use client";

/**
 * The application frame: a sidebar with every section (a drawer on small
 * screens), the organization switcher, and the signed-in person's menu.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { cx } from "@/components/ui";
import type { NavSection } from "@/lib/web/nav";

export interface ShellOrg {
  slug: string;
  name: string;
  isDemo: boolean;
  role: string;
}

const ICONS: Record<string, ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5V21H3z M9 21v-6h6v6" />,
  bank: <path d="M3 9h18L12 3zM5 9v9M9.5 9v9M14.5 9v9M19 9v9M3 21h18" />,
  sales: <path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h4" />,
  purchases: <path d="M4 5h16l-2 9H6zM6 14l-1 4h14M9 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM17 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" />,
  inventory: <path d="M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10" />,
  assets: <path d="M4 20h16M6 20V9l6-5 6 5v11M10 20v-5h4v5" />,
  projects: <path d="M3 6h7l2 2h9v11H3zM3 10h18" />,
  payroll: <path d="M4 6h16v12H4zM4 10h16M8 15h3" />,
  ledger: <path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11M9 8h6" />,
  reports: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  settings: <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1-2 2-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V20h-3v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1-2-2 .1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H4v-3h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1 2-2 .1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V4h3v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1 2 2-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H20v3h-.1a1.6 1.6 0 0 0-1.5 1z" />,
};

function Icon({ name }: { name: string }) {
  return (
    <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name] ?? <circle cx="12" cy="12" r="8" />}
    </svg>
  );
}

export function AppShell({
  org,
  orgs,
  nav,
  user,
  children,
  banner,
}: {
  org: ShellOrg;
  orgs: ShellOrg[];
  nav: NavSection[];
  user: { name: string; email: string };
  children: ReactNode;
  banner?: ReactNode;
}) {
  const pathname = usePathname();
  const base = `/o/${org.slug}`;
  const [open, setOpen] = useState(false);
  const current = pathname.slice(base.length) || "/";
  const activeSection = nav.find((s) => s.items.some((i) => current === i.href || current.startsWith(i.href + "/")))?.label;
  const [expanded, setExpanded] = useState<Set<string>>(new Set(activeSection ? [activeSection] : []));

  useEffect(() => {
    // "/" focuses search, unless typing in a field.
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const el = (document.getElementById("global-search-d") ?? document.getElementById("global-search-m")) as HTMLInputElement | null;
      if (el) {
        e.preventDefault();
        el.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Close the drawer and open the current section when the page changes (state adjusted during render, not in an effect).
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setOpen(false);
    if (activeSection && !expanded.has(activeSection)) setExpanded(new Set([...expanded, activeSection]));
  }

  const isActive = (href: string) => {
    if (current === href) return true;
    // The most specific item wins: /banking should not light up for /banking/rules.
    const all = nav.flatMap((s) => s.items.map((i) => i.href));
    const longer = all.filter((h) => h !== href && h.startsWith(href) && (current === h || current.startsWith(h + "/")));
    return current.startsWith(href + "/") && longer.length === 0;
  };

  const sidebar = (suffix: string) => (
    <nav aria-label="Main" className="flex h-full flex-col">
      <div className="space-y-2 border-b border-slate-200 p-3">
        <OrgSwitcher org={org} orgs={orgs} />
        <form action={`${base}/search`} method="get" role="search">
          <label htmlFor={`global-search-${suffix}`} className="sr-only">
            Search
          </label>
          <input
            id={`global-search-${suffix}`}
            name="q"
            placeholder="Search…  ( / )"
            className="block w-full rounded-md border-0 bg-slate-100 px-2.5 py-1.5 text-sm text-slate-900 placeholder:text-slate-500 focus:bg-white focus:ring-2 focus:ring-brand-600"
          />
        </form>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-3">
        <Link
          href={base}
          className={cx("mb-1 flex items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium", current === "/" ? "bg-brand-50 text-brand-700" : "text-slate-700 hover:bg-slate-100")}
          aria-current={current === "/" ? "page" : undefined}
        >
          <Icon name="home" /> Dashboard
        </Link>
        {nav.map((section) => {
          const isOpen = expanded.has(section.label);
          return (
            <div key={section.label} className="mb-0.5">
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setExpanded((e) => {
                  const n = new Set(e);
                  if (n.has(section.label)) n.delete(section.label);
                  else n.add(section.label);
                  return n;
                })}
                className={cx(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm font-medium",
                  activeSection === section.label ? "text-brand-700" : "text-slate-700",
                  "hover:bg-slate-100",
                )}
              >
                <Icon name={section.icon} />
                <span className="flex-1">{section.label}</span>
                <span aria-hidden="true" className={cx("text-xs text-slate-400 transition-transform", isOpen && "rotate-90")}>
                  ▸
                </span>
              </button>
              {isOpen && (
                <ul className="mb-1 ml-6 border-l border-slate-200 pl-2">
                  {section.items.map((item) => (
                    <li key={item.href}>
                      <Link
                        href={base + item.href}
                        aria-current={isActive(item.href) ? "page" : undefined}
                        className={cx(
                          "block rounded-md px-2.5 py-1.5 text-sm",
                          isActive(item.href) ? "bg-brand-50 font-medium text-brand-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                        )}
                      >
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      <div className="border-t border-slate-200 p-3 text-xs text-slate-500">
        <div className="truncate font-medium text-slate-700">{user.name}</div>
        <div className="truncate">{user.email}</div>
        <div className="mt-2 flex gap-3">
          <Link href="/account" className="hover:text-brand-600">
            Account
          </Link>
          <Link href="/orgs" className="hover:text-brand-600">
            Organizations
          </Link>
          <form action="/sign-out" method="post">
            <button type="submit" className="hover:text-brand-600">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:shadow">
        Skip to content
      </a>
      {banner}
      <div className="flex">
        <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-slate-200 bg-white lg:block">{sidebar("d")}</aside>
        {open && (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
            <div className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} />
            <aside className="absolute inset-y-0 left-0 w-72 bg-white shadow-xl">{sidebar("m")}</aside>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white/95 px-4 py-2.5 backdrop-blur lg:hidden no-print">
            <button type="button" onClick={() => setOpen(true)} className="rounded-md p-1.5 text-slate-700 hover:bg-slate-100" aria-label="Open navigation">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <span className="truncate text-sm font-semibold text-slate-900">{org.name}</span>
          </header>
          <main id="main" className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}

function OrgSwitcher({ org, orgs }: { org: ShellOrg; orgs: ShellOrg[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-slate-100"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/gideon-logo.svg" alt="" className="h-7 w-7" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-slate-900">{org.name}</span>
          <span className="block truncate text-xs text-slate-500">
            Gideon Books{org.isDemo ? " · Demo" : ""}
          </span>
        </span>
        <span aria-hidden="true" className="text-slate-400">
          ⇅
        </span>
      </button>
      {open && (
        <div className="absolute left-0 right-0 z-50 mt-1 max-h-80 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg" role="listbox">
          {orgs.map((o) => (
            <Link
              key={o.slug}
              href={`/o/${o.slug}`}
              role="option"
              aria-selected={o.slug === org.slug}
              className={cx("block px-3 py-2 text-sm hover:bg-slate-50", o.slug === org.slug && "bg-brand-50 text-brand-700")}
              onClick={() => setOpen(false)}
            >
              <span className="block truncate font-medium">{o.name}</span>
              <span className="text-xs text-slate-500">
                {o.role.replace("_", "-")}
                {o.isDemo ? " · demonstration" : ""}
              </span>
            </Link>
          ))}
          <div className="border-t border-slate-100" />
          <Link href="/orgs/new" className="block px-3 py-2 text-sm text-brand-700 hover:bg-slate-50">
            + New organization
          </Link>
          <Link href="/orgs" className="block px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
            All organizations
          </Link>
        </div>
      )}
    </div>
  );
}
