import Link from "next/link";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { listTimeEntries, weeklyTimesheet, weekStart } from "@/lib/projects/time";
import { timePeople } from "@/lib/projects/people";
import { projects } from "@/lib/db/schema/ledger";
import { addDays, todayIn } from "@/lib/dates";
import { formatDate } from "@/lib/money/format";
import { Decimal } from "@/lib/money/decimal";
import { intParam, readParams, type SearchParams } from "@/lib/web/params";
import { Badge, Card, DateText, EmptyState, FilterBar, FilterField, PageHeader, Pagination, Table, Td, Th, buttonClass, inputClass } from "@/components/ui";
import { ConfirmButton, Options } from "@/components/client/forms";
import { TimeForm } from "@/components/projects/time-form";
import { createTimeAction, deleteTimeAction } from "../actions";

export const metadata = { title: "Time" };

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default async function Time({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const db = getDb();
  const today = todayIn(ctx.org.timezone);
  const week = weekStart(sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? sp.week : today);
  const me = ctx.actor.userId ? `user:${ctx.actor.userId}` : "";
  const personParam = sp.person ?? "";
  const personId = personParam.split(":")[1];
  const sheet = await weeklyTimesheet(db, ctx.orgId, week, personId);
  const page = intParam(sp.page, 1);
  const valid = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined);
  const state = sp.state === "unbilled" || sp.state === "billed" || sp.state === "non_billable" ? sp.state : undefined;
  const list = await listTimeEntries(db, ctx.orgId, { projectId: sp.project || undefined, person: personId, from: valid(sp.from), to: valid(sp.to), state, page, pageSize: 50 });
  const activeProjects = await db
    .select({ id: projects.id, name: projects.name, status: projects.status })
    .from(projects)
    .where(and(eq(projects.orgId, ctx.orgId), inArray(projects.status, ["active", "on_hold"])))
    .orderBy(asc(projects.name));
  const allProjects = await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.orgId, ctx.orgId)).orderBy(asc(projects.name));
  const people = await timePeople(db, ctx.orgId);
  const base = `/o/${org}`;
  const may = can(ctx, "time.record");
  const qs = (patch: Record<string, string | undefined>) => {
    const q = new URLSearchParams(Object.entries({ ...sp, ...patch }).filter(([, v]) => v) as [string, string][]);
    return `?${q.toString()}`;
  };
  return (
    <>
      <PageHeader title="Time" back={{ href: `${base}/projects`, label: "Projects" }} description="Hours worked on projects, billable or not. Billable time is billed from the project's page." />
      {may && activeProjects.length > 0 && (
        <Card title="Record time" className="mb-6">
          <TimeForm
            action={createTimeAction.bind(null, org)}
            projects={activeProjects.map((p) => ({ value: p.id, label: p.name }))}
            people={people}
            defaults={{ projectId: sp.project ?? "", workDate: today, person: personParam || me, hours: "", rate: "", billable: true, description: "" }}
          />
        </Card>
      )}
      {activeProjects.length === 0 && (
        <div className="mb-6">
          <EmptyState title="No active projects">Create a project first; time is recorded against a project.</EmptyState>
        </div>
      )}
      <Card
        title={`Week of ${formatDate(sheet.start)}`}
        className="mb-6"
        actions={
          <div className="flex gap-2">
            <Link className={buttonClass("secondary", "sm")} href={qs({ week: addDays(sheet.start, -7) })}>
              ← Previous
            </Link>
            <Link className={buttonClass("secondary", "sm")} href={qs({ week: undefined })}>
              This week
            </Link>
            <Link className={buttonClass("secondary", "sm")} href={qs({ week: addDays(sheet.start, 7) })}>
              Next →
            </Link>
          </div>
        }
        padded={false}
      >
        {sheet.lines.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">No time this week{personParam ? " for this person" : ""}.</p>
        ) : (
          <Table className="rounded-none border-0 shadow-none">
            <thead>
              <tr>
                <Th>Project</Th>
                {sheet.days.map((d, i) => (
                  <Th key={d} align="right">
                    {DAYS[i]} {Number(d.slice(8))}
                  </Th>
                ))}
                <Th align="right">Total</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sheet.lines.map((l) => (
                <tr key={l.projectId}>
                  <Td>
                    <Link className="text-brand-700 hover:underline" href={`${base}/projects/${l.projectId}`}>
                      {l.projectName}
                    </Link>
                  </Td>
                  {l.days.map((h, i) => (
                    <Td key={i} align="right" className="num">
                      {h.isZero() ? <span className="text-slate-300">—</span> : h.normalize().toString()}
                    </Td>
                  ))}
                  <Td align="right" className="num font-medium">{l.total.normalize().toString()}</Td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-50 font-medium">
              <tr>
                <Td>Total</Td>
                {sheet.dayTotals.map((h, i) => (
                  <Td key={i} align="right" className="num">{h.normalize().toString()}</Td>
                ))}
                <Td align="right" className="num">{sheet.total.normalize().toString()}</Td>
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>
      <FilterBar>
        <FilterField label="Project">
          <select name="project" defaultValue={sp.project ?? ""} className={inputClass}>
            <option value="">All</option>
            {allProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Who">
          <select name="person" defaultValue={personParam} className={inputClass}>
            <option value="">Everyone</option>
            <Options options={people} />
          </select>
        </FilterField>
        <FilterField label="From">
          <input type="date" name="from" defaultValue={sp.from} className={inputClass} />
        </FilterField>
        <FilterField label="To">
          <input type="date" name="to" defaultValue={sp.to} className={inputClass} />
        </FilterField>
        <FilterField label="Billing">
          <select name="state" defaultValue={sp.state ?? ""} className={inputClass}>
            <option value="">All</option>
            <option value="unbilled">Unbilled</option>
            <option value="billed">Billed</option>
            <option value="non_billable">Not billable</option>
          </select>
        </FilterField>
      </FilterBar>
      {list.rows.length === 0 ? (
        <EmptyState title="No time entries match">Change the filters, or record time above.</EmptyState>
      ) : (
        <>
          <p className="mb-2 text-sm text-slate-600">{Decimal.from(list.totalHours).normalize().toString()} hours in {list.total} entries.</p>
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Project</Th>
                <Th>Who</Th>
                <Th>What</Th>
                <Th align="right">Hours</Th>
                <Th>Billing</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.rows.map(({ entry, projectName, billed }) => (
                <tr key={entry.id}>
                  <Td><DateText date={entry.workDate} /></Td>
                  <Td>
                    <Link className="text-brand-700 hover:underline" href={`${base}/projects/${entry.projectId}`}>
                      {projectName}
                    </Link>
                  </Td>
                  <Td>{entry.personLabel}</Td>
                  <Td className="max-w-xs truncate text-slate-600">{entry.description}</Td>
                  <Td align="right" className="num">{Decimal.from(entry.hours).normalize().toString()}</Td>
                  <Td>{!entry.billable ? <Badge>not billable</Badge> : billed ? <Badge tone="green">billed</Badge> : <Badge tone="amber">unbilled</Badge>}</Td>
                  <Td>
                    {may && !billed && (
                      <ConfirmButton action={deleteTimeAction.bind(null, org, entry.id)} label="Delete" size="sm" variant="ghost" title="Delete this time entry?" body="It has not been billed." confirmLabel="Delete" />
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={page} pageSize={list.pageSize} total={list.total} params={sp} />
        </>
      )}
    </>
  );
}
