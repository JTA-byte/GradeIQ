/**
 * Card language type/constant, split out from lib/cardIdentifier.ts so
 * client components (e.g. app/scan/page.tsx's language dropdown) can
 * import it without pulling in that file's createServiceRoleClient
 * import -- a server-only Supabase client that must never end up in a
 * client bundle.
 */
export type CardLanguage = "English" | "Japanese" | "Korean" | "Chinese";

export const CARD_LANGUAGES: CardLanguage[] = ["English", "Japanese", "Korean", "Chinese"];
