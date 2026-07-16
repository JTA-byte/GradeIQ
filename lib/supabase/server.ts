/**
 * Supabase client for use on the server (API routes, server components,
 * middleware). Reads/writes the auth cookie so sessions persist across
 * requests.
 */
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

// Trim whitespace/newlines and any trailing slash -- a stray trailing
// slash (or worse, a pasted-in path like "/rest/v1/") turns every auth
// request into a malformed URL ("Invalid path specified in request URL").
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim().replace(/\/+$/, "");

export function createClient() {
  const cookieStore = cookies();

  return createServerClient(
    SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value, ...options });
          } catch {
            // Called from a Server Component -- safe to ignore if you
            // have middleware refreshing sessions (see middleware.ts).
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value: "", ...options });
          } catch {
            // Same as above -- safe to ignore with middleware in place.
          }
        },
      },
    }
  );
}

/**
 * Service-role client for trusted server-only operations that need to
 * bypass row-level security (e.g. admin scripts, webhook handlers).
 * NEVER import this into anything that runs in the browser.
 */
export function createServiceRoleClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set in this environment. It lives in .env.local locally " +
        "(gitignored, never deployed) -- add it separately in Vercel Project Settings -> " +
        "Environment Variables, then redeploy."
    );
  }

  const { createClient: createSupabaseClient } = require("@supabase/supabase-js");
  return createSupabaseClient(SUPABASE_URL, serviceRoleKey, {
    auth: { persistSession: false },
  });
}
