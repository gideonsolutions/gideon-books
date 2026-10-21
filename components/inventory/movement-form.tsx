"use client";

/**
 * Form for opening stock, quantity adjustments, transfers and revaluations:
 * a date, a reason, the location(s), and one line per item.
 */
import { useState } from "react";
import { ActionForm, SelectField, SubmitButton, TextField, type Option } from "@/components/client/forms";
import { buttonClass, cx, inputClass } from "@/components/ui";
import type { ActionResult } from "@/lib/web/actions";

export type MovementKindUi = "opening" | "adjustment" | "transfer" | "revaluation";

interface Line {
  itemId: string;
  quantity: string;
  unitCost: string;
  valueChange: string;
}

const blank = (itemId = ""): Line => ({ itemId, quantity: "", unitCost: "", valueChange: "" });

export function MovementForm({
  action,
  kind,
  items,
  locations,
  offsetAccounts,
  defaultDate,
  defaultItemId,
  defaultLocationId,
  baseCurrency,
}: {
  action: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  kind: MovementKindUi;
  items: (Option & { unit: string; onHand: string; avgCost: string | null })[];
  locations: Option[];
  offsetAccounts: Option[];
  defaultDate: string;
  defaultItemId?: string;
  defaultLocationId?: string;
  baseCurrency: string;
}) {
  const [lines, setLines] = useState<Line[]>([blank(defaultItemId ?? "")]);
  const set = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...p } : l)));
  const itemMap = new Map(items.map((i) => [i.value, i]));
  return (
    <ActionForm action={action} className="space-y-5">
      <input type="hidden" name="lineCount" value={lines.length} />
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField label="Date" name="date" type="date" required defaultValue={defaultDate} />
        <SelectField label={kind === "transfer" ? "From location" : "Location"} name="locationId" required options={locations} defaultValue={defaultLocationId ?? locations[0]?.value} />
        {kind === "transfer" && <SelectField label="To location" name="toLocationId" required placeholder="Choose…" options={locations} />}
        <TextField
          label="Reason"
          name="reason"
          required
          className={kind === "transfer" ? "sm:col-span-3" : "sm:col-span-1"}
          placeholder={kind === "opening" ? "Opening count at books start" : kind === "transfer" ? "Restock the van" : kind === "revaluation" ? "Damaged packaging; written down" : "Year-end count"}
        />
        {kind !== "transfer" && (
          <SelectField
            label={kind === "opening" ? "Balancing account" : "Book the value change to"}
            name="offsetAccountId"
            placeholder={kind === "opening" ? "Opening Balance Equity" : "Inventory Shrinkage and Adjustments"}
            options={offsetAccounts}
            className="sm:col-span-3"
          />
        )}
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
            <tr>
              <th className="px-2 py-2 text-left">Item</th>
              <th className="px-2 py-2 text-right">On hand</th>
              {kind !== "revaluation" && <th className="px-2 py-2 text-right">{kind === "adjustment" ? "Change (+ found, − lost)" : "Quantity"}</th>}
              {(kind === "opening" || kind === "adjustment") && <th className="px-2 py-2 text-right">Cost per unit ({baseCurrency})</th>}
              {kind === "revaluation" && <th className="px-2 py-2 text-right">Change in value ({baseCurrency}, + up / − down)</th>}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {lines.map((l, i) => {
              const it = itemMap.get(l.itemId);
              return (
                <tr key={i}>
                  <td className="px-2 py-1.5">
                    <select name={`lines.${i}.itemId`} value={l.itemId} onChange={(e) => set(i, { itemId: e.target.value })} className={cx(inputClass, "min-w-56")} aria-label={`Line ${i + 1} item`}>
                      <option value="">Choose a stock item…</option>
                      {items.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num px-2 py-1.5 text-right text-slate-600">{it ? `${it.onHand} ${it.unit}` : "—"}</td>
                  {kind !== "revaluation" && (
                    <td className="px-2 py-1.5">
                      <input name={`lines.${i}.quantity`} value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} inputMode="decimal" className={cx(inputClass, "num ml-auto w-32 text-right")} aria-label={`Line ${i + 1} quantity`} />
                    </td>
                  )}
                  {(kind === "opening" || kind === "adjustment") && (
                    <td className="px-2 py-1.5">
                      <input
                        name={`lines.${i}.unitCost`}
                        value={l.unitCost}
                        onChange={(e) => set(i, { unitCost: e.target.value })}
                        inputMode="decimal"
                        placeholder={kind === "adjustment" ? (it?.avgCost ? `avg ${it.avgCost}` : "required") : ""}
                        className={cx(inputClass, "num ml-auto w-32 text-right")}
                        aria-label={`Line ${i + 1} cost per unit`}
                      />
                    </td>
                  )}
                  {kind === "revaluation" && (
                    <td className="px-2 py-1.5">
                      <input name={`lines.${i}.valueChange`} value={l.valueChange} onChange={(e) => set(i, { valueChange: e.target.value })} inputMode="decimal" className={cx(inputClass, "num ml-auto w-36 text-right")} aria-label={`Line ${i + 1} change in value`} />
                    </td>
                  )}
                  <td className="px-1 text-center">
                    <button type="button" disabled={lines.length <= 1} onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))} className="rounded p-1 text-slate-400 hover:text-danger-600 disabled:opacity-30" aria-label={`Remove line ${i + 1}`}>
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="border-t border-slate-100 bg-slate-50 px-2 py-2">
          <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setLines((ls) => [...ls, blank()])}>
            + Add item
          </button>
        </div>
      </div>
      <p className="text-xs text-slate-500">
        {kind === "adjustment"
          ? "Stock lost is taken out at average cost; stock found comes in at the cost you enter, or the current average if blank. "
          : kind === "transfer"
            ? "Transfers move quantity between locations; the value stays with the item and nothing posts to the ledger. "
            : kind === "revaluation"
              ? "Changes what the stock on hand is carried at without changing quantity. "
              : "Opening stock comes in at the cost you enter, balanced against opening balance equity. "}
        Movements are recorded in date order: one dated before an item&apos;s latest movement is refused, and stock can never go below zero.
      </p>
      <div className="flex justify-end">
        <SubmitButton pendingText="Recording…">Record</SubmitButton>
      </div>
    </ActionForm>
  );
}
