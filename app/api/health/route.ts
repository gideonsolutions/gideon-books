import { NextResponse } from "next/server";
import { liveness } from "@/lib/ops/health";

export const dynamic = "force-dynamic";

/** Liveness: the process is up and answering. */
export function GET() {
  return NextResponse.json(liveness(), { headers: { "cache-control": "no-store" } });
}
