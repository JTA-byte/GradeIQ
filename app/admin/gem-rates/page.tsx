import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/lib/adminAuth";
import { AppHeader } from "@/components/AppHeader";
import { AppFooter } from "@/components/AppFooter";
import { AdminGemRatesManager } from "@/components/AdminGemRatesManager";

// This whole page only exists because the PSA/CGC/BGS/TAG pop scrapers
// (python-services/jobs/nightly_pop_scrape.py) get blocked by bot
// detection after a few hours of running -- see that job's docstring.
// Real gem rates for the highest-value cards can still get into
// gem_rates by looking them up by hand on PSA/CGC's own sites and
// entering them here, no scraping involved.
export default async function AdminGemRatesPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth/login");
  }

  if (!isAdminEmail(user.email)) {
    return (
      <main className="min-h-screen bg-paper text-ink font-body">
        <AppHeader />
        <div className="max-w-2xl mx-auto px-6 py-16 text-center">
          <p className="font-mono text-sm text-rust">
            You don&apos;t have access to this page.
          </p>
        </div>
        <AppFooter />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-paper text-ink font-body">
      <AppHeader />
      <div className="max-w-3xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h1 className="font-display text-3xl mb-2">Manual Gem Rate Entry</h1>
          <p className="font-mono text-sm text-slate max-w-2xl">
            Look a card up on{" "}
            <a
              href="https://www.psacard.com/popreport"
              target="_blank"
              rel="noopener noreferrer"
              className="text-moss underline underline-offset-2"
            >
              PSA&apos;s
            </a>{" "}
            or{" "}
            <a
              href="https://www.cgccards.com/population-report/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-moss underline underline-offset-2"
            >
              CGC&apos;s
            </a>{" "}
            own population report and enter the top-grade count and total population here. Each
            entry is timestamped and preserved -- it becomes the card&apos;s current gem rate
            immediately without overwriting prior history.
          </p>
        </div>

        <AdminGemRatesManager />
      </div>
      <AppFooter />
    </main>
  );
}
