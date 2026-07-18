import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppHeader } from "@/components/AppHeader";
import { AppFooter } from "@/components/AppFooter";
import { PortfolioManager } from "@/components/PortfolioManager";

export default async function PortfolioPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth/login");
  }

  const { data: items, error } = await supabase
    .from("portfolio_items")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return (
    <main className="min-h-screen bg-paper text-ink font-body">
      <AppHeader />
      <div className="max-w-4xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h1 className="font-display text-3xl mb-2">Portfolio</h1>
          <p className="font-mono text-sm text-slate">
            Track raw purchases through grading to sale, and see your P&amp;L per card.
          </p>
        </div>

        {error ? (
          <div className="border border-rust bg-rust/10 p-6 font-mono text-sm text-rust">
            Could not load your portfolio: {error.message}. If this is a fresh install, make sure
            the <code>portfolio_items</code> table has been created (see supabase/schema.sql).
          </div>
        ) : (
          <PortfolioManager initialItems={items ?? []} />
        )}
      </div>
      <AppFooter />
    </main>
  );
}
