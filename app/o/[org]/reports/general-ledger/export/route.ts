import type { NextRequest } from "next/server";
import { GET as exportReport } from "../../[report]/export/route";

/** The general ledger's export (its page has a static route, so its export needs one too). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  return exportReport(req, { params: Promise.resolve({ org, report: "general-ledger" }) });
}
