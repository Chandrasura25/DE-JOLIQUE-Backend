import { createApp } from '../src/app.js';

// Vercel entry point (see vercel.json): the Express app handles every request as a
// serverless function. Local and long-running hosts use src/index.js instead, which
// also runs the abandoned-order sweep on a timer; on Vercel, Vercel Cron calls
// /api/cron/expire-orders for that.
export default createApp();
