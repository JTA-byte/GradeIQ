/**
 * GET /api/buy-signals/[cardId]
 *
 * Internal, service-to-service endpoint -- NOT part of the public API
 * surface used by the frontend. python-services/jobs/check_price_alerts.py
 * calls this to pull a triggered alert's card's live IQ score, expected
 * ROI%, and max buy price for its email, without duplicating the ROI
 * engine's math in Python (a second implementation of that math would be
 * a second place for it to drift out of sync with lib/roiEngine.ts).
 *
 * Gated on a shared secret (INTERNAL_API_KEY) rather than user auth,
 * since the caller is a GitHub Actions cron job with no user session --
 * and gated at all, rather than left open, because this exposes
 * proprietary IQ/ROI numbers that shouldn't be scrapeable by anyone who
 * enumerates card IDs.
 */
import { NextRequest, NextResponse } from "next/server";
import { getBuySignalForCard } from "@/lib/buySignals";
import { ebayActiveRawListingsUrl } from "@/lib/ebayLink";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function GET(request: NextRequest, { params }: { params: { cardId: string } }) {
  const expectedKey = process.env.INTERNAL_API_KEY;
  if (!expectedKey) {
    return NextResponse.json({ error: "INTERNAL_API_KEY not configured" }, { status: 503 });
  }
  if (request.headers.get("x-internal-api-key") !== expectedKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const signal = await getBuySignalForCard(params.cardId);
    if (!signal) {
      return NextResponse.json({ error: "No buy signal available for this card" }, { status: 404 });
    }

    const cardIdentifier = {
      cardName: signal.cardName,
      cardNumber: signal.cardNumber,
      setName: signal.setName,
      variant: signal.variant,
      variantDetail: signal.variantDetail,
      language: signal.language,
    };

    return NextResponse.json({
      signal,
      ebayActiveListingsUrl: ebayActiveRawListingsUrl(cardIdentifier),
      buySignalsUrl: `https://gradeiq.net/buy-signals?set=${encodeURIComponent(signal.setName)}`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Unexpected server error: ${errorMessage(err)}` },
      { status: 500 }
    );
  }
}
