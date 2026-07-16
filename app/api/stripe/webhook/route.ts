/**
 * POST /api/stripe/webhook
 *
 * Handles Stripe billing events. Verifies the signature with
 * STRIPE_WEBHOOK_SECRET, then:
 * - checkout.session.completed: upgrades the user to Pro
 * - customer.subscription.deleted / non-active updates: downgrades back
 *   to free, so cancellations actually take effect
 *
 * Uses the service-role Supabase client since there's no logged-in user
 * session on an incoming webhook request.
 */
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { createServiceRoleClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET ?? ""
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid signature";
    return NextResponse.json({ error: `Webhook signature verification failed: ${message}` }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.user_id;

      if (userId) {
        await supabase
          .from("user_profiles")
          .update({ subscription_tier: "pro" })
          .eq("id", userId);
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      await supabase
        .from("user_profiles")
        .update({ subscription_tier: "free" })
        .eq("stripe_customer_id", subscription.customer as string);
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      if (subscription.status !== "active" && subscription.status !== "trialing") {
        await supabase
          .from("user_profiles")
          .update({ subscription_tier: "free" })
          .eq("stripe_customer_id", subscription.customer as string);
      }
      break;
    }

    default:
      break;
  }

  return NextResponse.json({ received: true });
}
