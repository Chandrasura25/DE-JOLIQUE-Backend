import { parseArgs } from 'node:util';
import { closeDatabase } from '../config/db.js';
import { upsertAdminUser } from '../services/authService.js';

/**
 * Creates the store's admin, or promotes an existing Supabase user to admin.
 * The store has exactly one admin; --replace hands the role over (the current
 * admin becomes a customer).
 *
 *   npm run create-admin -- --email you@example.com --password "Str0ngPass!" --name "Your Name" [--replace]
 *
 * New admins must change their password on first login.
 */
const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    password: { type: 'string' },
    name: { type: 'string', default: 'Store Admin' },
    replace: { type: 'boolean', default: false },
  },
});

async function main() {
  if (!values.email || !values.password) {
    throw new Error('Usage: npm run create-admin -- --email you@example.com --password "Str0ngPass!" [--name "Your Name"] [--replace]');
  }
  const pw = values.password;
  const rules = [/[a-z]/, /[A-Z]/, /[0-9]/, /[!@#$%^&*()_+\-=[\]{};'\\:"|<>?,./`~]/];
  if (pw.length < 8 || !rules.every((rule) => rule.test(pw))) {
    throw new Error('Password must be at least 8 characters and contain an uppercase letter, a lowercase letter, a number and a special character.');
  }
  const { profile, created, replaced } = await upsertAdminUser({
    email: values.email,
    password: values.password,
    name: values.name,
    mustChangePassword: true,
    replace: values.replace,
  });
  if (replaced) console.log(`${replaced.email} is no longer the admin (now a customer).`);
  console.log(
    created
      ? `Created admin ${profile.email}. They must change the password on first login.`
      : `${profile.email} already existed and is now an admin (password unchanged).`,
  );
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
