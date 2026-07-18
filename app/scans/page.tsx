import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";

interface ScanRecord {
  id: string;
  created_at: string;
  image_url: string;
  vision_overall_score: number;
  vision_centering_pct: number;
  vision_notes: string;
  recommendation: {
    verdict: string;
    verdictReason: string;
    bestOption: {
      graderName: string;
      netROI: number;
    } | null;
    rawSaleProfit: number;
  };
}

function verdictBadge(verdict: string) {
  const map: Record<string, { label: string; className: string }> = {
    grade: { label: "Grade it", className: "text-moss border-moss" },
    conditional: { label: "Conditional", className: "text-gold border-gold" },
    sell_raw: { label: "Sell raw", className: "text-rust border-rust" },
    no_grade: { label: "Do not grade", className: "text-rust border-rust" },
  };
  return map[verdict] ?? { label: verdict, className: "text-slate border-line" };
}

export default async function ScansPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth/login");
  }

  const { data: scans, error } = await supabase
    .from("scans")
    .select("id, created_at, image_url, vision_overall_score, vision_centering_pct, vision_notes, recommendation")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50);

  const scanList = (scans ?? []) as ScanRecord[];

  return (
    <main className="min-h-screen bg-paper text-ink font-body">
      <AppHeader />
      <div className="max-w-4xl mx-auto px-6 py-10">
        <div className="flex items-baseline justify-between mb-6">
          <h2 className="font-display text-2xl">Scan history</h2>
          <a href="/scan" className="font-mono text-xs text-moss underline underline-offset-2">
            ← New scan
          </a>
        </div>

        {error && (
          <p className="font-mono text-xs text-rust">Could not load scan history.</p>
        )}

        {!error && scanList.length === 0 && (
          <div className="border border-line p-8 text-center">
            <p className="font-mono text-sm text-slate">No scans yet.</p>
            <a href="/scan" className="mt-3 inline-block font-mono text-xs text-moss underline underline-offset-2">
              Analyze your first card →
            </a>
          </div>
        )}

        <div className="space-y-3">
          {scanList.map((scan) => {
            const badge = verdictBadge(scan.recommendation?.verdict ?? "");
            const best = scan.recommendation?.bestOption;
            const date = new Date(scan.created_at).toLocaleDateString("en-US", {
              month: "short", day: "numeric", year: "numeric",
            });

            return (
              <div
                key={scan.id}
                className="border border-line bg-white/40 p-4 flex gap-4 items-start"
              >
                {scan.image_url && (
                  <img
                    src={scan.image_url}
                    alt="Card"
                    className="w-14 h-20 object-cover flex-shrink-0 border border-line"
                  />
                )}
                {!scan.image_url && (
                  <div className="w-14 h-20 bg-line/40 flex-shrink-0 border border-line" />
                )}

                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <span
                      className={`font-mono text-xs border px-2 py-0.5 ${badge.className}`}
                    >
                      {badge.label}
                    </span>
                    <span className="font-mono text-xs text-slate/60 flex-shrink-0">{date}</span>
                  </div>

                  <div className="font-mono text-xs text-slate space-y-0.5">
                    <div>
                      Vision score:{" "}
                      <span className="text-ink">{scan.vision_overall_score}/10</span>
                      <span className="text-slate/50 ml-2">
                        centering {scan.vision_centering_pct}/{100 - scan.vision_centering_pct}
                      </span>
                    </div>
                    {best && (
                      <div>
                        Best option:{" "}
                        <span className="text-ink">{best.graderName}</span>
                        <span
                          className={`ml-2 ${best.netROI >= 0 ? "text-moss" : "text-rust"}`}
                        >
                          {best.netROI >= 0 ? "+" : ""}${Math.round(best.netROI)}
                        </span>
                      </div>
                    )}
                  </div>

                  {scan.vision_notes && (
                    <p className="font-body text-xs text-slate/70 mt-2 leading-relaxed line-clamp-2">
                      {scan.vision_notes}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}
