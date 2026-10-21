"use client";

import { useEffect, useRef, useState } from "react";
import { ActionForm, SelectField, SubmitButton, TextAreaField, TextField, type Option } from "@/components/client/forms";
import { buttonClass } from "@/components/ui";
import type { ActionResult } from "@/lib/web/actions";

/** Dispose of (sell or write off) an asset: date, proceeds and where they went, and why. */
export function DisposeButton({
  action,
  accounts,
  defaultDate,
  nbv,
}: {
  action: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  accounts: Option[];
  defaultDate: string;
  nbv: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) ref.current?.showModal();
    else ref.current?.close();
  }, [open]);
  return (
    <>
      <button type="button" className={buttonClass("danger")} onClick={() => setOpen(true)}>
        Dispose of asset
      </button>
      <dialog ref={ref} onClose={() => setOpen(false)} className="w-[min(34rem,calc(100vw-2rem))] rounded-lg p-0 shadow-xl backdrop:bg-slate-900/40" aria-labelledby="dispose-title">
        {open && (
          <ActionForm action={action} onSuccess={() => setOpen(false)} className="space-y-4 p-5">
            <h2 id="dispose-title" className="text-lg font-semibold text-slate-900">
              Dispose of this asset
            </h2>
            <p className="text-sm text-slate-600">
              Its cost and accumulated depreciation come off the books; the difference between the proceeds and the net book value (currently {nbv}) is a gain or loss. No
              depreciation is taken in the month of disposal, and the months before it must be posted first.
            </p>
            <TextField label="Disposal date" name="date" type="date" required defaultValue={defaultDate} />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Proceeds" name="proceeds" inputMode="decimal" placeholder="0.00" hint="Leave blank for a write-off." />
              <SelectField label="Proceeds went to" name="proceedsAccountId" placeholder="—" options={accounts} />
            </div>
            <TextAreaField label="What happened (sold, scrapped, stolen…)" name="reason" required rows={2} />
            <div className="flex justify-end gap-2">
              <button type="button" className={buttonClass("secondary")} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <SubmitButton variant="danger" pendingText="Posting…">
                Post disposal
              </SubmitButton>
            </div>
          </ActionForm>
        )}
      </dialog>
    </>
  );
}
