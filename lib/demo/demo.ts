/**
 * Demonstration companies: an organization flagged is_demo, filled with the
 * synthetic dataset. Demo organizations are labeled on every page, never
 * deliver email, never connect to live providers, and cannot join an entity
 * group with real organizations.
 */
import { createOrganization } from "@/lib/orgs/orgs";
import { userCtx, type Org } from "@/lib/context";
import { getUser } from "@/lib/auth/users";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { organizations } from "@/lib/db/schema/core";
import { defaultDatasetYear, loadSyntheticDataset } from "./dataset";

export async function createDemoOrganization(userId: string): Promise<Org> {
  const user = await getUser(getDb(), userId);
  const org = await createOrganization(userId, {
    name: "Harbor & Pine Supply (demo)",
    baseCurrency: "USD",
    template: "products",
    fiscalYearStartMonth: 1,
    entityType: "llc",
    isDemo: true,
    booksStartDate: `${defaultDatasetYear()}-01-01`,
  });
  await loadSyntheticDataset(userCtx(org, userId, "owner", user.email, "system"), { year: defaultDatasetYear() });
  await getDb().update(organizations).set({ onboardingCompletedAt: new Date() }).where(eq(organizations.id, org.id));
  return org;
}
