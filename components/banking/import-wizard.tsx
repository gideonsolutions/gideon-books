"use client";

/**
 * Importing a bank statement: choose the account and the file, map its
 * columns (or reuse a saved mapping), preview every row with its problems
 * and duplicates, then import. Nothing is saved until the last step.
 */
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Options, type Option } from "@/components/client/forms";
import { Alert, Badge, buttonClass, cx, inputClass } from "@/components/ui";
import { guessMapping, parseCsv, detectDelimiter } from "@/lib/banking/csv";
import type { CsvMappingConfig } from "@/lib/db/schema/banking";
import type { ImportPreview } from "@/lib/banking/imports";
import { formatDate, formatMoney } from "@/lib/money/format";
import type { ActionResult } from "@/lib/web/actions";

const DATE_FORMATS: CsvMappingConfig["dateFormat"][] = ["YYYY-MM-DD", "MM/DD/YYYY", "M/D/YY", "DD/MM/YYYY", "DD.MM.YYYY", "YYYY/MM/DD"];

export interface SavedMapping {
  id: string;
  name: string;
  accountId: string | null;
  config: CsvMappingConfig;
  headerSignature: string | null;
}

export function ImportWizard({
  accounts,
  mappings,
  defaultAccountId,
  preview,
  commit,
}: {
  accounts: Option[];
  mappings: SavedMapping[];
  defaultAccountId?: string;
  preview: (input: { accountId: string; text: string; mapping: CsvMappingConfig }) => Promise<ActionResult<ImportPreview>>;
  commit: (input: { accountId: string; fileName: string; text: string; mapping: CsvMappingConfig; mappingId?: string | null; includeDuplicateRows?: number[]; saveMappingAs?: string | null }) => Promise<ActionResult<{ href: string }>>;
}) {
  const router = useRouter();
  const [accountId, setAccountId] = useState(defaultAccountId ?? "");
  const [fileName, setFileName] = useState("");
  const [text, setText] = useState("");
  const [mapping, setMapping] = useState<CsvMappingConfig | null>(null);
  const [mappingId, setMappingId] = useState<string>("");
  const [result, setResult] = useState<ImportPreview | null>(null);
  const [include, setInclude] = useState<Set<number>>(new Set());
  const [saveAs, setSaveAs] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();

  const rows = useMemo(() => (text && mapping ? parseCsv(text, mapping.delimiter) : []), [text, mapping]);
  const sample = rows.slice(mapping?.skipRows ?? 0, (mapping?.skipRows ?? 0) + 6);
  const width = Math.max(0, ...sample.map((r) => r.length));
  const headerCells = mapping?.hasHeader ? (sample[0] ?? []) : [];
  const columns: Option[] = Array.from({ length: width }, (_, i) => ({ value: String(i), label: `${i + 1}: ${headerCells[i]?.trim() || sample[mapping?.hasHeader ? 1 : 0]?.[i]?.slice(0, 20) || "(empty)"}` }));

  const loadFile = async (file: File) => {
    setError(null);
    setResult(null);
    let t = await file.text();
    if (t.includes("�")) {
      // Not UTF-8: many bank exports are Windows-1252.
      t = new TextDecoder("windows-1252").decode(await file.arrayBuffer());
    }
    setFileName(file.name);
    setText(t);
    const parsed = parseCsv(t);
    const header = (parsed[0] ?? []).map((h) => h.trim()).join("|");
    const saved = mappings.find((m) => m.headerSignature && m.headerSignature === header && (!m.accountId || m.accountId === accountId)) ?? mappings.find((m) => m.headerSignature === header);
    if (saved) {
      setMapping(saved.config);
      setMappingId(saved.id);
    } else {
      setMapping(guessMapping(parsed, detectDelimiter(t)));
      setMappingId("");
    }
  };

  const set = (patch: Partial<CsvMappingConfig>) => {
    setResult(null);
    setMapping((m) => (m ? { ...m, ...patch } : m));
  };
  const col = (v: number | null) => (v === null ? "" : String(v));
  const num = (v: string) => (v === "" ? null : Number(v));

  const runPreview = () =>
    start(async () => {
      if (!mapping) return;
      setError(null);
      const r = await preview({ accountId, text, mapping });
      if (!r.ok) {
        setError(r.error);
        setFields(r.fields ?? {});
        return;
      }
      setFields({});
      setResult(r.data!);
      setInclude(new Set());
    });

  const runCommit = () =>
    start(async () => {
      if (!mapping) return;
      const r = await commit({ accountId, fileName, text, mapping, mappingId: mappingId || null, includeDuplicateRows: [...include], saveMappingAs: saveAs.trim() || null });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.push(r.data!.href);
    });

  return (
    <div className="space-y-6">
      {error && (
        <Alert tone="danger">
          {error}
          {Object.keys(fields).length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {Object.entries(fields).map(([k, v]) => (
                <li key={k}>{v}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}
      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-slate-900">1. Account and file</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium text-slate-800">
            Account
            <select value={accountId} onChange={(e) => { setAccountId(e.target.value); setResult(null); }} className={cx(inputClass, "mt-1")} required>
              <option value="">Choose…</option>
              <Options options={accounts} />
            </select>
          </label>
          <label className="text-sm font-medium text-slate-800">
            Statement file (CSV)
            <input type="file" accept=".csv,.txt,text/csv" onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} className={cx(inputClass, "mt-1")} />
          </label>
        </div>
        {fileName && <p className="mt-2 text-xs text-slate-500">{fileName}: {parseCsv(text).length} lines read.</p>}
      </section>

      {mapping && (
        <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900">2. Columns</h2>
            {mappings.length > 0 && (
              <label className="text-xs text-slate-600">
                Saved mapping{" "}
                <select
                  value={mappingId}
                  onChange={(e) => {
                    const m = mappings.find((x) => x.id === e.target.value);
                    setMappingId(e.target.value);
                    if (m) set(m.config);
                  }}
                  className={cx(inputClass, "inline-block w-auto")}
                >
                  <option value="">None</option>
                  {mappings.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="mb-4 overflow-x-auto rounded border border-slate-200">
            <table className="min-w-full text-xs">
              <tbody className="divide-y divide-slate-100">
                {sample.map((r, i) => (
                  <tr key={i} className={i === 0 && mapping.hasHeader ? "bg-slate-50 font-semibold" : ""}>
                    {Array.from({ length: width }, (_, c) => (
                      <td key={c} className="max-w-48 truncate whitespace-nowrap px-2 py-1">
                        <span className="mr-1 text-slate-400">{i === 0 ? `${c + 1}:` : ""}</span>
                        {r[c] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Labeled label="Delimiter">
              <select value={mapping.delimiter ?? ""} onChange={(e) => set({ delimiter: e.target.value || null })} className={inputClass}>
                <option value="">Detect</option>
                <option value=",">Comma</option>
                <option value=";">Semicolon</option>
                <option value={"\t"}>Tab</option>
                <option value="|">Pipe</option>
              </select>
            </Labeled>
            <Labeled label="Rows to skip at the top">
              <input type="number" min={0} max={100} value={mapping.skipRows} onChange={(e) => set({ skipRows: Math.max(0, Number(e.target.value) || 0) })} className={inputClass} />
            </Labeled>
            <label className="flex items-center gap-2 pt-6 text-sm text-slate-700">
              <input type="checkbox" checked={mapping.hasHeader} onChange={(e) => set({ hasHeader: e.target.checked })} /> First row is a header
            </label>
            <label className="flex items-center gap-2 pt-6 text-sm text-slate-700">
              <input type="checkbox" checked={mapping.decimalComma} onChange={(e) => set({ decimalComma: e.target.checked })} /> Amounts use a decimal comma (1.234,56)
            </label>
            <Labeled label="Date column" error={fields.dateColumn}>
              <select value={col(mapping.dateColumn)} onChange={(e) => set({ dateColumn: Number(e.target.value) })} className={inputClass}>
                <Options options={columns} />
              </select>
            </Labeled>
            <Labeled label="Date format">
              <select value={mapping.dateFormat} onChange={(e) => set({ dateFormat: e.target.value as CsvMappingConfig["dateFormat"] })} className={inputClass}>
                {DATE_FORMATS.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </Labeled>
            <Labeled label="Description column" error={fields.descriptionColumn}>
              <select value={col(mapping.descriptionColumn)} onChange={(e) => set({ descriptionColumn: Number(e.target.value) })} className={inputClass}>
                <Options options={columns} />
              </select>
            </Labeled>
            <Labeled label="Amounts are in">
              <select value={mapping.amountMode} onChange={(e) => set({ amountMode: e.target.value as CsvMappingConfig["amountMode"] })} className={inputClass}>
                <option value="single">One signed column</option>
                <option value="debit_credit">Separate debit and credit columns</option>
              </select>
            </Labeled>
            {mapping.amountMode === "single" ? (
              <Labeled label="Amount column" error={fields.amountColumn}>
                <select value={col(mapping.amountColumn)} onChange={(e) => set({ amountColumn: num(e.target.value) })} className={inputClass}>
                  <option value="">Choose…</option>
                  <Options options={columns} />
                </select>
              </Labeled>
            ) : (
              <>
                <Labeled label="Debit (money out) column" error={fields.debitColumn}>
                  <select value={col(mapping.debitColumn)} onChange={(e) => set({ debitColumn: num(e.target.value) })} className={inputClass}>
                    <option value="">Choose…</option>
                    <Options options={columns} />
                  </select>
                </Labeled>
                <Labeled label="Credit (money in) column" error={fields.creditColumn}>
                  <select value={col(mapping.creditColumn)} onChange={(e) => set({ creditColumn: num(e.target.value) })} className={inputClass}>
                    <option value="">Choose…</option>
                    <Options options={columns} />
                  </select>
                </Labeled>
              </>
            )}
            <label className="flex items-center gap-2 pt-6 text-sm text-slate-700">
              <input type="checkbox" checked={mapping.invertSign} onChange={(e) => set({ invertSign: e.target.checked })} /> Flip signs (charges shown as positive)
            </label>
            <Labeled label="Payee column">
              <select value={col(mapping.payeeColumn)} onChange={(e) => set({ payeeColumn: num(e.target.value) })} className={inputClass}>
                <option value="">None</option>
                <Options options={columns} />
              </select>
            </Labeled>
            <Labeled label="Reference / check no. column">
              <select value={col(mapping.referenceColumn)} onChange={(e) => set({ referenceColumn: num(e.target.value) })} className={inputClass}>
                <option value="">None</option>
                <Options options={columns} />
              </select>
            </Labeled>
            <Labeled label="Balance column">
              <select value={col(mapping.balanceColumn)} onChange={(e) => set({ balanceColumn: num(e.target.value) })} className={inputClass}>
                <option value="">None</option>
                <Options options={columns} />
              </select>
            </Labeled>
          </div>
          <div className="mt-4 flex justify-end">
            <button type="button" className={buttonClass("primary")} onClick={runPreview} disabled={!accountId || pending}>
              {pending && !result ? "Checking…" : "Preview"}
            </button>
          </div>
        </section>
      )}

      {result && (
        <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">3. Preview</h2>
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            <Badge tone="green">{result.counts.new} new</Badge>
            <Badge tone="amber">{result.counts.duplicates} already imported</Badge>
            <Badge tone="red">{result.counts.errors} with problems</Badge>
            <span className="text-slate-600">
              In {formatMoney(result.totalIn, result.currency)} · Out {formatMoney(result.totalOut, result.currency)} (new rows)
            </span>
          </div>
          <div className="max-h-[28rem] overflow-auto rounded border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-600">
                <tr>
                  <th className="px-2 py-1.5 text-left">Row</th>
                  <th className="px-2 py-1.5 text-left">Date</th>
                  <th className="px-2 py-1.5 text-left">Description</th>
                  <th className="px-2 py-1.5 text-right">Amount</th>
                  <th className="px-2 py-1.5 text-left">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {result.rows.map((r) => (
                  <tr key={r.rowNumber} className={r.errors.length ? "bg-danger-50/40" : r.duplicate ? "bg-amber-50/50" : ""}>
                    <td className="px-2 py-1 text-xs text-slate-500">{r.rowNumber}</td>
                    <td className="whitespace-nowrap px-2 py-1">{r.date ? formatDate(r.date) : <span className="text-danger-700">—</span>}</td>
                    <td className="px-2 py-1">{r.description}</td>
                    <td className="num px-2 py-1 text-right">{r.amount ? formatMoney(r.amount, result.currency) : "—"}</td>
                    <td className="px-2 py-1 text-xs">
                      {r.errors.length ? (
                        <span className="text-danger-700">{r.errors.join(" ")}</span>
                      ) : r.duplicate ? (
                        <label className="flex items-center gap-1 text-amber-800">
                          <input
                            type="checkbox"
                            checked={include.has(r.rowNumber)}
                            onChange={() =>
                              setInclude((s) => {
                                const n = new Set(s);
                                if (n.has(r.rowNumber)) n.delete(r.rowNumber);
                                else n.add(r.rowNumber);
                                return n;
                              })
                            }
                          />
                          Already imported — import anyway
                        </label>
                      ) : (
                        <span className="text-emerald-700">New</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.counts.total > result.rows.length && <p className="mt-2 text-xs text-slate-500">Showing the first {result.rows.length} of {result.counts.total} rows; all are checked and imported.</p>}
          <div className="mt-4 flex flex-wrap items-end justify-end gap-3">
            <label className="text-sm text-slate-700">
              Save this mapping as{" "}
              <input value={saveAs} onChange={(e) => setSaveAs(e.target.value)} placeholder="e.g. First Bank checking export" className={cx(inputClass, "inline-block w-64")} />
            </label>
            <button type="button" className={buttonClass("primary")} onClick={runCommit} disabled={pending || result.counts.new + include.size === 0}>
              {pending ? "Importing…" : `Import ${result.counts.new + include.size} transaction${result.counts.new + include.size === 1 ? "" : "s"}`}
            </button>
          </div>
          <p className="mt-2 text-right text-xs text-slate-500">Every row, including skipped ones, is kept with the import for its record. Nothing is posted to the books by importing.</p>
        </section>
      )}
    </div>
  );
}

function Labeled({ label, children, error }: { label: string; children: React.ReactNode; error?: string }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
      {label}
      {children}
      {error && <span className="text-danger-700">{error}</span>}
    </label>
  );
}
