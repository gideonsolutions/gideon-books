import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { groupAccountMappings, groupAccounts } from "@/lib/db/schema/consolidation";
import { groupContext } from "@/lib/consolidation/groups";
import { memberBalances, translationRates } from "@/lib/consolidation/report";
import { orgCtx, requireUser } from "@/lib/web/session";
import { dateParam, readParams, type SearchParams } from "@/lib/web/params";
import { minorUnits } from "@/lib/money/currency";
import { Alert, Money, PageHeader, Table, Td, Th } from "@/components/ui";

export const metadata = { title: "Consolidation detail" };

/** The member accounts behind one consolidated figure, each linked to that member's general ledger. */
export default async function Drill({ params, searchParams }: { params: Promise<{ org: string; group: string }>; searchParams: SearchParams }) {
  const { org, group: groupId } = await params;
  const sp = await readParams(searchParams);
  await orgCtx(org);
  const user = await requireUser();
  const db = getDb();
  const g = await groupContext(db, { userId: user.id, label: user.email }, groupId);
  const member = g.members.find((m) => m.org.id === sp.member);
  const to = dateParam(sp.to) ?? new Date().toISOString().slice(0, 10);
  const from = dateParam(sp.from) ?? `${to.slice(0, 4)}-01-01`;
  const [ga] = sp.ga ? await db.select().from(groupAccounts).where(and(eq(groupAccounts.groupId, groupId), eq(groupAccounts.id, sp.ga))) : [];
  if (!member || !ga) return <Alert tone="warning">Choose a figure on the consolidated statements to see what is behind it.</Alert>;
  const mapped = await db.select().from(groupAccountMappings).where(and(eq(groupAccountMappings.groupId, groupId), eq(groupAccountMappings.orgId, member.org.id), eq(groupAccountMappings.groupAccountId, ga.id)));
  const ids = new Set(mapped.map((m) => m.accountId));
  const balances = (await memberBalances(db, member.org.id, from, to)).filter((b) => ids.has(b.accountId) || (ga.role === "retained_earnings" && !b.prior.isZero()));
  const rates = await translationRates(db, g, member.org.id, member.org.baseCurrency, from, to);
  const mu = minorUnits(g.group.reportingCurrency);
  return (
    <>
      <PageHeader
        title={`${ga.code} ${ga.name} — ${member.org.name}`}
        back={{ href: `/o/${org}/consolidation/${groupId}/reports?from=${from}&to=${to}`, label: "Consolidated statements" }}
        description={`${from} to ${to}. Amounts in ${member.org.baseCurrency}, translated to ${g.group.reportingCurrency}. ${ga.role === "cta" ? "The translation adjustment is computed, not posted: it is what makes the translated member balance." : ""}`}
      />
      <Table>
        <thead>
          <tr>
            <Th>Member account</Th>
            <Th align="right">{member.org.baseCurrency}</Th>
            <Th align="right">Rate</Th>
            <Th align="right">{g.group.reportingCurrency}</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {balances.map((b) => {
            const pl = b.type === "income" || b.type === "expense";
            const amount = ga.role === "retained_earnings" && !ids.has(b.accountId) ? b.prior : b.amount;
            const rate = pl && !(ga.role === "retained_earnings" && !ids.has(b.accountId)) ? rates.average : rates.closing;
            return (
              <tr key={b.accountId}>
                <Td>
                  <Link className="text-brand-700 hover:underline" href={`/o/${member.org.slug}/reports/general-ledger?account=${b.accountId}&from=${pl ? from : ""}&to=${to}`}>
                    {b.code} {b.name}
                  </Link>
                  {ga.role === "retained_earnings" && !ids.has(b.accountId) && <span className="ml-2 text-xs text-slate-500">(income/expense before {from})</span>}
                </Td>
                <Td align="right">
                  <Money amount={amount.toString()} currency={member.org.baseCurrency} />
                </Td>
                <Td align="right" className="num text-xs">
                  {rate?.rate.normalize().toString() ?? "—"}
                </Td>
                <Td align="right">{rate ? <Money amount={amount.mul(rate.rate).round(mu, "half_up").toString()} currency={g.group.reportingCurrency} /> : "—"}</Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </>
  );
}
