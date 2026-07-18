"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";

interface UserProfile {
  subscription_tier: string;
  scans_used_this_month: number;
}

export function AppHeader() {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const supabase = createClient();

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user);
      if (data.user) {
        supabase
          .from("user_profiles")
          .select("subscription_tier, scans_used_this_month")
          .eq("id", data.user.id)
          .single()
          .then(({ data: profileData }) => {
            if (profileData) setProfile(profileData);
          });
      }
    });
  }, []);

  async function handleSignOut() {
    await supabase.auth.signOut();
    window.location.href = "/auth/login";
  }

  const isFree = !profile || profile.subscription_tier === "free";
  const scansLeft = isFree ? Math.max(0, 3 - (profile?.scans_used_this_month ?? 0)) : null;

  return (
    <header className="border-b border-line px-6 py-4 bg-paper">
      <div className="max-w-4xl mx-auto flex items-center justify-between">
        <div className="flex items-baseline gap-4">
          <h1 className="font-display text-2xl text-ink">GradeIQ</h1>
          <span className="font-mono text-xs text-slate uppercase tracking-widest hidden sm:block">
            Grader recommendation engine
          </span>
          <nav className="flex items-center gap-3">
            <a
              href="/buy-signals"
              className="font-mono text-xs text-slate hover:text-moss transition-colors"
            >
              Buy Signals
            </a>
          </nav>
        </div>

        <div className="flex items-center gap-4">
          {user && profile && (
            <div className="flex items-center gap-3">
              {isFree && scansLeft !== null && (
                <span
                  className={`font-mono text-xs px-2 py-1 ${
                    scansLeft === 0
                      ? "bg-rust/10 text-rust border border-rust"
                      : "bg-moss/10 text-moss border border-moss"
                  }`}
                >
                  {scansLeft === 0 ? "No scans left" : `${scansLeft} scan${scansLeft === 1 ? "" : "s"} left`}
                </span>
              )}
              {isFree && (
                <a
                  href="/upgrade"
                  className="font-mono text-xs bg-ink text-paper px-3 py-1 hover:bg-moss transition-colors"
                >
                  Upgrade to Pro
                </a>
              )}
              {!isFree && (
                <span className="font-mono text-xs text-moss border border-moss px-2 py-1">
                  Pro
                </span>
              )}
            </div>
          )}

          {user ? (
            <div className="flex items-center gap-3">
              <a
                href="/portfolio"
                className="font-mono text-xs text-slate border border-line px-3 py-1 hover:border-moss hover:text-moss transition-colors hidden sm:block"
              >
                Portfolio
              </a>
              <a
                href="/scans"
                className="font-mono text-xs text-slate border border-line px-3 py-1 hover:border-moss hover:text-moss transition-colors hidden sm:block"
              >
                History
              </a>
              <span className="font-mono text-xs text-slate hidden md:block truncate max-w-[160px]">
                {user.email}
              </span>
              <button
                onClick={handleSignOut}
                className="font-mono text-xs text-slate border border-line px-3 py-1 hover:border-rust hover:text-rust transition-colors"
              >
                Sign out
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <a
                href="/auth/login"
                className="font-mono text-xs border border-line px-3 py-1 hover:border-moss transition-colors"
              >
                Sign in
              </a>
              <a
                href="/auth/signup"
                className="font-mono text-xs bg-ink text-paper px-3 py-1 hover:bg-moss transition-colors"
              >
                Sign up free
              </a>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
