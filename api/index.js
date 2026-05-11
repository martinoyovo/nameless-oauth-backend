/**
 * Vercel serverless entry point.
 *
 * vercel.json rewrites every request to /api, which lands here. We import
 * the Express app from server.js and let it handle routing. The default
 * export must be the app itself (not a wrapped function) — `@vercel/node`
 * handles the (req, res) lifecycle.
 *
 * State persistence note: server.js uses an in-memory Map for OAuth state.
 * Vercel functions stay warm for several minutes after invocation, which
 * is longer than the OAuth flow itself (~30s). If a function does cold-
 * start mid-flow, the user gets "Invalid or expired state" and retries —
 * acceptable for low-volume launch. When traffic justifies, swap the
 * Map for Vercel KV (Redis) or move to Supabase Postgres alongside the
 * paid-tier user accounts.
 */
export { default } from '../server.js';
