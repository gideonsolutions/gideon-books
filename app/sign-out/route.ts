import { NextResponse, type NextRequest } from "next/server";
import { revokeSession } from "@/lib/auth/users";
import { SESSION_COOKIE } from "@/lib/web/session";

/** POST only, so a link or image cannot sign someone out. */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(token);
  const res = NextResponse.redirect(new URL("/sign-in", req.url), 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
