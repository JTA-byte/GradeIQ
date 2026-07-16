"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(
    null
  );

  const supabase = createClient();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    const redirectBase =
      window.location.hostname === "localhost"
        ? "http://localhost:3000"
        : "https://grade-iq-t4wy.vercel.app";

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${redirectBase}/auth/callback?next=/auth/update-password`,
    });

    if (error) {
      setMessage({ type: "error", text: error.message });
    } else {
      setMessage({
        type: "success",
        text: "Check your email for a password reset link.",
      });
    }

    setLoading(false);
  }

  return (
    <div className="min-h-screen bg-paper flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <h1 className="font-display text-3xl text-ink mb-1">GradeIQ</h1>
          <p className="font-mono text-xs text-slate uppercase tracking-widest">
            Reset your password
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="flex flex-col gap-1">
            <label className="font-mono text-xs text-slate">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="border border-line bg-white/60 px-4 py-3 font-mono text-sm focus:outline-none focus:border-moss"
              placeholder="you@example.com"
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
            {loading ? "..." : "Send reset link"}
          </button>
        </form>

        <p className="mt-6 font-mono text-xs text-slate text-center">
          Remembered your password?{" "}
          <a href="/auth/login" className="text-moss underline underline-offset-2">
            Sign in
          </a>
        </p>
      </div>
    </div>
  );
}
