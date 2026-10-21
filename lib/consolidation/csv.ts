/** CSV rendering of a consolidation (the same rows the page shows). */
import type { ConsolidationReport } from "./report";
import { statementRows } from "./report";

function cell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function consolidationCsv(r: ConsolidationReport, view: "trial_balance" | "balance_sheet" | "profit_and_loss"): string {
  const head = ["Code", "Group account", "Type", ...r.members.map((m) => `${m.name} (${r.reportingCurrency})`), "Eliminations", "Consolidated"];
  const lines = [head.map(cell).join(",")];
  for (const row of statementRows(r, view)) {
    lines.push(
      [row.groupAccount.code, row.groupAccount.name, row.groupAccount.type, ...r.members.map((m) => row.perMember[m.orgId] ?? "0"), row.eliminations, row.total].map((v) => cell(String(v))).join(","),
    );
  }
  lines.push("");
  lines.push(cell(`Consolidated ${view.replace(/_/g, " ")} for ${r.from} to ${r.to}, in ${r.reportingCurrency}. Signed amounts: debits positive, credits negative.`));
  for (const m of r.members) {
    lines.push(cell(`${m.name}: ${m.currency}; closing rate ${m.closing?.rate.toString() ?? "none"} (${m.closing?.source ?? ""} ${m.closing?.date ?? ""}); average rate ${m.average?.rate.toString() ?? "none"} (${m.average?.source ?? ""}); translation adjustment ${m.cta}`));
  }
  for (const w of r.warnings) lines.push(cell(`Warning: ${w}`));
  return lines.join("\n") + "\n";
}
