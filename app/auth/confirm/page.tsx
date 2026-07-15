export default function ConfirmPage() {
  return (
    <div className="min-h-screen bg-paper flex items-center justify-center px-4">
      <div className="max-w-sm text-center">
        <h1 className="font-display text-3xl text-ink mb-2">You're in.</h1>
        <p className="font-mono text-sm text-slate mb-6">
          Your email has been confirmed. Start analyzing cards.
        </p>
        <a
          href="/"
          className="inline-block bg-ink text-paper font-mono text-sm uppercase tracking-widest px-6 py-3 hover:bg-moss transition-colors"
        >
          Open GradeIQ
        </a>
      </div>
    </div>
  );
}
