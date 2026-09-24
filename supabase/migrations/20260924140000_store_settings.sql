-- Store-wide settings the admin edits from the dashboard (Admin -> Store settings).
-- Exactly one row: the boolean primary key can only ever be true.
create table public.store_settings (
  id             boolean primary key default true check (id),
  support_email  text not null default '' check (char_length(support_email) <= 254),
  support_phone  text not null default '' check (char_length(support_phone) <= 30),
  postal_address text not null default '' check (char_length(postal_address) <= 300),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references public.profiles (id) on delete set null
);

insert into public.store_settings (id) values (true) on conflict (id) do nothing;

create trigger store_settings_set_updated_at
  before update on public.store_settings
  for each row execute function public.set_updated_at();

-- Same rule as every other table: no access through Supabase's public Data API.
alter table public.store_settings enable row level security;
