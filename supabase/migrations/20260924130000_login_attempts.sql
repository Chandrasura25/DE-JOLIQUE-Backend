-- Failed password logins, used to throttle password guessing per account and per IP.
-- Kept in the database (not in memory) so the limit holds across every serverless
-- instance. Rows older than a day are purged by the daily cron.
create table public.login_attempts (
  id         bigint generated always as identity primary key,
  email      text not null,
  ip         inet,
  created_at timestamptz not null default now()
);

create index login_attempts_email_idx on public.login_attempts (email, created_at desc);
create index login_attempts_ip_idx on public.login_attempts (ip, created_at desc);

-- Same rule as every other table: no access through Supabase's public Data API.
alter table public.login_attempts enable row level security;
