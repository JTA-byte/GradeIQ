# GradeIQ — MVP scaffold

AI-powered Pokémon TCG grading recommendation engine. Upload a card photo,
get ranked grader recommendations (PSA / CGC / BGS) with expected net ROI,
blending AI vision condition analysis with historical gem rate data.

## What's built

- **`lib/roiEngine.ts`** — the core decision engine. Pure TypeScript, no
  dependencies. Takes market data + gem rates + vision scores, returns
  ranked grader recommendations with net ROI math. Fully tested
  (`lib/roiEngine.test.ts` — 9/9 passing).
- **`lib/visionAnalysis.ts`** — calls the Claude API to analyze a card photo
  and return a structured condition assessment (centering, surface, edges,
  corners).
- **`lib/mockDataService.ts`** — stands in for live TCGPlayer pricing and
  PSA/CGC pop report data. Has realistic sample data for a few well-known
  cards (Umbreon VMAX Alt Art, Charizard Base Set Shadowless, Mega
  Charizard X EX SIR, Pikachu Surging Sparks SIR) and a sensible default
  for anything else.
- **`app/api/analyze/route.ts`** — the API endpoint that ties it together:
  photo in, vision analysis + market data + ROI recommendation out.
- **`app/page.tsx`** + **`components/GraderSlab.tsx`** — the upload UI and
  results display.
- **`supabase/schema.sql`** — full database schema: cards, gem rate
  history (insert-only so trends are preserved), market prices, grader
  news/events, user profiles, and scan history. Includes row-level
  security policies.

## Running it locally

You'll need [Node.js](https://nodejs.org) 18+ installed.

```bash
cd gradeiq
npm install
cp .env.example .env.local
```

Then open `.env.local` and add your Anthropic API key (get one at
[console.anthropic.com](https://console.anthropic.com/settings/keys)).
That's the only key required to run the app with mock market data.

```bash
npm run dev
```

Open `http://localhost:3000`. Upload a card photo, type a card name (try
"Umbreon VMAX Alt Art" for the richest sample data), and run the analysis.

To run just the ROI engine tests (no API key needed):

```bash
npm run test
```

## What's mock vs. real right now

| Piece | Status |
|---|---|
| ROI/gem-rate calculation engine | Real, tested logic |
| AI vision card analysis | Real — calls Claude API |
| TCGPlayer pricing | Mock data (4 sample cards + a default) |
| PSA/CGC gem rates | Mock data (same sample cards) |
| Database | Schema written, not yet connected to the app |
| Auth / payments | Not yet built |

## Next steps, in order

1. **Get a Supabase project** (free tier) — run `supabase/schema.sql` in
   the SQL editor, then add your project URL + anon key to `.env.local`.
   This unlocks saving scan history.
2. **Apply for a TCGPlayer API key** at docs.tcgplayer.com (usually
   approved within a few days) — once you have it, I can swap
   `mockDataService.ts` for a real TCGPlayer client.
3. **Build the PSA/CGC pop scraper** — a Python script using Playwright
   that runs nightly and writes into the `gem_rates` table. I can build
   this next; it needs to run somewhere persistent (Render or Railway
   cron job), not in this chat.
4. **Add Supabase Auth** to gate scans behind login and enforce the
   free-tier 3-scans-per-month limit.
5. **Add Stripe** for the paid tier.
6. **Deploy to Vercel.**

## A note on the mock data

The mock gem rates and prices are illustrative, modeled loosely on real
market patterns (e.g. Shadowless Charizard has a very low gem rate, low-pop
modern SIRs have wide PSA/CGC divergence) so the app *feels* realistic
while you test the flow. Treat every number in there as a placeholder —
none of it is live pricing.
