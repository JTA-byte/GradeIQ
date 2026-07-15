"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Mode = "login" | "signup";

interface AuthFormProps {
  mode: Mode;
}

export function AuthForm({ mode }: AuthFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  const supabase = createClient();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    if (mode === "signup") {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/confirm`,
        },
      });
      if (error) {
        setMessage({ type: "error", text: error.message });
      } else {
        setMessage({
          type: "success",
          text: "Check your email for a confirmation link.",
        });
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setMessage({ type: "error", text: error.message });
      } else {
        window.location.href = "/";
      }
    }

    setLoading(false);
  }

  async function handleGoogleSignIn() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) setMessage({ type: "error", text: error.message });
  }

  return (
    <div className="min-h-screen bg-paper flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <h1 className="font-display text-3xl text-ink mb-1">GradeIQ</h1>
          <p className="font-mono text-xs text-slate uppercase tracking-widest">
            {mode === "login" ? "Sign in to your account" : "Create your account"}
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

          <div className="flex flex-col gap-1">
            <label className="font-mono text-xs text-slate">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="border border-line bg-white/60 px-4 py-3 font-mono text-sm focus:outline-none focus:border-moss"
              placeholder={mode === "signup" ? "At least 6 characters" : "Your password"}
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
            {loading ? "..." : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        <div className="my-5 flex items-center gap-3">
          <div className="flex-1 h-px bg-line" />
          <span className="font-mono text-xs text-slate">or</span>
          <div className="flex-1 h-px bg-line" />
        </div>

        <button
          onClick={handleGoogleSignIn}
          className="w-full border border-line bg-white/60 font-mono text-sm py-3 hover:border-moss hover:bg-white transition-colors flex items-center justify-center gap-2"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Continue with Google
        </button>

        <p className="mt-6 font-mono text-xs text-slate text-center">
          {mode === "login" ? (
            <>
              No account?{" "}
              <a href="/auth/signup" className="text-moss underline underline-offset-2">
                Sign up free
              </a>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <a href="/auth/login" className="text-moss underline underline-offset-2">
                Sign in
              </a>
            </>
          )}
        </p>

        <p className="mt-4 font-mono text-xs text-slate/60 text-center">
          Free plan: 3 scans/month. Pro: unlimited.
        </p>
      </div>
    </div>
  );
}
