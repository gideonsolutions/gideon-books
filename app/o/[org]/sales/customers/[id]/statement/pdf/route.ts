import type { NextRequest } from "next/server";
import { statementPdfResponse } from "@/lib/sales/pdf-route";

export async function GET(req: NextRequest, { params }: { params: Promise<{ org: string; id: string }> }) {
  const p = await params;
  return statementPdfResponse(req, p.org, p.id);
}
