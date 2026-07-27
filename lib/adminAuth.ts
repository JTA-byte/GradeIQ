/**
 * Minimal admin gating for internal-only tools like app/admin/gem-rates.
 * There's no admin-role column/table anywhere in this codebase yet, and
 * adding one is overkill for a single hand-entry page -- an
 * env-var email allowlist is the smallest thing that actually works.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const allowlist = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowlist.includes(email.trim().toLowerCase());
}
