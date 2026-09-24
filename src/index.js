import env from './config/env.js';
import { checkDatabaseConnection, closeDatabase, query } from './config/db.js';
import { createApp } from './app.js';
import { expireStalePendingOrders } from './services/paymentService.js';

async function start() {
  try {
    const db = await checkDatabaseConnection();
    console.log(`Connected to Postgres database "${db.db}"`);
  } catch (err) {
    console.error(`Could not connect to the database: ${err.message}`);
    console.error('Check DATABASE_URL in server/.env (use your Supabase connection string).');
    process.exit(1);
  }

  const { rows } = await query("select to_regclass('public.orders') is not null as ready");
  if (!rows[0].ready) {
    console.error('Database tables are missing. Run the Supabase migrations first: npx supabase db push');
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`API listening on ${env.SERVER_URL} (port ${env.PORT}, ${env.NODE_ENV})`);
  });

  // Housekeeping: cancel abandoned unpaid orders (after checking with the provider).
  const sweep = () =>
    expireStalePendingOrders()
      .then((n) => n && console.log(`Expired ${n} unpaid order(s).`))
      .catch((err) => console.error('Order expiry job failed:', err.message));
  const timer = setInterval(sweep, 30 * 60 * 1000);
  timer.unref();

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down...`);
    clearInterval(timer);
    server.close(async () => {
      await closeDatabase().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

start();
