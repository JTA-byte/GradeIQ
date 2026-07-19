import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppHeader } from "@/components/AppHeader";
import { AppFooter } from "@/components/AppFooter";
import { AlertsManager } from "@/components/AlertsManager";

export default async function AlertsPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth/login");
  }

  const { data: alerts, error } = await supabase
    .from("price_alerts")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return (
    <main className="min-h-screen bg-paper text-ink font-body">
      <AppHeader />
      <div className="max-w-3xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h1 className="font-display text-3xl mb-2">Price Alerts</h1>
          <p className="font-mono text-sm text-slate">
            Get notified when a card's raw price crosses a threshold you set. Checked every 6
            hours against the latest scraped price.
          </p>
        </div>

        {error ? (
          <div className="border border-rust bg-rust/10 p-6 font-mono text-sm text-rust">
            Could not load your alerts: {error.message}. If this is a fresh install, make sure the{" "}
            <code>price_alerts</code> table has been created (see supabase/schema.sql).
          </div>
        ) : (
          <AlertsManager initialAlerts={alerts ?? []} />
        )}
      </div>
      <AppFooter />
    </main>
  );
}
