import { NextResponse } from "next/server";
import { readiness } from "@/lib/ops/health";

export const dynamic = "force-dynamic";

/** Readiness: database, migrations, job queue and storage. 503 when any fails. */
export async function GET() {
  const r = await readiness();
  return NextResponse.json(r, { status: r.status === "ready" ? 200 : 503, headers: { "cache-control": "no-store" } });
}
