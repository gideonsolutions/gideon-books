import type { auditEvents } from "@/lib/db/schema/core";
import { Card } from "@/components/ui";
import { formatDateTime } from "@/lib/money/format";

type Event = typeof auditEvents.$inferSelect;

/** The history of one record, newest first. */
export function AuditTrail({ events, title = "History" }: { events: Event[]; title?: string }) {
  return (
    <Card title={title}>
      {events.length === 0 ? (
        <p className="text-sm text-slate-500">No recorded changes.</p>
      ) : (
        <ol className="space-y-3">
          {events.map((e) => (
            <li key={e.id} className="text-sm">
              <div className="font-medium text-slate-800">{e.action.replace(/[._]/g, " ")}</div>
              <div className="text-xs text-slate-500">
                {formatDateTime(e.createdAt)} · {e.actorLabel} · {e.source}
              </div>
              {e.reason && <div className="mt-0.5 text-xs text-slate-700">“{e.reason}”</div>}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
