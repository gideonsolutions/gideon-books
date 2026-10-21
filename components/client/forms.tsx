"use client";

/**
 * Forms that post to server actions: pending state, the server's message,
 * per-field errors announced to assistive tech, and focus moved to the
 * first field with an error.
 */
import { createContext, useActionState, useContext, useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/lib/web/actions";
import { buttonClass, cx, inputClass } from "@/components/ui";

type FormAction = (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;

const FieldErrorsContext = createContext<Record<string, string>>({});

export function useFieldError(name: string): string | undefined {
  return useContext(FieldErrorsContext)[name];
}

export function ActionForm({
  action,
  children,
  className,
  onSuccess,
  successRedirect,
  resetOnSuccess,
  id,
}: {
  action: FormAction;
  children: ReactNode;
  className?: string;
  onSuccess?: (r: ActionResult<unknown>) => void;
  /** Navigate here after success (or to `data.href` if the action returns one). */
  successRedirect?: string;
  resetOnSuccess?: boolean;
  id?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const fields = state && !state.ok ? (state.fields ?? {}) : {};

  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      onSuccess?.(state);
      const href = (state.data as { href?: string } | undefined)?.href ?? successRedirect;
      if (href) router.push(href);
      else router.refresh();
      if (resetOnSuccess) ref.current?.reset();
    } else if (state.fields) {
      const first = Object.keys(state.fields)[0];
      const el = first ? (ref.current?.querySelector(`[name="${CSS.escape(first)}"]`) as HTMLElement | null) : null;
      el?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <FieldErrorsContext.Provider value={fields}>
      <form ref={ref} action={formAction} className={className} id={id} noValidate>
        {state && !state.ok && (
          <div role="alert" className="mb-4 rounded-md border border-danger-100 bg-danger-50 px-4 py-3 text-sm text-danger-700">
            {state.error}
            {state.fields && Object.keys(state.fields).length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {Object.entries(state.fields)
                  .slice(0, 8)
                  .map(([k, v]) => (
                    <li key={k}>{v}</li>
                  ))}
              </ul>
            )}
          </div>
        )}
        {state?.ok && state.message && (
          <div role="status" className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            {state.message}
          </div>
        )}
        {children}
      </form>
    </FieldErrorsContext.Provider>
  );
}

export function SubmitButton({ children, variant = "primary", pendingText, className, ...rest }: ComponentProps<"button"> & { variant?: "primary" | "secondary" | "danger"; pendingText?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending || rest.disabled} aria-busy={pending} className={buttonClass(variant, "md", className)} {...rest}>
      {pending && <Spinner />}
      {pending ? (pendingText ?? "Saving…") : children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("h-4 w-4 animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Field({ label, name, hint, children, required, className }: { label: string; name: string; hint?: ReactNode; children: (p: { id: string; name: string; "aria-invalid": boolean; "aria-describedby"?: string }) => ReactNode; required?: boolean; className?: string }) {
  const id = useId();
  const error = useFieldError(name);
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-err` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("flex flex-col gap-1", className)}>
      <label htmlFor={id} className="text-sm font-medium text-slate-800">
        {label}
        {required && <span className="ml-0.5 text-danger-600" aria-hidden="true">*</span>}
      </label>
      {children({ id, name, "aria-invalid": !!error, ...(describedBy ? { "aria-describedby": describedBy } : {}) })}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-slate-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} className="text-xs text-danger-700">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextField({ label, name, hint, required, className, ...input }: { label: string; name: string; hint?: ReactNode; required?: boolean; className?: string } & Omit<ComponentProps<"input">, "name">) {
  return (
    <Field label={label} name={name} hint={hint} required={required} className={className}>
      {(p) => <input {...p} {...input} required={required} className={cx(inputClass, input.type === "number" || input.inputMode === "decimal" ? "num text-right" : "")} />}
    </Field>
  );
}

export function TextAreaField({ label, name, hint, required, className, ...input }: { label: string; name: string; hint?: ReactNode; required?: boolean; className?: string } & Omit<ComponentProps<"textarea">, "name">) {
  return (
    <Field label={label} name={name} hint={hint} required={required} className={className}>
      {(p) => <textarea rows={3} {...p} {...input} required={required} className={inputClass} />}
    </Field>
  );
}

export interface Option {
  value: string;
  label: string;
  group?: string;
  disabled?: boolean;
}

export function SelectField({ label, name, hint, required, options, placeholder, className, ...select }: { label: string; name: string; hint?: ReactNode; required?: boolean; options: Option[]; placeholder?: string; className?: string } & Omit<ComponentProps<"select">, "name">) {
  return (
    <Field label={label} name={name} hint={hint} required={required} className={className}>
      {(p) => (
        <select {...p} {...select} required={required} className={inputClass}>
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          <Options options={options} />
        </select>
      )}
    </Field>
  );
}

export function Options({ options }: { options: Option[] }) {
  const groups = new Map<string, Option[]>();
  const loose: Option[] = [];
  for (const o of options) {
    if (o.group) groups.set(o.group, [...(groups.get(o.group) ?? []), o]);
    else loose.push(o);
  }
  return (
    <>
      {loose.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
      {[...groups.entries()].map(([g, opts]) => (
        <optgroup key={g} label={g}>
          {opts.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

export function CheckboxField({ label, name, hint, defaultChecked, disabled }: { label: ReactNode; name: string; hint?: ReactNode; defaultChecked?: boolean; disabled?: boolean }) {
  const id = useId();
  const error = useFieldError(name);
  return (
    <div className="flex items-start gap-2">
      <input id={id} type="checkbox" name={name} defaultChecked={defaultChecked} disabled={disabled} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600" />
      <div>
        <label htmlFor={id} className="text-sm text-slate-800">
          {label}
        </label>
        {hint && <p className="text-xs text-slate-500">{hint}</p>}
        {error && <p className="text-xs text-danger-700">{error}</p>}
      </div>
    </div>
  );
}

/**
 * A button that asks before doing something consequential. With
 * `reasonLabel`, the person must say why (sent as `reason`).
 */
export function ConfirmButton({
  action,
  label,
  title,
  body,
  confirmLabel = "Confirm",
  variant = "secondary",
  reasonLabel,
  dateLabel,
  defaultDate,
  hidden,
  size = "md",
  successRedirect,
}: {
  action: FormAction;
  label: ReactNode;
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  reasonLabel?: string;
  dateLabel?: string;
  defaultDate?: string;
  hidden?: Record<string, string>;
  size?: "sm" | "md";
  successRedirect?: string;
}) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  return (
    <>
      <button type="button" className={buttonClass(variant, size)} onClick={() => setOpen(true)}>
        {label}
      </button>
      <dialog ref={dialog} onClose={() => setOpen(false)} className="w-[min(32rem,calc(100vw-2rem))] rounded-lg p-0 shadow-xl backdrop:bg-slate-900/40" aria-labelledby="confirm-title">
        {open && (
          <ActionForm action={action} onSuccess={() => setOpen(false)} successRedirect={successRedirect} className="p-5">
            <h2 id="confirm-title" className="text-lg font-semibold text-slate-900">
              {title}
            </h2>
            {body && <div className="mt-2 text-sm text-slate-600">{body}</div>}
            {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
            <div className="mt-4 space-y-3">
              {dateLabel && <TextField label={dateLabel} name="date" type="date" defaultValue={defaultDate} required />}
              {reasonLabel && <TextAreaField label={reasonLabel} name="reason" required rows={2} />}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className={buttonClass("secondary")} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <SubmitButton variant={variant === "danger" ? "danger" : "primary"} pendingText="Working…">
                {confirmLabel}
              </SubmitButton>
            </div>
          </ActionForm>
        )}
      </dialog>
    </>
  );
}

/** A one-click action button (no confirmation) posting to a server action. */
export function ActionButton({ action, children, variant = "secondary", size = "md", hidden, successRedirect }: { action: FormAction; children: ReactNode; variant?: "primary" | "secondary" | "danger" | "ghost"; size?: "sm" | "md"; hidden?: Record<string, string>; successRedirect?: string }) {
  return (
    <ActionForm action={action} className="inline" successRedirect={successRedirect}>
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <InlineSubmit variant={variant} size={size}>
        {children}
      </InlineSubmit>
    </ActionForm>
  );
}

function InlineSubmit({ children, variant, size }: { children: ReactNode; variant: "primary" | "secondary" | "danger" | "ghost"; size: "sm" | "md" }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={buttonClass(variant, size)} aria-busy={pending}>
      {pending && <Spinner />}
      {children}
    </button>
  );
}
