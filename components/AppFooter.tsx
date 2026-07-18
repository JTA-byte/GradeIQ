export function AppFooter() {
  return (
    <footer className="border-t border-line mt-16">
      <div className="max-w-4xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-3">
        <span className="font-mono text-xs text-slate/60">© GradeIQ</span>
        <div className="flex items-center gap-6 font-mono text-xs text-slate">
          <a href="/terms" className="hover:text-moss transition-colors">
            Terms of Service
          </a>
          <a href="/privacy" className="hover:text-moss transition-colors">
            Privacy Policy
          </a>
        </div>
      </div>
    </footer>
  );
}
