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
 *
 * IMPORTANT: signature verification requires the exact raw request body
 * Stripe signed. `request.text()` on a Next.js App Router Route Handler
 * returns the untouched raw body as long as nothing calls `.json()` on
 * the request first -- unlike the Pages Router, there's no `bodyParser`
 * config to disable here. Do not parse the body before this line.
 */
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { createServiceRoleClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  console.log("[stripe webhook] request received");

  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  console.log("[stripe webhook] raw body length:", body.length, "| signature header present:", !!signature);

  if (!signature) {
    console.error("[stripe webhook] missing stripe-signature header -- rejecting");
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
    console.error("[stripe webhook] signature verification failed:", message);
    return NextResponse.json({ error: `Webhook signature verification failed: ${message}` }, { status: 400 });
  }

  console.log("[stripe webhook] signature verified -- event type:", event.type, "| event id:", event.id);

  const supabase = createServiceRoleClient();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.user_id;

      console.log("[stripe webhook] checkout.session.completed -- session id:", session.id, "| metadata.user_id:", userId, "| customer:", session.customer);

      if (!userId) {
        console.error("[stripe webhook] checkout.session.completed has no metadata.user_id -- cannot upgrade anyone");
        break;
      }

      const { data, error } = await supabase
        .from("user_profiles")
        .update({ subscription_tier: "pro" })
        .eq("id", userId)
        .select();

      if (error) {
        console.error("[stripe webhook] Supabase update failed for user", userId, ":", error.message);
      } else if (!data || data.length === 0) {
        console.error("[stripe webhook] Supabase update matched 0 rows for user_profiles.id =", userId, "-- does this user_profiles row exist?");
      } else {
        console.log("[stripe webhook] upgraded user", userId, "to pro. Updated rows:", data.length);
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      console.log("[stripe webhook] customer.subscription.deleted -- customer:", subscription.customer);

      const { data, error } = await supabase
        .from("user_profiles")
        .update({ subscription_tier: "free" })
        .eq("stripe_customer_id", subscription.customer as string)
        .select();

      if (error) {
        console.error("[stripe webhook] Supabase downgrade failed for customer", subscription.customer, ":", error.message);
      } else if (!data || data.length === 0) {
        console.error("[stripe webhook] Supabase downgrade matched 0 rows for stripe_customer_id =", subscription.customer);
      } else {
        console.log("[stripe webhook] downgraded customer", subscription.customer, "to free. Updated rows:", data.length);
      }
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      console.log("[stripe webhook] customer.subscription.updated -- customer:", subscription.customer, "| status:", subscription.status);

      if (subscription.status !== "active" && subscription.status !== "trialing") {
        const { data, error } = await supabase
          .from("user_profiles")
          .update({ subscription_tier: "free" })
          .eq("stripe_customer_id", subscription.customer as string)
          .select();

        if (error) {
          console.error("[stripe webhook] Supabase downgrade failed for customer", subscription.customer, ":", error.message);
        } else if (!data || data.length === 0) {
          console.error("[stripe webhook] Supabase downgrade matched 0 rows for stripe_customer_id =", subscription.customer);
        } else {
          console.log("[stripe webhook] downgraded customer", subscription.customer, "to free. Updated rows:", data.length);
        }
      }
      break;
    }

    default:
      console.log("[stripe webhook] unhandled event type:", event.type, "-- ignoring");
      break;
  }

  console.log("[stripe webhook] done processing event", event.id);
  return NextResponse.json({ received: true });
}
