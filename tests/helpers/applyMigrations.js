import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations');

/**
 * Test-only: applies the real Supabase CLI migrations (supabase/migrations/*.sql)
 * to a plain Postgres instance. Supabase-managed schemas the migrations depend on
 * (auth.users, storage.buckets) are stubbed with the columns we use.
 */
export async function applySupabaseMigrations(pool) {
  await pool.query(`
    create schema if not exists auth;
    create table if not exists auth.users (
      id uuid primary key default gen_random_uuid(),
      email text,
      raw_user_meta_data jsonb not null default '{}'::jsonb,
      raw_app_meta_data jsonb not null default '{"providers": ["email"]}'::jsonb,
      email_confirmed_at timestamptz default now(),
      last_sign_in_at timestamptz
    );
    create schema if not exists storage;
    create table if not exists storage.buckets (
      id text primary key,
      name text not null,
      public boolean,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
  `);

  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    try {
      await pool.query(sql);
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
  }
  return files;
}
