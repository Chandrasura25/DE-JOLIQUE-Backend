import { query } from '../config/db.js';
import { supabaseAdmin } from '../config/supabase.js';
import AppError from '../utils/AppError.js';
import { escapeLike, paginationMeta } from '../utils/helpers.js';

// Sign-in details (last login, providers, email confirmation) live in Supabase's
// auth.users, which the API can read because it connects as the database owner.
const USER_SELECT = `
  select p.id, p.name, p.email, p.phone, p.role, p.must_change_password, p.created_at,
         u.last_sign_in_at, u.email_confirmed_at,
         coalesce(u.raw_app_meta_data -> 'providers', '[]'::jsonb) as providers,
         (select count(*)::int from public.orders o where o.user_id = p.id) as order_count
    from public.profiles p
    left join auth.users u on u.id = p.id`;

function toAdminUserDto(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    mustChangePassword: row.must_change_password,
    providers: Array.isArray(row.providers) ? row.providers : [],
    emailConfirmed: Boolean(row.email_confirmed_at),
    lastSignInAt: row.last_sign_in_at,
    orderCount: row.order_count,
    createdAt: row.created_at,
  };
}

export async function listUsersForAdmin({ page, limit, role, search }) {
  const where = [];
  const params = [];
  if (role) {
    params.push(role);
    where.push(`p.role = $${params.length}`);
  }
  if (search) {
    params.push(`%${escapeLike(search)}%`);
    where.push(`(p.name ilike $${params.length} or p.email ilike $${params.length} or p.phone ilike $${params.length})`);
  }
  const whereSql = where.length ? `where ${where.join(' and ')}` : '';

  const [{ rows }, count] = await Promise.all([
    query(`${USER_SELECT} ${whereSql} order by p.created_at desc limit $${params.length + 1} offset $${params.length + 2}`, [
      ...params,
      limit,
      (page - 1) * limit,
    ]),
    query(`select count(*)::int as total from public.profiles p ${whereSql}`, params),
  ]);

  return { users: rows.map(toAdminUserDto), pagination: paginationMeta(page, limit, count.rows[0].total) };
}

/**
 * Deletes the account from Supabase Auth; the profile goes with it (on delete cascade).
 * Orders and payments stay, detached from the user, so financial records survive.
 */
export async function deleteUserForAdmin(id) {
  const { rows } = await query('select id, email, role from public.profiles where id = $1', [id]);
  if (!rows[0]) throw AppError.notFound('User not found.');
  // The store has exactly one admin; deleting it would lock everyone out of the dashboard.
  if (rows[0].role === 'admin') throw AppError.badRequest('The admin account can’t be deleted.');

  const { error } = await supabaseAdmin.auth.admin.deleteUser(id);
  if (error && error.status !== 404) {
    throw AppError.unavailable('Unable to delete this user right now. Please try again.');
  }
  // Covers a profile whose auth user was already gone.
  await query('delete from public.profiles where id = $1', [id]);
  return rows[0];
}
