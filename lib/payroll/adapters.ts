/**
 * Payroll import adapters. Each turns a provider's file into the same
 * normalized run: one row per employee (or per run, for summary files) per
 * component. The generic CSV and JSON formats are documented in
 * docs/payroll-import-format.md; a provider-specific adapter is added by
 * implementing `PayrollAdapter` and listing it in ADAPTERS.
 *
 * Gideon Books does not calculate payroll: these figures are what the
 * payroll provider calculated, checked and posted as given.
 */
import { Decimal } from "@/lib/money/decimal";
import { isIsoDate } from "@/lib/dates";
import { PAYROLL_COMPONENT_TYPES, type PayrollComponentType } from "@/lib/db/schema/payroll";
import { parseCsv } from "./csv";

export interface ParsedComponent {
  employeeRef: string | null;
  employeeName: string | null;
  type: PayrollComponentType;
  code: string;
  /** Decimal string as given. */
  amount: string;
  department: string | null;
  class: string | null;
  location: string | null;
  project: string | null;
}

export interface ParsedRun {
  providerRunId: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  level: "employee" | "summary";
  components: ParsedComponent[];
}

export interface ParseResult {
  run: ParsedRun | null;
  errors: string[];
}

export interface PayrollAdapter {
  key: string;
  label: string;
  /** What the person uploads. */
  fileTypes: string;
  parse(content: string): ParseResult;
}

/** Column prefixes of the generic employee-level CSV and the component type each holds. */
export const CSV_PREFIXES: Record<string, PayrollComponentType> = {
  gross: "gross_wages",
  withholding: "employee_withholding",
  deduction: "employee_deduction",
  employer_tax: "employer_tax",
  employer_benefit: "employer_benefit",
  reimbursement: "reimbursement",
};

const JSON_GROUPS: Record<string, PayrollComponentType> = {
  earnings: "gross_wages",
  withholdings: "employee_withholding",
  deductions: "employee_deduction",
  employer_taxes: "employer_tax",
  employer_benefits: "employer_benefit",
  reimbursements: "reimbursement",
};

export function parseAmount(raw: string): string | null {
  const t = raw.replace(/[$,\s]/g, "");
  if (t === "") return "0";
  const neg = /^\(.*\)$/.test(t);
  const d = Decimal.tryFrom(neg ? `-${t.slice(1, -1)}` : t);
  return d ? d.toString() : null;
}

const CODE_RE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

function checkHeader(run: { providerRunId: string; payDate: string; periodStart: string; periodEnd: string }, errors: string[]) {
  if (!run.providerRunId) errors.push("The run id is missing.");
  if (!isIsoDate(run.payDate)) errors.push(`The pay date "${run.payDate}" is not a date (use YYYY-MM-DD).`);
  if (!isIsoDate(run.periodStart)) errors.push(`The period start "${run.periodStart}" is not a date (use YYYY-MM-DD).`);
  if (!isIsoDate(run.periodEnd)) errors.push(`The period end "${run.periodEnd}" is not a date (use YYYY-MM-DD).`);
  if (isIsoDate(run.periodStart) && isIsoDate(run.periodEnd) && run.periodStart > run.periodEnd) errors.push("The period ends before it starts.");
}

export const genericCsv: PayrollAdapter = {
  key: "generic_csv",
  label: "Generic CSV (Gideon Books format)",
  fileTypes: ".csv",
  parse(content) {
    const errors: string[] = [];
    const rows = parseCsv(content);
    if (rows.length < 2) return { run: null, errors: ["The file has no data rows."] };
    const header = rows[0]!.map((h) => h.trim().toLowerCase());
    const col = (name: string) => header.indexOf(name);
    for (const required of ["run_id", "pay_date", "period_start", "period_end"]) {
      if (col(required) < 0) errors.push(`The column "${required}" is missing.`);
    }
    if (errors.length) return { run: null, errors };
    const summary = col("component_type") >= 0;
    const cell = (r: string[], name: string) => {
      const i = col(name);
      return i >= 0 ? (r[i] ?? "").trim() : "";
    };
    const data = rows.slice(1);
    const first = data[0]!;
    const run: ParsedRun = {
      providerRunId: cell(first, "run_id"),
      payDate: cell(first, "pay_date"),
      periodStart: cell(first, "period_start"),
      periodEnd: cell(first, "period_end"),
      level: summary ? "summary" : "employee",
      components: [],
    };
    checkHeader(run, errors);
    const dims = (r: string[]) => ({
      department: cell(r, "department") || null,
      class: cell(r, "class") || null,
      location: cell(r, "location") || null,
      project: cell(r, "project") || null,
    });
    data.forEach((r, i) => {
      const line = i + 2;
      if (cell(r, "run_id") !== run.providerRunId || cell(r, "pay_date") !== run.payDate) {
        errors.push(`Row ${line}: every row must belong to the same run (run_id and pay_date); import one run per file.`);
        return;
      }
      if (summary) {
        const type = cell(r, "component_type") as PayrollComponentType;
        if (!PAYROLL_COMPONENT_TYPES.includes(type)) {
          errors.push(`Row ${line}: unknown component_type "${cell(r, "component_type")}".`);
          return;
        }
        const code = (cell(r, "component_code") || (type === "net_pay" ? "net_pay" : "")).toLowerCase();
        if (!CODE_RE.test(code)) errors.push(`Row ${line}: component_code "${code}" must be lowercase letters, digits, dots, dashes or underscores.`);
        const amount = parseAmount(cell(r, "amount"));
        if (amount === null) errors.push(`Row ${line}: amount "${cell(r, "amount")}" is not a number.`);
        else run.components.push({ employeeRef: null, employeeName: null, type, code, amount, ...dims(r) });
        return;
      }
      const employeeRef = cell(r, "employee_id");
      const employeeName = cell(r, "employee_name");
      if (!employeeRef) errors.push(`Row ${line}: employee_id is missing.`);
      header.forEach((h, idx) => {
        const m = /^([a-z_]+):(.+)$/.exec(h);
        const raw = (r[idx] ?? "").trim();
        if (m && CSV_PREFIXES[m[1]!]) {
          if (raw === "") return;
          const code = m[2]!.trim().toLowerCase();
          if (!CODE_RE.test(code)) {
            errors.push(`Column "${h}": the code after the colon must be lowercase letters, digits, dots, dashes or underscores.`);
            return;
          }
          const amount = parseAmount(raw);
          if (amount === null) errors.push(`Row ${line}, column ${h}: "${raw}" is not a number.`);
          else if (!Decimal.from(amount).isZero()) run.components.push({ employeeRef, employeeName, type: CSV_PREFIXES[m[1]!]!, code, amount, ...dims(r) });
        } else if (h === "net_pay") {
          const amount = parseAmount(raw);
          if (amount === null) errors.push(`Row ${line}, net_pay: "${raw}" is not a number.`);
          else run.components.push({ employeeRef, employeeName, type: "net_pay", code: "net_pay", amount, ...dims(r) });
        } else if (m && !CSV_PREFIXES[m[1]!]) {
          errors.push(`Column "${h}": unknown prefix "${m[1]}" (use ${Object.keys(CSV_PREFIXES).join(", ")}).`);
        }
      });
      if (col("net_pay") < 0) errors.push("The column \"net_pay\" is missing.");
    });
    return { run: errors.length ? null : run, errors: [...new Set(errors)] };
  },
};

export const genericJson: PayrollAdapter = {
  key: "generic_json",
  label: "Generic JSON (Gideon Books format)",
  fileTypes: ".json",
  parse(content) {
    const errors: string[] = [];
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(content) as Record<string, unknown>;
    } catch {
      return { run: null, errors: ["The file is not valid JSON."] };
    }
    const s = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
    const run: ParsedRun = {
      providerRunId: s(doc.run_id),
      payDate: s(doc.pay_date),
      periodStart: s(doc.period_start),
      periodEnd: s(doc.period_end),
      level: Array.isArray(doc.employees) ? "employee" : "summary",
      components: [],
    };
    checkHeader(run, errors);
    const amountOf = (v: unknown, where: string) => {
      if (typeof v === "number") {
        errors.push(`${where}: give amounts as strings ("1234.56"), not JSON numbers, so no precision is lost.`);
        return null;
      }
      const a = parseAmount(s(v));
      if (a === null) errors.push(`${where}: "${s(v)}" is not a number.`);
      return a;
    };
    const dimsOf = (o: Record<string, unknown>) => ({
      department: s(o.department) || null,
      class: s(o.class) || null,
      location: s(o.location) || null,
      project: s(o.project) || null,
    });
    if (Array.isArray(doc.employees)) {
      doc.employees.forEach((e: unknown, i: number) => {
        const emp = (e ?? {}) as Record<string, unknown>;
        const ref = s(emp.employee_id);
        const name = s(emp.name) || null;
        if (!ref) errors.push(`employees[${i}]: employee_id is missing.`);
        for (const [group, type] of Object.entries(JSON_GROUPS)) {
          const g = emp[group];
          if (g === undefined) continue;
          if (typeof g !== "object" || g === null || Array.isArray(g)) {
            errors.push(`employees[${i}].${group} must be an object of code → amount.`);
            continue;
          }
          for (const [code, v] of Object.entries(g as Record<string, unknown>)) {
            const c = code.toLowerCase();
            if (!CODE_RE.test(c)) errors.push(`employees[${i}].${group}.${code}: codes are lowercase letters, digits, dots, dashes or underscores.`);
            const a = amountOf(v, `employees[${i}].${group}.${code}`);
            if (a !== null && !Decimal.from(a).isZero()) run.components.push({ employeeRef: ref, employeeName: name, type, code: c, amount: a, ...dimsOf(emp) });
          }
        }
        if (emp.net_pay === undefined) errors.push(`employees[${i}]: net_pay is missing.`);
        else {
          const a = amountOf(emp.net_pay, `employees[${i}].net_pay`);
          if (a !== null) run.components.push({ employeeRef: ref, employeeName: name, type: "net_pay", code: "net_pay", amount: a, ...dimsOf(emp) });
        }
      });
    } else if (Array.isArray(doc.components)) {
      doc.components.forEach((c: unknown, i: number) => {
        const comp = (c ?? {}) as Record<string, unknown>;
        const type = s(comp.type) as PayrollComponentType;
        if (!PAYROLL_COMPONENT_TYPES.includes(type)) {
          errors.push(`components[${i}]: unknown type "${s(comp.type)}".`);
          return;
        }
        const code = (s(comp.code) || (type === "net_pay" ? "net_pay" : "")).toLowerCase();
        if (!CODE_RE.test(code)) errors.push(`components[${i}]: code "${code}" must be lowercase letters, digits, dots, dashes or underscores.`);
        const a = amountOf(comp.amount, `components[${i}].amount`);
        if (a !== null) run.components.push({ employeeRef: null, employeeName: null, type, code, amount: a, ...dimsOf(comp) });
      });
    } else {
      errors.push('Give either "employees" (one object per employee) or "components" (a summary).');
    }
    return { run: errors.length ? null : run, errors: [...new Set(errors)] };
  },
};

export const ADAPTERS: PayrollAdapter[] = [genericCsv, genericJson];

export function adapterFor(key: string): PayrollAdapter | null {
  return ADAPTERS.find((a) => a.key === key) ?? null;
}
