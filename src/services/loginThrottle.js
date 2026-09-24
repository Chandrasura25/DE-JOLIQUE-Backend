import net from 'node:net';
import { query } from '../config/db.js';
import AppError from '../utils/AppError.js';

// Password-guessing limits, shared by every instance of the API.
const WINDOW_MINUTES = 15;
const MAX_FAILURES_PER_EMAIL = 10;
const MAX_FAILURES_PER_IP = 50;

const clientIp = (req) => (net.isIP(req.ip || '') ? req.ip : null);

/** Throws 429 when this account or this IP has failed too often recently. */
export async function assertLoginAllowed(email, req) {
  const { rows } = await query(
    `select
       count(*) filter (where email = $1)::int as by_email,
       count(*) filter (where $2::inet is not null and ip = $2::inet)::int as by_ip
     from public.login_attempts
     where created_at > now() - make_interval(mins => $3)
       and (email = $1 or ($2::inet is not null and ip = $2::inet))`,
    [email, clientIp(req), WINDOW_MINUTES],
  );
  const { by_email: byEmail, by_ip: byIp } = rows[0];
  if (byEmail >= MAX_FAILURES_PER_EMAIL || byIp >= MAX_FAILURES_PER_IP) {
    throw new AppError(
      `Too many failed attempts. Please wait ${WINDOW_MINUTES} minutes, or reset your password.`,
      429,
    );
  }
}

export async function recordLoginFailure(email, req) {
  await query('insert into public.login_attempts (email, ip) values ($1, $2)', [email, clientIp(req)]);
}

/** A successful login clears the account's failure count. */
export async function clearLoginFailures(email) {
  await query('delete from public.login_attempts where email = $1', [email]);
}

export async function purgeOldLoginAttempts() {
  const { rowCount } = await query(`delete from public.login_attempts where created_at < now() - interval '1 day'`);
  return rowCount;
}
