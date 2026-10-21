"use server";

import { completeOnboarding } from "@/lib/orgs/orgs";
import { runAction, type ActionResult } from "@/lib/web/actions";
import { orgCtx } from "@/lib/web/session";

export async function finishOnboardingAction(slug: string): Promise<ActionResult<{ href: string }>> {
  return runAction(async () => {
    await completeOnboarding(await orgCtx(slug));
    return { href: `/o/${slug}` };
  });
}
