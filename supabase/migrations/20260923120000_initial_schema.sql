-- De-Jolique Enterprise: initial schema for Supabase Postgres.
--
-- Identity lives in Supabase Auth (auth.users). Everything the store needs about a
-- user (display name, phone, role) lives in public.profiles, created by a trigger.
--
-- Every table has Row Level Security enabled with NO policies: the anon/authenticated
-- roles used by Supabase's auto-generated Data API get no access at all. Only the
-- Express backend (connecting as the database owner) can read or write store data.

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                   uuid primary key references auth.users (id) on delete cascade,
  email                text not null,
  name                 text not null default '' check (char_length(name) <= 100),
  phone                text check (phone is null or char_length(phone) <= 30),
  role                 text not null default 'customer' check (role in ('customer', 'admin')),
  must_change_password boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index profiles_email_idx on public.profiles (lower(email));
create index profiles_role_idx on public.profiles (role);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- New sign-ups get a customer profile. The role is never taken from user metadata,
-- because users can write their own metadata.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, name, phone)
  values (
    new.id,
    coalesce(new.email, ''),
    left(coalesce(new.raw_user_meta_data ->> 'name', ''), 100),
    nullif(left(coalesce(new.raw_user_meta_data ->> 'phone', ''), 30), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.handle_auth_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set email = coalesce(new.email, '') where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function public.handle_auth_user_email_change();

-- Backfill profiles for users that signed up before this migration ran.
insert into public.profiles (id, email, name, phone)
select
  u.id,
  coalesce(u.email, ''),
  left(coalesce(u.raw_user_meta_data ->> 'name', ''), 100),
  nullif(left(coalesce(u.raw_user_meta_data ->> 'phone', ''), 30), '')
from auth.users u
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------
create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 80),
  slug        text not null unique,
  description text not null default '' check (char_length(description) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index categories_name_key on public.categories (lower(name));

create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();

create table public.products (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 2 and 160),
  slug        text not null unique,
  description text not null check (char_length(description) between 10 and 5000),
  price       numeric(12, 2) not null check (price > 0),
  category_id uuid references public.categories (id) on delete set null,
  -- Stock can never go negative, even if application code has a bug.
  stock       integer not null default 0 check (stock >= 0),
  images      jsonb not null default '[]'::jsonb check (jsonb_typeof(images) = 'array'),
  featured    boolean not null default false,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index products_name_trgm_idx on public.products using gin (name extensions.gin_trgm_ops);
create index products_category_idx on public.products (category_id);
create index products_created_at_idx on public.products (created_at desc);
create index products_price_idx on public.products (price);
create index products_featured_idx on public.products (featured) where is_active;
create index products_stock_idx on public.products (stock);

create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
create sequence public.order_number_seq start 1001;

create table public.orders (
  id                  uuid primary key default gen_random_uuid(),
  order_number        text not null unique
                        default ('JQ-' || lpad(nextval('public.order_number_seq')::text, 6, '0')),
  -- Kept (as NULL) if the customer account is deleted, so financial records survive.
  user_id             uuid references public.profiles (id) on delete set null,
  shipping_address    jsonb not null,
  payment_method      text not null check (payment_method in ('paystack', 'flutterwave')),
  payment_reference   text,
  payment_status      text not null default 'pending'
                        check (payment_status in ('pending', 'paid', 'failed', 'refunded')),
  order_status        text not null default 'pending'
                        check (order_status in ('pending', 'processing', 'shipped', 'delivered', 'cancelled')),
  subtotal            numeric(12, 2) not null check (subtotal >= 0),
  shipping_fee        numeric(12, 2) not null default 0 check (shipping_fee >= 0),
  total_amount        numeric(12, 2) not null check (total_amount > 0),
  currency            char(3) not null,
  inventory_committed boolean not null default false,
  requires_attention  boolean not null default false,
  admin_note          text,
  paid_at             timestamptz,
  delivered_at        timestamptz,
  cancelled_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index orders_user_created_idx on public.orders (user_id, created_at desc);
create index orders_order_status_idx on public.orders (order_status);
create index orders_payment_status_idx on public.orders (payment_status);
create index orders_created_at_idx on public.orders (created_at desc);
create index orders_payment_reference_idx on public.orders (payment_reference);

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

create table public.order_items (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders (id) on delete cascade,
  -- Snapshot fields below keep the order readable if the product is later deleted.
  product_id uuid references public.products (id) on delete set null,
  name       text not null,
  image      text,
  price      numeric(12, 2) not null check (price >= 0),
  quantity   integer not null check (quantity > 0),
  subtotal   numeric(12, 2) not null check (subtotal >= 0)
);

create index order_items_order_idx on public.order_items (order_id);
create index order_items_product_idx on public.order_items (product_id);

create table public.order_status_history (
  id         bigint generated always as identity primary key,
  order_id   uuid not null references public.orders (id) on delete cascade,
  status     text not null,
  note       text,
  changed_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index order_status_history_order_idx on public.order_status_history (order_id, created_at);

-- ---------------------------------------------------------------------------
-- Payments (one row per payment attempt / provider reference)
-- ---------------------------------------------------------------------------
create table public.payments (
  id                      uuid primary key default gen_random_uuid(),
  order_id                uuid not null references public.orders (id) on delete cascade,
  user_id                 uuid references public.profiles (id) on delete set null,
  provider                text not null check (provider in ('paystack', 'flutterwave')),
  -- Our reference (Paystack reference / Flutterwave tx_ref). Unique => a payment
  -- can only ever be recorded once.
  reference               text not null unique,
  provider_transaction_id text,
  amount                  numeric(12, 2) not null check (amount > 0),
  amount_paid             numeric(12, 2),
  currency                char(3) not null,
  status                  text not null default 'initialized'
                            check (status in ('initialized', 'pending', 'success', 'failed', 'refunded')),
  gateway_response        text,
  channel                 text,
  note                    text,
  raw                     jsonb,
  paid_at                 timestamptz,
  verified_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index payments_order_idx on public.payments (order_id);
create index payments_status_idx on public.payments (status);
create index payments_created_at_idx on public.payments (created_at desc);

create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Lock the tables away from the public Data API.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_status_history enable row level security;
alter table public.payments enable row level security;

-- Trigger helpers live in public, which Supabase exposes over its API; make sure the
-- API roles can never execute them directly.
revoke execute on function public.set_updated_at() from public;
revoke execute on function public.handle_new_auth_user() from public;
revoke execute on function public.handle_auth_user_email_change() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function public.set_updated_at(), public.handle_new_auth_user(),
             public.handle_auth_user_email_change() from anon, authenticated';
  end if;
end;
$$;
