"use server";

import { redirect } from "next/navigation";
import { createPortalSession, createSubscriptionCheckout } from "@/lib/hosted/billing";
import { runAction, type ActionResult } from "@/lib/web/actions";
import { orgCtx } from "@/lib/web/session";

export async function subscribeAction(slug: string): Promise<ActionResult<unknown>> {
  return runAction(async () => {
    const url = await createSubscriptionCheckout(await orgCtx(slug));
    redirect(url);
  });
}

export async function manageBillingAction(slug: string): Promise<ActionResult<unknown>> {
  return runAction(async () => {
    const url = await createPortalSession(await orgCtx(slug));
    redirect(url);
  });
}
