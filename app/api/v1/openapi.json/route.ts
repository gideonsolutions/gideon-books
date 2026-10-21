import { NextResponse, type NextRequest } from "next/server";
import { openApiDocument } from "@/lib/api/openapi";

export async function GET(req: NextRequest) {
  return NextResponse.json(openApiDocument(process.env.APP_URL ?? new URL(req.url).origin));
}
