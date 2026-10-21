"use server";

import { createProject, updateProject, type ProjectInput } from "@/lib/projects/projects";
import { createTimeEntry, deleteTimeEntry, updateTimeEntry, type TimeEntryInput } from "@/lib/projects/time";
import { billProject } from "@/lib/projects/billing";
import { bool, runAction, str, type ActionResult } from "@/lib/web/actions";
import { orgCtx } from "@/lib/web/session";

type R<T = unknown> = Promise<ActionResult<T>>;

function projectInput(fd: FormData): ProjectInput {
  return {
    name: str(fd, "name") ?? "",
    code: str(fd, "code"),
    customerId: str(fd, "customerId"),
    status: (str(fd, "status") ?? "active") as ProjectInput["status"],
    billingMethod: (str(fd, "billingMethod") ?? "time_and_materials") as ProjectInput["billingMethod"],
    hourlyRate: str(fd, "hourlyRate"),
    fixedFee: str(fd, "fixedFee"),
    budgetAmount: str(fd, "budgetAmount"),
    startDate: str(fd, "startDate"),
    endDate: str(fd, "endDate"),
    description: str(fd, "description"),
  };
}

export async function createProjectAction(slug: string, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const p = await createProject(await orgCtx(slug), projectInput(fd));
    return { href: `/o/${slug}/projects/${p.id}` };
  });
}

export async function updateProjectAction(slug: string, id: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await updateProject(await orgCtx(slug), id, projectInput(fd));
  }, "Saved.");
}

function timeInput(fd: FormData): TimeEntryInput {
  const person = str(fd, "person") ?? "";
  const [kind, id] = person.split(":");
  return {
    projectId: str(fd, "projectId") ?? "",
    workDate: str(fd, "workDate") ?? "",
    userId: kind === "user" ? (id ?? null) : null,
    contactId: kind === "contact" ? (id ?? null) : null,
    hours: str(fd, "hours") ?? "",
    rate: str(fd, "rate"),
    billable: fd.has("billableSet") ? bool(fd, "billable") : true,
    description: str(fd, "description"),
  };
}

export async function createTimeAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await createTimeEntry(await orgCtx(slug), timeInput(fd));
  }, "Time recorded.");
}

export async function updateTimeAction(slug: string, id: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await updateTimeEntry(await orgCtx(slug), id, timeInput(fd));
  }, "Saved.");
}

export async function deleteTimeAction(slug: string, id: string): R {
  return runAction(async () => {
    await deleteTimeEntry(await orgCtx(slug), id);
  }, "Deleted.");
}

export async function billProjectAction(slug: string, projectId: string, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const extraAmount = str(fd, "extraAmount");
    const inv = await billProject(await orgCtx(slug), projectId, {
      timeEntryIds: fd.getAll("time").map(String),
      expenseLineIds: fd.getAll("expense").map(String),
      markupPercent: str(fd, "markupPercent"),
      incomeAccountId: str(fd, "incomeAccountId"),
      issueDate: str(fd, "issueDate") ?? "",
      extra: extraAmount ? { description: str(fd, "extraDescription") ?? "", amount: extraAmount } : null,
    });
    return { href: `/o/${slug}/documents/${inv.id}` };
  });
}
