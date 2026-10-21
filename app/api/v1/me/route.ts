import { NextResponse, type NextRequest } from "next/server";
import { resolveApiToken } from "@/lib/auth/users";

/** GET: who an API token acts as, for which organization, with what role. */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const resolved = auth.toLowerCase().startsWith("bearer ") ? await resolveApiToken(auth.slice(7).trim()) : null;
  if (!resolved) return NextResponse.json({ error: { code: "unauthorized", message: "Send a valid API token." } }, { status: 401 });
  return NextResponse.json({
    data: {
      user: { id: resolved.user.id, email: resolved.user.email, name: resolved.user.name },
      organization: { id: resolved.org.id, slug: resolved.org.slug, name: resolved.org.name, baseCurrency: resolved.org.baseCurrency },
      role: resolved.role,
      token: { id: resolved.token.id, name: resolved.token.name, expiresAt: resolved.token.expiresAt },
    },
  });
}
