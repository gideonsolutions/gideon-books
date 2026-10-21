import Link from "next/link";
import { OPERATIONS, EXTRA_OPERATIONS } from "@/lib/api/openapi";
import { Badge } from "@/components/ui";

export const metadata = { title: "API" };

export default function ApiDocs() {
  const ops = [...OPERATIONS, ...EXTRA_OPERATIONS];
  const tags = [...new Set(ops.map((o) => o.tag))];
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-4xl px-4 py-10">
        <h1 className="text-2xl font-semibold text-slate-900">Gideon Books API</h1>
        <div className="mt-3 space-y-2 text-sm text-slate-700">
          <p>
            A REST API for one organization&apos;s books. Create a token under <strong>Settings → API tokens</strong> and send it as{" "}
            <code className="rounded bg-white px-1">Authorization: Bearer gbk_…</code>. Every request runs with the token&apos;s role (never more than its creator&apos;s) and is recorded in the audit log.
          </p>
          <p>Amounts are decimal strings (<code>&quot;1234.50&quot;</code>), dates are <code>YYYY-MM-DD</code>. Lists take <code>page</code> and <code>page_size</code> (≤ 500). Errors are <code>{"{ error: { code, message, fields? } }"}</code>.</p>
          <p>
            Endpoints that post send an <code>Idempotency-Key</code> header: a retry with the same key and body gets the first response, the same key with a different body is refused.
          </p>
          <p>
            Machine-readable:{" "}
            <Link href="/api/v1/openapi.json" className="text-brand-700 underline">
              /api/v1/openapi.json
            </Link>{" "}
            (OpenAPI 3.1).
          </p>
        </div>
        {tags.map((t) => (
          <section key={t} className="mt-8">
            <h2 className="mb-2 text-lg font-semibold text-slate-900">{t}</h2>
            <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
              {ops
                .filter((o) => o.tag === t)
                .map((o) => (
                  <li key={`${o.method} ${o.path}`} className="px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={o.method === "get" ? "blue" : "green"}>{o.method.toUpperCase()}</Badge>
                      <code className="font-mono text-slate-900">/api/v1{o.path}</code>
                      {o.idempotent && <Badge tone="amber">idempotent</Badge>}
                    </div>
                    <p className="mt-1 text-slate-700">{o.summary}</p>
                    <p className="text-xs text-slate-500">Permission: {o.permission}</p>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
