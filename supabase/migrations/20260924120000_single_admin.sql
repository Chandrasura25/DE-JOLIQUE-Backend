-- The store has exactly one admin account. Enforced in the database so no path
-- (seed, create-admin, the API, the SQL editor) can create a second one: at most one
-- profiles row may have role = 'admin'.
create unique index profiles_single_admin_idx on public.profiles (role) where role = 'admin';
