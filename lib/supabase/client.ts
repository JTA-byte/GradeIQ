/**
 * Supabase client for use in the browser (client components).
 * Uses the public anon key -- safe to expose, since row-level security
 * policies (see supabase/schema.sql) restrict what each user can read/write.
 */
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
