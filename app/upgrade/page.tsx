"use client";

import { useState } from "react";
import { AppHeader } from "@/components/AppHeader";

const FEATURES: { label: string; free: string; pro: string }[] = [
  { label: "Scans per month", free: "3", pro: "Unlimited" },
  { label: "AI vision analysis", free: "Included", pro: "Included" },
  { label: "Grader ROI comparison", free: "Included", pro: "Included" },
  { label: "Scan history", free: "Included", pro: "Included" },
  { label: "Priority support", free: "—", pro: "Included" },
];

export default function UpgradePage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleUpgrade() {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/stripe/checkout", { method: "POST" });

      if (res.status === 401) {
        window.location.href = "/auth/login";
        return;
      }

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Could not start checkout");
      }

      const { url } = await res.json();
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-paper text-ink font-body">
      <AppHeader />

      <div className="max-w-3xl mx-auto px-6 py-14">
        <div className="text-center mb-10">
          <h1 className="font-display text-3xl text-ink mb-2">Upgrade to Pro</h1>
          <p className="font-mono text-sm text-slate">
            Unlimited scans, same AI-powered grading intelligence.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-10">
          <div className="border border-line bg-white/40 p-6">
            <h2 className="font-display text-xl mb-1">Free</h2>
            <div className="font-display text-3xl mb-4">$0</div>
            <ul className="font-mono text-xs text-slate space-y-3">
              {FEATURES.map((f) => (
                <li key={f.label} className="flex justify-between gap-3">
                  <span>{f.label}</span>
                  <span className="text-ink">{f.free}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="border-2 border-moss bg-white/60 p-6 relative">
            <span className="absolute -top-3 left-4 bg-moss text-paper text-xs tracking-widest uppercase px-2 py-1 font-mono">
              Recommended
            </span>
            <h2 className="font-display text-xl mb-1 mt-1">Pro</h2>
            <div className="font-display text-3xl mb-4">
              $12<span className="font-mono text-sm text-slate">/mo</span>
            </div>
            <ul className="font-mono text-xs text-slate space-y-3">
              {FEATURES.map((f) => (
                <li key={f.label} className="flex justify-between gap-3">
                  <span>{f.label}</span>
                  <span className="text-moss">{f.pro}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {error && (
          <div className="mb-6 px-4 py-3 font-mono text-sm border border-rust bg-rust/10 text-rust">
            {error}
          </div>
        )}

        <button
          onClick={handleUpgrade}
          disabled={loading}
          className="w-full bg-ink text-paper font-mono text-sm uppercase tracking-widest py-4 hover:bg-moss transition-colors disabled:opacity-40"
        >
          {loading ? "Redirecting to checkout..." : "Upgrade to Pro — $12/mo"}
        </button>

        <p className="mt-4 font-mono text-xs text-slate/60 text-center">
          Cancel anytime. Billed monthly via Stripe.
        </p>
      </div>
    </main>
  );
}
