"use server";

import { payThroughSandbox } from "@/lib/integrations/payments/sandbox-sim";
import { runAction, type ActionResult } from "@/lib/web/actions";

export async function sandboxPayAction(token: string): Promise<ActionResult<{ href: string }>> {
  return runAction(async () => {
    await payThroughSandbox(token);
    return { href: `/pay/${token}?done=1` };
  });
}
