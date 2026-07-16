/**
 * Server-side Stripe client. Never import this into client components --
 * it's initialized with the secret key.
 */
import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", {
  apiVersion: "2026-06-24.dahlia",
});

export const PRO_PLAN_PRICE_USD = 12;
