const STEPS = [
  {
    number: "01",
    title: "Upload up to 10 photos",
    description:
      "Front, back, and close-ups of each corner and edge. The more angles you give it, the sharper the read on corners and centering.",
  },
  {
    number: "02",
    title: "AI analyzes every angle",
    description:
      "Centering, surface, edges, and corners — scored across all photos together, not in isolation, and flagged if one zone is meaningfully worse than the rest.",
  },
  {
    number: "03",
    title: "Get a ranked recommendation",
    description:
      "PSA, CGC, BGS, and TAG compared side by side, with a full net ROI breakdown after fees — so you know which grader actually pays off.",
  },
];

const FEATURES = [
  {
    title: "10-photo AI condition assessment",
    description: "Full front/back plus 8 optional corner close-ups, scored together as one card.",
  },
  {
    title: "PSA, CGC, BGS, and TAG comparison",
    description: "Every major grader's expected return, ranked side by side for this exact copy.",
  },
  {
    title: "Real gem rate data from live pop reports",
    description: "Population data scraped nightly, not static estimates from last year.",
  },
  {
    title: "Real graded sale prices from Alt.xyz",
    description: "Actual recent sold comps for top-grade copies, not guesswork.",
  },
  {
    title: "Net ROI after all fees",
    description: "Grading fees, return shipping, and platform cut — all priced in before you decide.",
  },
  {
    title: "Grade vs. sell raw recommendation",
    description: "A clear verdict when the numbers say grading isn't worth it for this copy.",
  },
  {
    title: "Arbitrage detection across graders",
    description: "Flags when one grader's gem rate is running unusually high on a specific card.",
  },
];

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-paper text-ink font-body">
      {/* Top bar */}
      <header className="border-b border-line px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <span className="font-display text-2xl text-ink">GradeIQ</span>
          <div className="flex items-center gap-4">
            <a
              href="/auth/login"
              className="font-mono text-xs text-slate hover:text-moss transition-colors"
            >
              Sign in
            </a>
            <a
              href="/auth/signup"
              className="font-mono text-xs bg-ink text-paper px-4 py-2 hover:bg-moss transition-colors"
            >
              Sign up free
            </a>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-6 pt-20 pb-24 text-center">
        <h1 className="font-display text-5xl sm:text-6xl leading-[1.05] mb-6 text-balance">
          Grade smarter.
          <br />
          Sell higher.
        </h1>
        <p className="font-body text-lg text-slate max-w-2xl mx-auto leading-relaxed mb-10">
          AI-powered grading recommendations that tell you which grader to use, whether to grade
          at all, and your expected net ROI — before you spend a dollar on fees.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <a
            href="/auth/signup"
            className="w-full sm:w-auto bg-ink text-paper font-mono text-sm uppercase tracking-widest px-8 py-4 hover:bg-moss transition-colors"
          >
            Start for free
          </a>
          <a
            href="#how-it-works"
            className="w-full sm:w-auto border border-line font-mono text-sm uppercase tracking-widest px-8 py-4 hover:border-moss hover:text-moss transition-colors"
          >
            See how it works
          </a>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="border-t border-line bg-white/40">
        <div className="max-w-5xl mx-auto px-6 py-20">
          <h2 className="font-display text-3xl mb-12 text-center">How it works</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-10">
            {STEPS.map((step) => (
              <div key={step.number}>
                <div className="font-display text-4xl text-moss mb-4">{step.number}</div>
                <h3 className="font-display text-xl mb-2">{step.title}</h3>
                <p className="font-body text-sm text-slate leading-relaxed">{step.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-line">
        <div className="max-w-5xl mx-auto px-6 py-20">
          <h2 className="font-display text-3xl mb-12 text-center">
            Everything you need to decide, in one scan
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="border border-line bg-white/40 p-6">
                <h3 className="font-display text-lg mb-2">{feature.title}</h3>
                <p className="font-body text-sm text-slate leading-relaxed">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="border-t border-line bg-white/40">
        <div className="max-w-5xl mx-auto px-6 py-20">
          <h2 className="font-display text-3xl mb-12 text-center">Simple pricing</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-3xl mx-auto mb-10">
            <div className="border border-line bg-paper p-8">
              <h3 className="font-display text-xl mb-1">Free</h3>
              <div className="font-display text-4xl mb-6">$0</div>
              <ul className="font-mono text-xs text-slate space-y-3">
                <li>3 scans/month</li>
                <li>All graders (PSA, CGC, BGS, TAG)</li>
                <li>Full ROI breakdown</li>
              </ul>
            </div>
            <div className="border-2 border-moss bg-paper p-8 relative">
              <span className="absolute -top-3 left-6 bg-moss text-paper text-xs tracking-widest uppercase px-2 py-1 font-mono">
                Most popular
              </span>
              <h3 className="font-display text-xl mb-1 mt-1">Pro</h3>
              <div className="font-display text-4xl mb-6">
                $12<span className="font-mono text-base text-slate">/mo</span>
              </div>
              <ul className="font-mono text-xs text-slate space-y-3">
                <li>Unlimited scans</li>
                <li>All graders (PSA, CGC, BGS, TAG)</li>
                <li>Full ROI breakdown</li>
                <li>Priority data updates</li>
              </ul>
            </div>
          </div>
          <div className="text-center">
            <a
              href="/auth/signup"
              className="inline-block bg-ink text-paper font-mono text-sm uppercase tracking-widest px-8 py-4 hover:bg-moss transition-colors"
            >
              Start free — no credit card required
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-line">
        <div className="max-w-5xl mx-auto px-6 py-10 flex flex-col sm:flex-row items-center justify-between gap-4">
          <span className="font-display text-xl text-ink">GradeIQ</span>
          <div className="flex items-center gap-6 font-mono text-xs text-slate">
            <a href="/auth/login" className="hover:text-moss transition-colors">
              Sign in
            </a>
            <a href="/auth/signup" className="hover:text-moss transition-colors">
              Sign up
            </a>
            <a href="/terms" className="hover:text-moss transition-colors">
              Terms of Service
            </a>
            <a href="/privacy" className="hover:text-moss transition-colors">
              Privacy Policy
            </a>
            <span className="text-slate/60">gradeiq.net</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
