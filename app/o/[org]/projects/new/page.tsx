import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { requirePermission } from "@/lib/context";
import { contactOptions } from "@/lib/web/options";
import { Card, PageHeader } from "@/components/ui";
import { ProjectForm } from "@/components/projects/project-form";
import { createProjectAction } from "../actions";

export const metadata = { title: "New project" };

export default async function NewProject({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  requirePermission(ctx, "projects.manage");
  return (
    <>
      <PageHeader title="New project" back={{ href: `/o/${org}/projects`, label: "Projects" }} />
      <Card className="max-w-3xl">
        <ProjectForm
          action={createProjectAction.bind(null, org)}
          customers={await contactOptions(getDb(), ctx.orgId, "customer")}
          defaults={{ name: "", code: "", customerId: "", status: "active", billingMethod: "time_and_materials", hourlyRate: "", fixedFee: "", budgetAmount: "", startDate: "", endDate: "", description: "" }}
          submitLabel="Create project"
        />
      </Card>
    </>
  );
}
