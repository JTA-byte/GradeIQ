/**
 * GET /auth/callback
 *
 * Supabase redirects here after OAuth (Google), magic link sign-ins, and
 * password recovery emails. Exchanges the one-time code for a persistent
 * session, then redirects the user to the app.
 *
 * Password recovery links carry `type=recovery` alongside `code` -- that
 * always takes the user to /auth/update-password to set a new password,
 * regardless of whatever `next` was requested.
 */
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const type = searchParams.get("type");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const destination = type === "recovery" ? "/auth/update-password" : next;
      return NextResponse.redirect(`${origin}${destination}`);
    }
  }

  // Something went wrong -- send to login with an error flag
  return NextResponse.redirect(`${origin}/auth/login?error=auth_callback_failed`);
}
