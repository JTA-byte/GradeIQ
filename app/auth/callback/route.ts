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
 *
 * termsAcceptedAt: the Google OAuth signup path (components/AuthForm.tsx)
 * can't attach custom metadata to signInWithOAuth() the way email/password
 * signUp() can, since the auth flow is a redirect handshake rather than a
 * single request/response. So AuthForm encodes the acceptance timestamp
 * into this callback's own redirectTo URL instead, and it's written here
 * -- at this point the code exchange above has just established a real
 * session, so this update isn't blocked by RLS the way an update attempt
 * before email confirmation would be.
 */
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const type = searchParams.get("type");
  const next = searchParams.get("next") ?? "/";
  const termsAcceptedAt = searchParams.get("terms_accepted_at");

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      if (termsAcceptedAt) {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          await supabase
            .from("user_profiles")
            .update({ terms_accepted_at: termsAcceptedAt })
            .eq("id", user.id);
        }
      }

      const destination = type === "recovery" ? "/auth/update-password" : next;
      return NextResponse.redirect(`${origin}${destination}`);
    }
  }

  // Something went wrong -- send to login with an error flag
  return NextResponse.redirect(`${origin}/auth/login?error=auth_callback_failed`);
}
