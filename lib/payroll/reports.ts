/**
 * Payroll reports: the summary of runs in a period (by component, by
 * department and project), and the payroll liability report — what payroll
 * runs accrued to each liability account, what was paid, and what is still
 * owed — reconciled to the ledger.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { dimensionValues, projects } from "@/lib/db/schema/ledger";
import { Decimal } from "@/lib/money/decimal";
import { COMPONENT_LABELS } from "./mappings";
import { payrollLiabilityAccounts } from "./settlements";
import type { PayrollComponentType } from "@/lib/db/schema/payroll";

export async function payrollSummary(db: DbOrTx, orgId: string, from: string, to: string) {
  const runs = await db.execute<{ id: string; provider_run_id: string; pay_date: string; employee_count: number; gross_wages: string; employee_withholdings: string; employee_deductions: string; employer_taxes: string; employer_benefits: string; reimbursements: string; net_pay: string }>(sql`
    select id, provider_run_id, pay_date, employee_count, gross_wages::text, employee_withholdings::text, employee_deductions::text,
           employer_taxes::text, employer_benefits::text, reimbursements::text, net_pay::text
    from payroll_runs where org_id = ${orgId} and status = 'posted' and pay_date between ${from} and ${to}
    order by pay_date
  `);
  const sum = (k: keyof (typeof runs.rows)[number]) => Decimal.sum(runs.rows.map((r) => r[k] as string)).toString();
  const totals = {
    grossWages: sum("gross_wages"),
    employeeWithholdings: sum("employee_withholdings"),
    employeeDeductions: sum("employee_deductions"),
    employerTaxes: sum("employer_taxes"),
    employerBenefits: sum("employer_benefits"),
    reimbursements: sum("reimbursements"),
    netPay: sum("net_pay"),
    employerCost: Decimal.sum([sum("gross_wages"), sum("employer_taxes"), sum("employer_benefits"), sum("reimbursements")]).toString(),
  };
  const byComponent = await db.execute<{ component_type: PayrollComponentType; component_code: string; amount: string }>(sql`
    select l.component_type, l.component_code, sum(l.amount)::text as amount
    from payroll_run_lines l join payroll_runs r on r.org_id = l.org_id and r.id = l.run_id
    where l.org_id = ${orgId} and r.status = 'posted' and r.pay_date between ${from} and ${to}
    group by l.component_type, l.component_code order by l.component_type, l.component_code
  `);
  // Employer cost (gross + employer taxes and benefits + reimbursements) by department and by project.
  const byDim = await db.execute<{ department_id: string | null; project_id: string | null; amount: string }>(sql`
    select l.department_id, l.project_id, sum(l.amount)::text as amount
    from payroll_run_lines l join payroll_runs r on r.org_id = l.org_id and r.id = l.run_id
    where l.org_id = ${orgId} and r.status = 'posted' and r.pay_date between ${from} and ${to}
      and l.component_type in ('gross_wages','employer_tax','employer_benefit','reimbursement')
    group by l.department_id, l.project_id
  `);
  const deptIds = [...new Set(byDim.rows.map((r) => r.department_id).filter(Boolean) as string[])];
  const projIds = [...new Set(byDim.rows.map((r) => r.project_id).filter(Boolean) as string[])];
  const depts = deptIds.length ? await db.select().from(dimensionValues).where(and(eq(dimensionValues.orgId, orgId), inArray(dimensionValues.id, deptIds))) : [];
  const projs = projIds.length ? await db.select().from(projects).where(and(eq(projects.orgId, orgId), inArray(projects.id, projIds))) : [];
  const group = (key: "department_id" | "project_id", names: Map<string, string>) => {
    const m = new Map<string, Decimal>();
    for (const r of byDim.rows) {
      const k = r[key] ?? "";
      m.set(k, (m.get(k) ?? Decimal.ZERO).add(r.amount));
    }
    return [...m.entries()].map(([id, amount]) => ({ id: id || null, name: id ? (names.get(id) ?? id) : "Unassigned", amount: amount.toString() })).sort((a, b) => a.name.localeCompare(b.name));
  };
  return {
    from,
    to,
    runs: runs.rows,
    totals,
    byComponent: byComponent.rows.map((r) => ({ type: r.component_type, label: COMPONENT_LABELS[r.component_type], code: r.component_code, amount: r.amount })),
    byDepartment: group("department_id", new Map(depts.map((d) => [d.id, d.name]))),
    byProject: group("project_id", new Map(projs.map((p) => [p.id, p.name]))),
  };
}

export interface LiabilityRow {
  accountId: string;
  code: string;
  name: string;
  opening: string;
  accrued: string;
  paid: string;
  other: string;
  closing: string;
  ledger: string;
  difference: string;
}

/**
 * For each payroll liability account (amounts owed, positive): opening
 * balance, accrued by payroll runs, paid by recorded payroll payments, other
 * postings, closing — and the ledger balance it must equal.
 */
export async function payrollLiabilityReport(db: DbOrTx, orgId: string, from: string, to: string) {
  const accs = await payrollLiabilityAccounts(db, orgId);
  if (!accs.length) return { from, to, rows: [] as LiabilityRow[], reconciled: true };
  const ids = accs.map((a) => a.id);
  const res = await db.execute<{ account_id: string; bucket: string; amount: string }>(sql`
    select l.account_id,
      case
        when e.entry_date < ${from} then 'opening'
        when e.source_type = 'payroll_run' then 'accrued'
        when e.source_type = 'payroll_settlement' then 'paid'
        else 'other'
      end as bucket,
      sum(l.base_amount)::text as amount
    from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    where l.org_id = ${orgId} and e.status = 'posted' and e.entry_date <= ${to}
      and l.account_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    group by l.account_id, bucket
  `);
  const rows: LiabilityRow[] = accs.map((a) => {
    const get = (b: string) => Decimal.sum(res.rows.filter((r) => r.account_id === a.id && r.bucket === b).map((r) => r.amount)).neg();
    const opening = get("opening");
    const accrued = get("accrued");
    // Payments reduce what is owed: shown as a positive amount paid.
    const paid = get("paid").neg();
    const other = get("other");
    const closing = opening.add(accrued).sub(paid).add(other);
    const ledger = Decimal.sum(res.rows.filter((r) => r.account_id === a.id).map((r) => r.amount)).neg();
    return {
      accountId: a.id,
      code: a.code,
      name: a.name,
      opening: opening.toString(),
      accrued: accrued.toString(),
      paid: paid.toString(),
      other: other.toString(),
      closing: closing.toString(),
      ledger: ledger.toString(),
      difference: ledger.sub(closing).toString(),
    };
  });
  return { from, to, rows, reconciled: rows.every((r) => Decimal.from(r.difference).isZero()) };
}

