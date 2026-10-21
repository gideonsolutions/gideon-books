/** Who can record time: members of the organization and employee contacts. */
import { and, asc, eq } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { memberships, users } from "@/lib/db/schema/core";
import { contacts } from "@/lib/db/schema/ledger";

export async function timePeople(db: DbOrTx, orgId: string): Promise<{ value: string; label: string; group: string }[]> {
  const members = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.orgId, orgId))
    .orderBy(asc(users.name));
  const employees = await db
    .select({ id: contacts.id, name: contacts.displayName })
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.isEmployee, true), eq(contacts.isArchived, false)))
    .orderBy(asc(contacts.displayName));
  return [
    ...members.map((m) => ({ value: `user:${m.id}`, label: m.name || m.email, group: "Members" })),
    ...employees.map((e) => ({ value: `contact:${e.id}`, label: e.name, group: "Employees" })),
  ];
}
