export const metadata = {
  title: "Privacy Policy — GradeIQ",
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-paper text-ink font-body">
      <header className="border-b border-line px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <a href="/" className="font-display text-2xl text-ink">
            GradeIQ
          </a>
          <a href="/" className="font-mono text-xs text-slate hover:text-moss transition-colors">
            ← Back
          </a>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-6 py-14">
        <h1 className="font-display text-4xl mb-2">Privacy Policy</h1>
        <p className="font-mono text-xs text-slate/60 mb-12">Last updated: July 18, 2026</p>

        <div className="space-y-10 font-body text-sm leading-relaxed text-ink">
          <section>
            <h2 className="font-display text-xl mb-3">1. What we collect</h2>
            <p className="mb-3">When you use GradeIQ, we collect:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <strong>Account information:</strong> your email address and authentication
                details (or your Google account identifier, if you sign in with Google).
              </li>
              <li>
                <strong>Card photos:</strong> the images you upload for AI condition analysis.
              </li>
              <li>
                <strong>Scan history:</strong> the vision analysis results, grader recommendations,
                and card names associated with each scan you run.
              </li>
              <li>
                <strong>Portfolio and usage data:</strong> cards you add to your portfolio tracker,
                your subscription tier, and how many scans you&apos;ve used.
              </li>
              <li>
                <strong>Payment information:</strong> handled entirely by Stripe -- see Section 5.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="font-display text-xl mb-3">2. How we use it</h2>
            <p className="mb-3">We use the information we collect to:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li>Provide the Service -- running AI condition assessments, grader ROI calculations, and maintaining your scan history and portfolio.</li>
              <li>Enforce free-tier scan limits and manage your subscription.</li>
              <li>Improve the accuracy of our AI vision analysis over time.</li>
              <li>Communicate with you about your account, such as authentication and billing emails.</li>
              <li>Maintain the security and integrity of the Service.</li>
            </ul>
          </section>

          <section>
            <h2 className="font-display text-xl mb-3">3. We do not sell your data</h2>
            <p>
              We do not sell, rent, or trade your personal information to third parties for their
              marketing purposes. We share data only with the service providers described below,
              solely to operate GradeIQ.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl mb-3">4. Card photos and third-party processing</h2>
            <p className="mb-3">
              Card photos you upload are stored securely in Supabase Storage, access-controlled so
              that only you can view your own photos. To generate a condition assessment, your
              photos are sent to Anthropic&apos;s Claude API for AI vision analysis. Anthropic
              processes these images to return the assessment and does not use them to train
              models on GradeIQ&apos;s behalf.
            </p>
            <p>
              You can delete your uploaded photos at any time by deleting the associated scan or
              your account (see Section 7).
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl mb-3">5. Payment data</h2>
            <p>
              All payment processing for GradeIQ Pro subscriptions is handled entirely by Stripe.
              We never see, receive, or store your full credit card number, CVC, or other sensitive
              payment card details -- those are collected directly by Stripe&apos;s hosted checkout
              and governed by{" "}
              <a
                href="https://stripe.com/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-moss underline underline-offset-2"
              >
                Stripe&apos;s own privacy policy
              </a>
              . We only receive your subscription status and a Stripe customer identifier, used to
              manage your billing.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl mb-3">6. Other service providers</h2>
            <p>
              We use Supabase for authentication, database, and file storage, and Vercel to host
              the application. These providers process data on our behalf under their own security
              and privacy commitments, solely to help us operate GradeIQ.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl mb-3">7. Your rights</h2>
            <p className="mb-3">
              You can request deletion of your account and associated personal data (including
              uploaded photos, scan history, and portfolio records) at any time by contacting us at{" "}
              <a href="mailto:privacy@gradeiq.net" className="text-moss underline underline-offset-2">
                privacy@gradeiq.net
              </a>
              . We will process deletion requests within a reasonable time, except where we are
              required to retain certain records (e.g. billing records) to comply with legal
              obligations.
            </p>
            <p>You can also request a copy of the personal data we hold about you at any time.</p>
          </section>

          <section>
            <h2 className="font-display text-xl mb-3">8. California residents (CCPA)</h2>
            <p className="mb-3">
              If you are a California resident, the California Consumer Privacy Act (CCPA), as
              amended by the California Privacy Rights Act (CPRA), gives you the right to:
            </p>
            <ul className="list-disc pl-5 space-y-2 mb-3">
              <li>Know what personal information we collect, use, and disclose about you.</li>
              <li>Request deletion of your personal information, subject to certain exceptions.</li>
              <li>Correct inaccurate personal information we hold about you.</li>
              <li>
                Opt out of the &quot;sale&quot; or &quot;sharing&quot; of your personal
                information -- as noted in Section 3, we do not sell or share your personal
                information.
              </li>
              <li>Not be discriminated against for exercising any of these rights.</li>
            </ul>
            <p>
              To exercise any of these rights, contact us at{" "}
              <a href="mailto:privacy@gradeiq.net" className="text-moss underline underline-offset-2">
                privacy@gradeiq.net
              </a>
              . We will verify your request using the email address associated with your account
              before acting on it.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl mb-3">9. Changes to this policy</h2>
            <p>
              We may update this Privacy Policy from time to time. If we make material changes, we
              will update the &quot;Last updated&quot; date above.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl mb-3">10. Contact</h2>
            <p>
              For any privacy-related questions or requests, contact us at{" "}
              <a href="mailto:privacy@gradeiq.net" className="text-moss underline underline-offset-2">
                privacy@gradeiq.net
              </a>
              . See also our{" "}
              <a href="/terms" className="text-moss underline underline-offset-2">
                Terms of Service
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
