"use server";

import { releaseFromRestriction } from "@/lib/specialized/funds";
import { recordDistribution } from "@/lib/specialized/trusts";
import { runAction, str, type ActionResult } from "@/lib/web/actions";
import { orgCtx } from "@/lib/web/session";

export async function releaseAction(slug: string, _: unknown, fd: FormData): Promise<ActionResult<unknown>> {
  return runAction(async () => {
    await releaseFromRestriction(await orgCtx(slug), {
      fundId: str(fd, "fundId") ?? "",
      toFundId: str(fd, "toFundId"),
      amount: str(fd, "amount") ?? "",
      date: str(fd, "date") ?? "",
      reason: str(fd, "reason") ?? "",
    });
  }, "Release posted.");
}

export async function distributionAction(slug: string, _: unknown, fd: FormData): Promise<ActionResult<unknown>> {
  return runAction(async () => {
    await recordDistribution(await orgCtx(slug), {
      beneficiaryId: str(fd, "beneficiaryId") ?? "",
      component: (str(fd, "component") ?? "income") as "principal" | "income",
      amount: str(fd, "amount") ?? "",
      date: str(fd, "date") ?? "",
      paidFromAccountId: str(fd, "paidFromAccountId") ?? "",
      memo: str(fd, "memo"),
    });
  }, "Distribution recorded. Recording it does not pay anyone.");
}
