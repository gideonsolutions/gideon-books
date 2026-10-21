/** Payroll integration settings: the import adapters available, and any provider connections. */
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { integrationConnections } from "@/lib/db/schema/core";
import type { Ctx } from "@/lib/context";
import { ADAPTERS } from "@/lib/payroll/adapters";
import { Card } from "@/components/ui";

export async function PayrollSection({ ctx }: { ctx: Ctx }) {
  const connections = await getDb()
    .select()
    .from(integrationConnections)
    .where(and(eq(integrationConnections.orgId, ctx.orgId), eq(integrationConnections.kind, "payroll")));
  return (
    <Card title="Payroll">
      <p className="text-sm text-slate-700">
        Payroll is calculated by your payroll provider and imported here as a file; Gideon Books posts what the provider calculated and never calculates payroll taxes or files payroll returns.
      </p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
        {ADAPTERS.map((a) => (
          <li key={a.key}>
            {a.label} <span className="text-slate-500">({a.fileTypes})</span> — always available.
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-slate-600">
        {connections.length === 0
          ? "No live payroll provider connection is configured. Provider-specific adapters are not built in because their export formats were not verified; convert your provider's payroll register to the documented format."
          : `${connections.length} provider connection${connections.length === 1 ? "" : "s"}: ${connections.map((c) => `${c.displayName} (${c.mode})`).join(", ")}.`}
      </p>
      <Link href={`/o/${ctx.org.slug}/payroll/import`} className="mt-3 inline-block text-sm font-medium text-brand-700 hover:underline">
        Import a payroll →
      </Link>
    </Card>
  );
}
