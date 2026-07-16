/**
 * Supabase client for use in the browser (client components).
 * Uses the public anon key -- safe to expose, since row-level security
 * policies (see supabase/schema.sql) restrict what each user can read/write.
 */
import { createBrowserClient } from "@supabase/ssr";

// Trim whitespace/newlines and any trailing slash -- a stray trailing
// slash (or worse, a pasted-in path like "/rest/v1/") turns every auth
// request into a malformed URL ("Invalid path specified in request URL").
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim().replace(/\/+$/, "");

export function createClient() {
  return createBrowserClient(SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
