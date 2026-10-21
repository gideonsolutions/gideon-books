"use server";

import { createOrganization } from "@/lib/orgs/orgs";
import { createDemoOrganization } from "@/lib/demo/demo";
import { runAction, str, type ActionResult } from "@/lib/web/actions";
import { clientIp, requireUser } from "@/lib/web/session";

export async function createOrgAction(_: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<{ href: string }>> {
  return runAction(async () => {
    const user = await requireUser();
    const org = await createOrganization(
      user.id,
      {
        name: str(fd, "name") ?? "",
        legalName: str(fd, "legalName"),
        baseCurrency: str(fd, "baseCurrency") ?? "USD",
        country: str(fd, "country") ?? "US",
        timezone: str(fd, "timezone") ?? "America/New_York",
        fiscalYearStartMonth: Number(str(fd, "fiscalYearStartMonth") ?? "1"),
        template: str(fd, "template") ?? "services",
        entityType: (str(fd, "entityType") ?? "llc") as never,
        booksStartDate: str(fd, "booksStartDate"),
      },
      { ip: await clientIp() },
    );
    return { href: `/o/${org.slug}/onboarding` };
  });
}

export async function createDemoAction(): Promise<ActionResult<{ href: string }>> {
  return runAction(async () => {
    const user = await requireUser();
    const org = await createDemoOrganization(user.id);
    return { href: `/o/${org.slug}` };
  });
}
