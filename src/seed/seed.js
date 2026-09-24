import env, { isProduction } from '../config/env.js';
import { pool, closeDatabase, withTransaction } from '../config/db.js';
import { upsertAdminUser } from '../services/authService.js';
import { slugify } from '../utils/helpers.js';
import { categories, products } from './data.js';

/**
 * npm run seed        -> adds sample categories/products (skips ones that exist) and the admin account
 * npm run seed:reset  -> deletes ALL orders, payments, products and categories first (not users)
 */
const reset = process.argv.includes('--reset');
const force = process.argv.includes('--force');

async function main() {
  if (reset && isProduction && !force) {
    throw new Error('Refusing to reset a production database. Pass --force if you really mean it.');
  }

  const { rows } = await pool.query("select to_regclass('public.products') is not null as ready");
  if (!rows[0].ready) throw new Error('Tables not found. Run the migrations first: npx supabase db push');

  await withTransaction(async (client) => {
    if (reset) {
      console.log('Resetting store data (orders, payments, products, categories)...');
      await client.query(
        'truncate public.payments, public.order_status_history, public.order_items, public.orders, public.products, public.categories',
      );
    }

    const categoryIds = {};
    for (const c of categories) {
      const res = await client.query(
        `insert into public.categories (name, slug, description) values ($1, $2, $3)
         on conflict (slug) do update set slug = excluded.slug
         returning id`,
        [c.name, c.slug, c.description],
      );
      categoryIds[c.slug] = res.rows[0].id;
    }
    console.log(`Categories ready: ${categories.length}`);

    let created = 0;
    for (const p of products) {
      const res = await client.query(
        `insert into public.products (name, slug, description, price, category_id, stock, images, featured)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         on conflict (slug) do nothing`,
        [p.name, slugify(p.name), p.description, p.price, categoryIds[p.category], p.stock, JSON.stringify(p.images),
          Boolean(p.featured)],
      );
      created += res.rowCount;
    }
    console.log(`Products created: ${created} (${products.length - created} already existed)`);
  });

  let result;
  try {
    result = await upsertAdminUser({
      email: env.ADMIN_EMAIL,
      password: env.ADMIN_PASSWORD,
      name: env.ADMIN_NAME,
      mustChangePassword: true,
    });
  } catch (err) {
    if (err.code === 'ADMIN_EXISTS') {
      console.log('\nAdmin account');
      console.log(`  ${err.adminEmail} is already the admin (the store has only one); ADMIN_EMAIL was not added.`);
      return;
    }
    throw new Error(
      `Catalogue seeded, but the admin account could not be created in Supabase Auth (${err.message}). ` +
        'Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in server/.env, then run npm run seed again.',
    );
  }
  const { profile, created } = result;

  console.log('\nAdmin account');
  console.log(`  email:    ${profile.email}`);
  if (created) {
    console.log(`  password: ${env.ADMIN_PASSWORD}`);
    console.log('  You will be asked to change this password on first login at /admin/login.');
  } else {
    console.log('  (already existed — password unchanged; role set to admin)');
  }
}

main()
  .then(() => console.log('\nSeed complete.'))
  .catch((err) => {
    console.error(`Seed failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
