import { getDb } from "@/lib/db/client";
import { orgsForUser } from "@/lib/orgs/orgs";
import { orgCtx, requireUser } from "@/lib/web/session";
import { NAV } from "@/lib/web/nav";
import { ROLE_PERMISSIONS } from "@/lib/authz/permissions";
import { AppShell } from "@/components/client/shell";

export default async function OrgLayout({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const ctx = await orgCtx(slug);
  const user = await requireUser();
  const memberships = await orgsForUser(getDb(), user.id);
  const perms = ROLE_PERMISSIONS[ctx.role];
  const nav = NAV.map((s) => ({ ...s, items: s.items.filter((i) => !i.permission || perms.has(i.permission)) })).filter((s) => s.items.length);
  const banner = ctx.org.isDemo ? (
    <div className="bg-amber-400 px-4 py-1.5 text-center text-sm font-medium text-amber-950 no-print" role="note">
      Demonstration company — synthetic data for exploring. Not real books; nothing here is sent, charged or filed.
    </div>
  ) : undefined;
  return (
    <AppShell
      org={{ slug: ctx.org.slug, name: ctx.org.name, isDemo: ctx.org.isDemo, role: ctx.role }}
      orgs={memberships.map((m) => ({ slug: m.org.slug, name: m.org.name, isDemo: m.org.isDemo, role: m.role }))}
      nav={nav}
      user={{ name: user.name, email: user.email }}
      banner={banner}
    >
      {children}
    </AppShell>
  );
}
