import { orgCtx } from "@/lib/web/session";
import { Alert, Card, PageHeader } from "@/components/ui";
import { PaymentsSection } from "@/components/integrations/payments-section";
import { BankFeedsSection } from "@/components/integrations/bank-feeds-section";
import { PayrollSection } from "@/components/integrations/payroll-section";
import { configuredEmailProvider } from "@/lib/email/send";
import { configuredProvider } from "@/lib/fx/providers";

export const metadata = { title: "Integrations" };

/**
 * Every outside service the books can use, what each needs, and whether it
 * is connected. Each module renders its own section.
 */
export default async function Integrations({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  let email = "outbox";
  try {
    email = configuredEmailProvider().name;
  } catch (e) {
    email = `misconfigured: ${(e as Error).message}`;
  }
  const fx = configuredProvider();
  return (
    <>
      <PageHeader
        title="Integrations"
        description="Outside services the books can use. Every one is optional: the manual and import workflows keep working without them, and recording a payment never moves money."
      />
      {ctx.org.isDemo && (
        <div className="mb-6">
          <Alert tone="warning">This is a demonstration company. It can only use the clearly labeled sandbox providers; it cannot connect to live services.</Alert>
        </div>
      )}
      <div className="space-y-6">
        <PaymentsSection ctx={ctx} />
        <BankFeedsSection ctx={ctx} />
        <PayrollSection ctx={ctx} />
        <Card title="Email delivery (server setting)">
          <p className="text-sm text-slate-700">
            Provider: <strong>{email}</strong>.{" "}
            {email === "outbox"
              ? "Nothing is actually sent: messages are kept under Settings → Email and marked “not delivered”. The server administrator sets EMAIL_PROVIDER=smtp or resend to deliver."
              : "Messages are delivered through this provider; each one's delivery history is under Settings → Email."}
          </p>
        </Card>
        <Card title="Exchange rates (server setting)">
          <p className="text-sm text-slate-700">
            {fx ? (
              <>
                Rates are fetched from <strong>{fx.label}</strong> on request (Accounting → Currencies) and daily. Every rate is stored with its source; postings keep the rate they used.
              </>
            ) : (
              <>No rate provider is configured (FX_PROVIDER=none). Enter rates by hand under Accounting → Currencies.</>
            )}
          </p>
        </Card>
      </div>
    </>
  );
}
