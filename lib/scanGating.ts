/**
 * Scan gating: enforces monthly scan limits per subscription tier.
 *
 * Free:  3 scans/month
 * Pro:   unlimited
 * Bulk:  unlimited + bulk submission optimizer (future)
 *
 * Called from the /api/analyze route before running any expensive AI calls.
 * Uses the server-side Supabase client so this always reflects the real DB
 * state -- a client-side check would be trivially bypassable.
 */
import { SupabaseClient } from "@supabase/supabase-js";

export const SCAN_LIMITS: Record<string, number> = {
  free: 3,
  pro: Infinity,
  bulk: Infinity,
};

interface ScanAllowance {
  allowed: boolean;
  scansUsed: number;
  scansLimit: number;
  tier: string;
  reason?: string;
}

/**
 * Checks whether this user is allowed to run another scan this month.
 * Does NOT increment the count -- call `recordScanUsed` after a
 * successful analysis to do that.
 */
export async function checkScanAllowance(
  supabase: SupabaseClient,
  userId: string
): Promise<ScanAllowance> {
  const { data: profile, error } = await supabase
    .from("user_profiles")
    .select("subscription_tier, scans_used_this_month, scans_reset_at")
    .eq("id", userId)
    .single();

  if (error || !profile) {
    return {
      allowed: false,
      scansUsed: 0,
      scansLimit: 0,
      tier: "unknown",
      reason: "Could not load user profile",
    };
  }

  // Auto-reset if the calendar month has rolled over
  const resetAt = new Date(profile.scans_reset_at);
  const now = new Date();
  let scansUsed = profile.scans_used_this_month;

  if (now >= resetAt) {
    // Reset the count and push reset_at forward one month
    const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    await supabase
      .from("user_profiles")
      .update({
        scans_used_this_month: 0,
        scans_reset_at: nextReset.toISOString(),
      })
      .eq("id", userId);
    scansUsed = 0;
  }

  const tier = profile.subscription_tier ?? "free";
  const limit = SCAN_LIMITS[tier] ?? SCAN_LIMITS.free;
  const allowed = scansUsed < limit;

  return {
    allowed,
    scansUsed,
    scansLimit: limit === Infinity ? -1 : limit,
    tier,
    reason: allowed
      ? undefined
      : `You've used all ${limit} free scans this month. Upgrade to Pro for unlimited.`,
  };
}

/**
 * Increments the scan counter for this user. Call only after a
 * successful analysis -- not on errors or before the analysis runs.
 */
export async function recordScanUsed(
  supabase: SupabaseClient,
  userId: string
): Promise<void> {
  // Increment atomically using a Postgres RPC rather than read-modify-write
  // (avoids a race condition if two requests land at the same time)
  await supabase.rpc("increment_scans_used", { user_id: userId });
}
