/**
 * POST /api/stripe/checkout
 *
 * Auth-gated endpoint that creates a Stripe Checkout session for the
 * GradeIQ Pro subscription ($12/month) and returns its URL for the
 * client to redirect to.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { stripe } from "@/lib/stripe";

export async function POST(request: NextRequest) {
  const supabase = createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json(
      { error: "Not authenticated. Please sign in to upgrade." },
      { status: 401 }
    );
  }

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("stripe_customer_id")
    .eq("id", user.id)
    .single();

  let customerId = profile?.stripe_customer_id;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { user_id: user.id },
    });
    customerId = customer.id;

    await supabase
      .from("user_profiles")
      .update({ stripe_customer_id: customerId })
      .eq("id", user.id);
  }

  const { origin } = new URL(request.url);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: process.env.STRIPE_PRO_PRICE_ID ?? "", quantity: 1 }],
    success_url: `${origin}/scan?upgraded=true`,
    cancel_url: `${origin}/upgrade`,
    metadata: { user_id: user.id },
  });

  if (!session.url) {
    return NextResponse.json({ error: "Could not create checkout session" }, { status: 500 });
  }

  return NextResponse.json({ url: session.url });
}
