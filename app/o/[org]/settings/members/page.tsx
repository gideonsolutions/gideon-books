import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { listInvitations, listMembers } from "@/lib/auth/users";
import { canGrantRole, ROLE_DESCRIPTIONS, ROLE_LABELS, ROLE_RANK } from "@/lib/authz/permissions";
import { ROLES } from "@/lib/db/schema/core";
import { Badge, Card, DateText, PageHeader, Table, Td, Th } from "@/components/ui";
import { ActionForm, ConfirmButton, SelectField, SubmitButton } from "@/components/client/forms";
import { InviteForm } from "@/components/settings/reveal-forms";
import { changeRoleAction, inviteAction, removeMemberAction, revokeInvitationAction } from "../actions";

export const metadata = { title: "Members & access" };

export default async function Members({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  const members = await listMembers(db, ctx.orgId);
  const invites = await listInvitations(db, ctx.orgId);
  const manage = can(ctx, "members.manage");
  const grantable = ROLES.filter((r) => canGrantRole(ctx.role, r)).map((r) => ({ value: r, label: ROLE_LABELS[r] }));
  return (
    <>
      <PageHeader title="Members & access" description="Who can see and change these books. Accountants can be members of many organizations and switch between them." />
      <div className="space-y-6">
        <Card title="Roles">
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {ROLES.map((r) => (
              <div key={r}>
                <dt className="text-sm font-semibold text-slate-900">{ROLE_LABELS[r]}</dt>
                <dd className="text-sm text-slate-600">{ROLE_DESCRIPTIONS[r]}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Table>
          <thead>
            <tr>
              <Th>Person</Th>
              <Th>Role</Th>
              <Th className="hidden sm:table-cell">Two-step</Th>
              <Th className="hidden md:table-cell">Joined</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {members.map((m) => {
              const editable = manage && m.userId !== ctx.actor.userId && ROLE_RANK[m.role] <= ROLE_RANK[ctx.role];
              return (
                <tr key={m.userId}>
                  <Td>
                    <div className="font-medium">{m.name}</div>
                    <div className="text-xs text-slate-500">{m.email}</div>
                  </Td>
                  <Td>
                    {editable ? (
                      <ActionForm action={changeRoleAction.bind(null, org, m.userId)} className="flex items-end gap-2">
                        <SelectField label="Role" name="role" defaultValue={m.role} options={grantable} />
                        <SubmitButton variant="secondary">Change</SubmitButton>
                      </ActionForm>
                    ) : (
                      <Badge tone="blue">{ROLE_LABELS[m.role]}</Badge>
                    )}
                  </Td>
                  <Td className="hidden sm:table-cell">{m.mfa ? <Badge tone="green">on</Badge> : <Badge>off</Badge>}</Td>
                  <Td className="hidden md:table-cell">
                    <DateText date={m.joinedAt.toISOString().slice(0, 10)} />
                  </Td>
                  <Td align="right">
                    {editable && (
                      <ConfirmButton action={removeMemberAction.bind(null, org, m.userId)} label="Remove" size="sm" variant="ghost" title={`Remove ${m.name}?`} body="They lose access to these books immediately; their API tokens for this organization are revoked. Their past work stays in the audit log." confirmLabel="Remove" />
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        {manage && (
          <Card title="Invite someone">
            <InviteForm action={inviteAction.bind(null, org)} roles={grantable} />
          </Card>
        )}
        {invites.length > 0 && (
          <Card title="Pending invitations" padded={false}>
            <ul className="divide-y divide-slate-100">
              {invites.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <span>
                    {i.email} · {ROLE_LABELS[i.role]} · expires <DateText date={i.expiresAt.toISOString().slice(0, 10)} />
                  </span>
                  {manage && <ConfirmButton action={revokeInvitationAction.bind(null, org, i.id)} label="Withdraw" size="sm" variant="ghost" title="Withdraw this invitation?" confirmLabel="Withdraw" />}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
