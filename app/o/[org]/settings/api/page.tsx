import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { requirePermission } from "@/lib/context";
import { listApiTokens } from "@/lib/auth/users";
import { ROLE_LABELS, ROLE_RANK } from "@/lib/authz/permissions";
import { ROLES } from "@/lib/db/schema/core";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { ConfirmButton } from "@/components/client/forms";
import { TokenForm } from "@/components/settings/reveal-forms";
import { formatDateTime } from "@/lib/money/format";
import { createTokenAction, revokeTokenAction } from "../actions";

export const metadata = { title: "API tokens" };

export default async function ApiTokens({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  requirePermission(ctx, "api_tokens.manage");
  const tokens = await listApiTokens(getDb(), ctx.orgId);
  const roles = ROLES.filter((r) => r !== "owner" && ROLE_RANK[r] <= ROLE_RANK[ctx.role]).map((r) => ({ value: r, label: ROLE_LABELS[r] }));
  return (
    <>
      <PageHeader
        title="API tokens"
        description={
          <>
            Tokens let other software use the{" "}
            <Link href="/api-docs" className="text-brand-700 hover:underline">
              REST API
            </Link>{" "}
            on this organization&apos;s behalf, with a role no higher than yours. Send it as <code className="text-xs">Authorization: Bearer gbk_…</code>.
          </>
        }
      />
      <div className="space-y-6">
        <Card title="Create a token">
          <TokenForm action={createTokenAction.bind(null, org)} roles={roles} />
        </Card>
        {tokens.length === 0 ? (
          <EmptyState title="No tokens">Create one for each integration, so each can be revoked on its own.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Role</Th>
                <Th className="hidden md:table-cell">Created by</Th>
                <Th className="hidden md:table-cell">Last used</Th>
                <Th>Expires</Th>
                <Th>
                  <span className="sr-only">Revoke</span>
                </Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tokens.map(({ token, userEmail }) => (
                <tr key={token.id}>
                  <Td>
                    <div className="font-medium">{token.name}</div>
                    <div className="font-mono text-xs text-slate-500">{token.prefix}…</div>
                  </Td>
                  <Td>
                    <Badge tone="blue">{ROLE_LABELS[token.role]}</Badge>
                  </Td>
                  <Td className="hidden md:table-cell">{userEmail}</Td>
                  <Td className="hidden md:table-cell">{token.lastUsedAt ? formatDateTime(token.lastUsedAt, ctx.org.timezone) : "Never"}</Td>
                  <Td>{token.expiresAt ? formatDateTime(token.expiresAt, ctx.org.timezone) : "Never"}</Td>
                  <Td align="right">
                    <ConfirmButton action={revokeTokenAction.bind(null, org, token.id)} label="Revoke" size="sm" variant="ghost" title={`Revoke “${token.name}”?`} body="Anything using it stops working immediately." confirmLabel="Revoke" />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}
