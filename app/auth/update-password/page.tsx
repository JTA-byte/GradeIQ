"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function UpdatePasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [sessionValid, setSessionValid] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(
    null
  );

  const supabase = createClient();

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      setSessionValid(!!user);
      setCheckingSession(false);
    });
  }, [supabase]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);

    if (password !== confirmPassword) {
      setMessage({ type: "error", text: "Passwords don't match." });
      return;
    }

    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setMessage({ type: "error", text: error.message });
      setLoading(false);
    } else {
      setMessage({ type: "success", text: "Password updated. Redirecting..." });
      setTimeout(() => {
        window.location.href = "/";
      }, 1500);
    }
  }

  if (checkingSession) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center px-4">
        <p className="font-mono text-sm text-slate">Loading...</p>
      </div>
    );
  }

  if (!sessionValid) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center px-4">
        <div className="max-w-sm text-center">
          <h1 className="font-display text-3xl text-ink mb-2">Link expired</h1>
          <p className="font-mono text-sm text-slate mb-6">
            This password reset link is invalid or has expired. Request a new one.
          </p>
          <a
            href="/auth/reset-password"
            className="inline-block bg-ink text-paper font-mono text-sm uppercase tracking-widest px-6 py-3 hover:bg-moss transition-colors"
          >
            Request new link
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-paper flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <h1 className="font-display text-3xl text-ink mb-1">GradeIQ</h1>
          <p className="font-mono text-xs text-slate uppercase tracking-widest">
            Set a new password
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="flex flex-col gap-1">
            <label className="font-mono text-xs text-slate">New password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="border border-line bg-white/60 px-4 py-3 font-mono text-sm focus:outline-none focus:border-moss"
              placeholder="At least 6 characters"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="font-mono text-xs text-slate">Confirm password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={6}
              className="border border-line bg-white/60 px-4 py-3 font-mono text-sm focus:outline-none focus:border-moss"
              placeholder="Re-enter your new password"
            />
          </div>

          {message && (
            <div
              className={`px-4 py-3 font-mono text-xs ${
                message.type === "error"
                  ? "bg-rust/10 border border-rust text-rust"
                  : "bg-moss/10 border border-moss text-moss"
              }`}
            >
              {message.text}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-ink text-paper font-mono text-sm uppercase tracking-widest py-3 hover:bg-moss transition-colors disabled:opacity-50"
          >
            {loading ? "..." : "Update password"}
          </button>
        </form>
      </div>
    </div>
  );
}
