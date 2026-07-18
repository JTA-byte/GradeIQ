-- GradeIQ Database Schema
-- Run this in the Supabase SQL editor to set up all tables

-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- =========================================
-- CARDS: master reference table for known cards
-- =========================================
create table cards (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  set_name text not null,
  card_number text,
  rarity text,
  release_year int,
  tcgplayer_product_id text,
  image_url text,
  created_at timestamptz default now(),
  unique (name, set_name, card_number)
);

create index idx_cards_name on cards using gin (to_tsvector('english', name));
create index idx_cards_set on cards (set_name);

-- =========================================
-- GEM_RATES: nightly snapshot per card per grader
-- Insert-only (never update) so we preserve trend history
-- =========================================
create table gem_rates (
  id uuid primary key default uuid_generate_v4(),
  card_id uuid references cards(id) not null,
  grader text not null check (grader in ('PSA', 'CGC', 'BGS', 'TAG')),
  top_grade_pop int not null,       -- e.g. count of PSA 10s
  total_pop int not null,            -- total graded copies across all grades
  gem_rate numeric generated always as (
    case when total_pop > 0 then round((top_grade_pop::numeric / total_pop) * 100, 2) else 0 end
  ) stored,
  scraped_at timestamptz default now()
);

create index idx_gem_rates_card_grader on gem_rates (card_id, grader, scraped_at desc);

-- =========================================
-- MARKET_PRICES: nightly/hourly snapshot of pricing per card per grade
-- =========================================
create table market_prices (
  id uuid primary key default uuid_generate_v4(),
  card_id uuid references cards(id) not null,
  source text not null check (source in ('tcgplayer', 'ebay_sold', 'alt')),
  condition text not null, -- 'raw', 'PSA 10', 'PSA 9', 'CGC 10', 'CGC Pristine', etc
  price numeric not null,
  sample_size int default 1, -- number of sales this price is based on (for ebay sold)
  recorded_at timestamptz default now()
);

create index idx_market_prices_card on market_prices (card_id, condition, recorded_at desc);

-- =========================================
-- MARKET_SALES: individual scraped graded-card sale records, from
-- python-services/scrapers/ (130point, PriceCharting, Alt). Insert-only,
-- like gem_rates, so sale history and price trends over time are
-- preserved rather than overwritten.
-- =========================================
create table market_sales (
  id uuid primary key default uuid_generate_v4(),
  card_id uuid references cards(id) not null,
  grader text, -- "PSA", "CGC", "BGS", "SGC", or null for ungraded/raw
  grade text not null, -- e.g. "10", "9.5", "Raw"
  sale_price numeric not null,
  sale_date timestamptz not null,
  source text not null check (source in ('ebay_sold', 'pricecharting', 'alt')),
  source_url text, -- direct link to the actual listing, when the scraper captured one (e.g. Alt.xyz's /itm/{id}); null for older rows or sources that don't expose a stable per-sale URL
  scraped_at timestamptz default now()
);

create index idx_market_sales_card on market_sales (card_id, grader, grade, sale_date desc);

alter table market_sales enable row level security;
create policy "Anyone can read market_sales" on market_sales for select using (true);

-- =========================================
-- GRADER_EVENTS: news/context signals affecting grading decisions
-- =========================================
create table grader_events (
  id uuid primary key default uuid_generate_v4(),
  grader text not null check (grader in ('PSA', 'CGC', 'BGS', 'TAG')),
  event_type text not null check (event_type in ('fee_change', 'turnaround_change', 'reputation', 'promotion', 'other')),
  headline text not null,
  summary text,
  source_url text,
  sentiment text check (sentiment in ('positive', 'negative', 'neutral')),
  published_at timestamptz,
  created_at timestamptz default now()
);

create index idx_grader_events_grader on grader_events (grader, published_at desc);

-- =========================================
-- USERS: extends Supabase auth.users with app-specific fields
-- =========================================
create table user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  subscription_tier text default 'free' check (subscription_tier in ('free', 'pro', 'bulk')),
  scans_used_this_month int default 0,
  scans_reset_at timestamptz default (date_trunc('month', now()) + interval '1 month'),
  stripe_customer_id text,
  terms_accepted_at timestamptz, -- set by handle_new_user() from signup metadata, see below
  created_at timestamptz default now()
);

-- =========================================
-- SCANS: a user's card analysis submissions
-- =========================================
create table scans (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) not null,
  card_id uuid references cards(id),
  image_urls text[] not null default '{}', -- up to 10 labeled photos: full front/back + optional corner close-ups

  -- Vision model output
  vision_centering_pct numeric,    -- e.g. 55/45 stored as 55 (worse of independently-scored front/back)
  vision_surface_score numeric,    -- 1-10
  vision_edge_score numeric,       -- 1-10
  vision_corner_score numeric,     -- 1-10
  vision_overall_score numeric,    -- 1-10 blended
  vision_notes text,
  vision_grade_probs jsonb,        -- {"10": 0.3, "9": 0.45, "8": 0.2, "7_or_below": 0.05}
  worst_zone text,                 -- e.g. "Back Bottom-Right corner", or "none"
  asymmetric_wear_flag boolean default false, -- true if one zone is meaningfully worse than the rest

  -- Final recommendation snapshot (denormalized for history)
  recommendation jsonb,            -- full ranked grader output at time of scan

  created_at timestamptz default now()
);

create index idx_scans_user on scans (user_id, created_at desc);

-- =========================================
-- PORTFOLIO_ITEMS: a user's tracked card holdings, from raw purchase
-- through grading submission to final sale. card_name is free text
-- rather than a `cards` FK -- a portfolio entry shouldn't be blocked by
-- whether that exact card happens to already be in our reference catalog.
-- Estimated grader return date isn't stored here -- it's computed from
-- submission_date + the grader's turnaroundDays (lib/roiEngine.ts's
-- GRADERS config), so there's one source of truth for turnaround times.
-- =========================================
create table portfolio_items (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) not null,

  card_name text not null,
  raw_purchase_price numeric, -- null only for a watchlist item (not bought yet)
  date_bought date,           -- null only for a watchlist item (not bought yet)

  -- 'watchlist' is a target card added from Buy Signals ("Add to
  -- watchlist"), not an actual purchase -- it has no raw_purchase_price/
  -- date_bought yet. target_price holds the max buy price it was
  -- watchlisted at. Converting a watchlist item into a real purchase
  -- moves it to 'raw' and fills in raw_purchase_price/date_bought.
  status text not null default 'raw' check (status in ('watchlist', 'raw', 'submitted', 'graded', 'sold')),
  is_watchlist boolean not null default false,
  target_price numeric, -- max buy price at the time this was watchlisted; null for normal adds

  grader text check (grader in ('PSA', 'CGC', 'BGS', 'TAG')), -- null until submitted
  submission_date date,                                        -- null until submitted
  grade_received text,                                         -- null until graded
  sale_price numeric,                                          -- null until sold

  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  constraint portfolio_items_purchase_fields_check
    check (status = 'watchlist' or (raw_purchase_price is not null and date_bought is not null))
);

create index idx_portfolio_items_user on portfolio_items (user_id, created_at desc);

create or replace function set_portfolio_item_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger portfolio_items_updated_at
  before update on portfolio_items
  for each row execute procedure set_portfolio_item_updated_at();

-- =========================================
-- Row Level Security
-- =========================================
alter table user_profiles enable row level security;
alter table scans enable row level security;
alter table portfolio_items enable row level security;

create policy "Users can view own profile"
  on user_profiles for select using (auth.uid() = id);

create policy "Users can update own profile"
  on user_profiles for update using (auth.uid() = id);

create policy "Users can view own scans"
  on scans for select using (auth.uid() = user_id);

create policy "Users can insert own scans"
  on scans for insert with check (auth.uid() = user_id);

create policy "Users can view own portfolio items"
  on portfolio_items for select using (auth.uid() = user_id);

create policy "Users can insert own portfolio items"
  on portfolio_items for insert with check (auth.uid() = user_id);

create policy "Users can update own portfolio items"
  on portfolio_items for update using (auth.uid() = user_id);

create policy "Users can delete own portfolio items"
  on portfolio_items for delete using (auth.uid() = user_id);

-- Public reference tables stay readable by anyone (cards, gem_rates, market_prices, grader_events)
alter table cards enable row level security;
alter table gem_rates enable row level security;
alter table market_prices enable row level security;
alter table grader_events enable row level security;

create policy "Anyone can read cards" on cards for select using (true);
create policy "Anyone can read gem_rates" on gem_rates for select using (true);
create policy "Anyone can read market_prices" on market_prices for select using (true);
create policy "Anyone can read grader_events" on grader_events for select using (true);

-- =========================================
-- Auto-create user_profiles row on signup
--
-- Reads terms_accepted_at out of the new user's raw_user_meta_data
-- (components/AuthForm.tsx passes it as signUp()'s `options.data`) rather
-- than having the client update user_profiles directly right after
-- signup -- this function runs `security definer` as part of the same
-- transaction that creates the auth.users row, so it isn't blocked by
-- RLS or by there being no active session yet (e.g. while email
-- confirmation is still pending).
-- =========================================
create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.user_profiles (id, terms_accepted_at)
  values (new.id, (new.raw_user_meta_data->>'terms_accepted_at')::timestamptz);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- =========================================
-- increment_scans_used: atomic scan counter increment
-- Called by the scan gating logic in lib/scanGating.ts
-- =========================================
create or replace function increment_scans_used(user_id uuid)
returns void as $$
begin
  update user_profiles
  set scans_used_this_month = scans_used_this_month + 1
  where id = user_id;
end;
$$ language plpgsql security definer;

-- =========================================
-- Storage bucket for card images
-- Run this in the Supabase dashboard -> Storage -> New bucket,
-- OR uncomment the line below and run as SQL (requires storage extension)
-- =========================================
-- insert into storage.buckets (id, name, public) values ('card-images', 'card-images', true);

-- Storage policy: users can upload their own images
-- create policy "Users can upload card images"
--   on storage.objects for insert
--   with check (bucket_id = 'card-images' and auth.uid()::text = (storage.foldername(name))[1]);

-- Storage policy: anyone can read images (they're just card photos)
-- create policy "Card images are publicly readable"
--   on storage.objects for select using (bucket_id = 'card-images');
