import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { emailDeliveryConfigured, emailHistory, listEmails } from "@/lib/email/send";
import { Alert, EmptyState, PageHeader, StatusBadge, Table, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/money/format";

export const metadata = { title: "Email" };

export default async function Emails({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  const messages = await listEmails(db, ctx.orgId, { limit: 200 });
  const histories = await Promise.all(messages.slice(0, 50).map((m) => emailHistory(db, m.id)));
  const delivers = emailDeliveryConfigured() && !ctx.org.isDemo;
  return (
    <>
      <PageHeader title="Email" description="Every message sent from these books, with its delivery history." />
      {!delivers && (
        <div className="mb-4">
          <Alert tone="warning" title="Email is not being delivered">
            {ctx.org.isDemo
              ? "Demonstration companies never send email. Messages are kept here so you can see what would have gone out."
              : "This server has no email provider (EMAIL_PROVIDER=outbox). Messages are kept here, marked “not delivered”; nobody receives them. The server administrator can configure SMTP or Resend."}
          </Alert>
        </div>
      )}
      {messages.length === 0 ? (
        <EmptyState title="No messages yet">Invoices, statements and invitations you email appear here.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>To</Th>
              <Th>Subject</Th>
              <Th>Status</Th>
              <Th className="hidden md:table-cell">Queued</Th>
              <Th className="hidden lg:table-cell">History</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {messages.map((m, i) => (
              <tr key={m.id}>
                <Td>{m.toAddress}</Td>
                <Td className="max-w-sm truncate">{m.subject}</Td>
                <Td>
                  <StatusBadge status={m.status.replace("_", " ")} />
                  {m.lastError && <div className="mt-1 max-w-xs text-xs text-danger-700">{m.lastError}</div>}
                </Td>
                <Td className="hidden md:table-cell">{formatDateTime(m.createdAt, ctx.org.timezone)}</Td>
                <Td className="hidden text-xs text-slate-600 lg:table-cell">
                  {(histories[i] ?? []).map((h) => (
                    <div key={h.id}>
                      {formatDateTime(h.createdAt, ctx.org.timezone)} — {h.status}
                      {h.detail ? `: ${h.detail}` : ""}
                    </div>
                  ))}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
