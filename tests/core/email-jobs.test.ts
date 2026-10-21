import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { emailMessages, jobs } from "@/lib/db/schema/core";
import { queueEmail, setEmailProviderForTests } from "@/lib/email/send";
import { claim, drain, enqueue, runJob } from "@/lib/jobs/queue";
import { coreJobs } from "@/lib/jobs/core-jobs";
import { setupOrg } from "../helpers";

describe("email delivery", () => {
  it("keeps outbox mail undelivered and records the history", async () => {
    const o = await setupOrg();
    const msg = await queueEmail(getDb(), o.ctx, { to: "client@example.test", subject: "Invoice", text: "Hello" });
    await drain(coreJobs, { kinds: ["email.send"] });
    const [row] = await getDb().select().from(emailMessages).where(eq(emailMessages.id, msg.id));
    expect(row!.status).toBe("not_delivered");
  });

  it("delivers through a provider, retries failures, and never delivers for a demonstration company", async () => {
    const sent: string[] = [];
    let fail = 1;
    setEmailProviderForTests({
      name: "test",
      delivers: true,
      async send(m) {
        if (fail-- > 0) throw new Error("temporary failure");
        sent.push(m.to);
        return { providerMessageId: "x1" };
      },
    });
    try {
      const o = await setupOrg();
      const msg = await queueEmail(getDb(), o.ctx, { to: "real@example.test", subject: "Hi", text: "Body" });
      const job = await claim("t", ["email.send"]);
      expect(await runJob(job!, coreJobs)).toBe("failed");
      await getDb().update(jobs).set({ runAt: new Date() }).where(eq(jobs.id, job!.id));
      await drain(coreJobs, { kinds: ["email.send"] });
      const [row] = await getDb().select().from(emailMessages).where(eq(emailMessages.id, msg.id));
      expect(row!.status).toBe("sent");
      expect(sent).toEqual(["real@example.test"]);

      const demo = await setupOrg({ isDemo: true });
      const dm = await queueEmail(getDb(), demo.ctx, { to: "someone@example.test", subject: "Demo", text: "x" });
      await drain(coreJobs, { kinds: ["email.send"] });
      const [drow] = await getDb().select().from(emailMessages).where(eq(emailMessages.id, dm.id));
      expect(drow!.status).toBe("not_delivered");
      expect(sent).toEqual(["real@example.test"]);
    } finally {
      setEmailProviderForTests(null);
    }
  });

  it("deduplicates enqueued jobs and marks a job dead after its last attempt", async () => {
    const a = await enqueue(getDb(), "test.noop", {}, { dedupeKey: "once-only" });
    const b = await enqueue(getDb(), "test.noop", {}, { dedupeKey: "once-only" });
    expect(a.id).toBe(b.id);
    const j = await enqueue(getDb(), "test.fails", {}, { maxAttempts: 1 });
    await getDb().update(jobs).set({ runAt: new Date(0) }).where(eq(jobs.id, j.id));
    const claimed = await claim("t", ["test.fails"]);
    expect(await runJob(claimed!, { "test.fails": async () => { throw new Error("boom"); } })).toBe("dead");
  });
});
