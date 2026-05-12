import express from 'express';
import crypto from 'crypto';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3000;

const NOTION_CLIENT_ID = process.env.NOTION_CLIENT_ID;
const NOTION_CLIENT_SECRET = process.env.NOTION_CLIENT_SECRET;
const NOTION_REDIRECT_URI = process.env.NOTION_REDIRECT_URI;

// Identify which env vars are missing without crashing the process.
// Previously this called `process.exit(1)`, which is fine for local dev
// (the operator sees the error and re-runs) but catastrophic on Vercel:
// every cold start with missing/incorrectly-typed env vars produces a
// FUNCTION_INVOCATION_FAILED 500 with no useful information for the
// operator. Now we log on load and return a clear 503 from each route.
const missingEnvVars = ['NOTION_CLIENT_ID', 'NOTION_CLIENT_SECRET', 'NOTION_REDIRECT_URI']
  .filter((name) => !process.env[name]);

if (missingEnvVars.length > 0) {
  console.error('[BOOT] Missing required environment variables:', missingEnvVars.join(', '));
  console.error('[BOOT] Set them in Vercel: Project → Settings → Environment Variables, then redeploy.');
}

// Express middleware — guards every endpoint. If config isn't ready, return
// 503 with the missing names rather than letting the route handler explode.
function requireEnv(_req, res, next) {
  if (missingEnvVars.length > 0) {
    return res.status(503).json({
      ok: false,
      error: 'OAuth backend is misconfigured.',
      missingEnvVars,
      hint: 'See Vercel Project Settings → Environment Variables, then redeploy.',
    });
  }
  next();
}

// In-memory storage for OAuth states and tokens.
// Format: { state: { createdAt: number, tokenResponse?: object, error?: string } }
const stateStore = new Map();

// Cleanup expired states every 5 minutes.
// State values are session bearers for /poll. Never log them in full.
const redactState = (s) => (typeof s === 'string' && s.length > 6) ? `${s.slice(0, 4)}…${s.slice(-2)}` : '****';

const STATE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

// Skip the periodic cleanup interval on Vercel — serverless functions are
// short-lived, the timer wastes a slot in the event loop and can keep the
// runtime alive past a request. Local dev keeps it.
if (!process.env.VERCEL) {
  setInterval(() => {
    const now = Date.now();
    for (const [state, data] of stateStore.entries()) {
      if (now - data.createdAt > STATE_EXPIRY_MS) {
        stateStore.delete(state);
        console.log(`Expired state: ${redactState(state)}`);
      }
    }
  }, 5 * 60 * 1000);
}

// Renders an OAuth callback page (success or error) in a style that
// mirrors the Google sign-in callback page in nameless-frontend at
// electron/auth/googleSigninServer.ts. Keep both sides in sync if the
// look ever changes.
function renderCallbackPage({ status, title, message }) {
  const isError = status === 'error';
  const iconChar = isError ? '!' : '✓';
  const iconBg = isError ? '#ffebe9' : '#dafbe1';
  const iconColor = isError ? '#cf222e' : '#1a7f37';
  const iconBgDark = isError ? '#67060c' : '#033a16';
  const iconColorDark = isError ? '#ff7b72' : '#56d364';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  body { margin: 0; padding: 40px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #f6f7f8; color: #1f2328; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: #fff; padding: 32px 40px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.05); text-align: center; max-width: 360px; }
  h1 { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
  p { margin: 0; font-size: 14px; color: #57606a; line-height: 1.5; }
  .icon { width: 48px; height: 48px; border-radius: 50%; background: ${iconBg}; color: ${iconColor};
    display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px; font-size: 24px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #f0f6fc; }
    .card { background: #161b22; box-shadow: none; }
    p { color: #8b949e; }
    .icon { background: ${iconBgDark}; color: ${iconColorDark}; }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${iconChar}</div>
    <h1>${esc(title)}</h1>
    <p>${esc(message)}</p>
  </div>
</body>
</html>`;
}

app.use(express.json());
// Apply env guard to every OAuth route. Health check at `/` stays open
// so you can curl it and see "ok: true" even before envs are set.
app.use('/oauth', requireEnv);

// Health check. Stays open even when env vars are missing so the operator
// can curl this endpoint and see exactly what's wrong without crawling the
// Vercel dashboard.
app.get('/', (req, res) => {
  res.json({
    ok: missingEnvVars.length === 0,
    service: 'Margin OAuth Server',
    configured: missingEnvVars.length === 0,
    missingEnvVars: missingEnvVars.length > 0 ? missingEnvVars : undefined,
    endpoints: [
      'POST /oauth/notion/start (body: { verifier_hash })',
      'GET  /oauth/notion/callback',
      'POST /oauth/notion/poll  (body: { state, verifier })',
      'POST /oauth/notion/cancel (body: { state })',
    ]
  });
});

// Simple in-memory rate limit for /poll — defends against brute-force enumeration
// of state values. 60 requests / 60s per IP is more than enough for a 1Hz poll.
const pollAttempts = new Map(); // ip -> { count, windowStart }
const POLL_WINDOW_MS = 60_000;
const POLL_MAX_PER_WINDOW = 60;
function rateLimitPoll(req, res) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
  const now = Date.now();
  const entry = pollAttempts.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > POLL_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  pollAttempts.set(ip, entry);
  if (entry.count > POLL_MAX_PER_WINDOW) {
    res.status(429).json({ ok: false, error: 'Too many poll requests' });
    return false;
  }
  return true;
}
// Periodically prune old IP entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of pollAttempts.entries()) {
    if (now - entry.windowStart > POLL_WINDOW_MS) pollAttempts.delete(ip);
  }
}, POLL_WINDOW_MS);

// 1. OAuth start endpoint — POST so the verifier_hash isn't logged in URLs.
// PKCE-style: client commits to a verifier (kept secret); only a SHA-256 of it
// is sent here. /poll later requires the plaintext verifier to release the token.
// This binds the issued token to the originating client even if `state` leaks.
app.post('/oauth/notion/start', express.json(), (req, res) => {
  try {
    const { verifier_hash } = req.body || {};
    if (typeof verifier_hash !== 'string' || !/^[a-f0-9]{64}$/i.test(verifier_hash)) {
      return res.status(400).json({
        ok: false,
        error: 'Missing or invalid verifier_hash (expected 64-char hex SHA-256)'
      });
    }

    const state = crypto.randomBytes(32).toString('hex');

    stateStore.set(state, {
      createdAt: Date.now(),
      verifierHash: verifier_hash.toLowerCase(),
    });

    const authorizeUrl = new URL('https://api.notion.com/v1/oauth/authorize');
    authorizeUrl.searchParams.set('client_id', NOTION_CLIENT_ID);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('owner', 'user');
    authorizeUrl.searchParams.set('redirect_uri', NOTION_REDIRECT_URI);
    authorizeUrl.searchParams.set('state', state);

    console.log(`[START] Generated state: ${redactState(state)}`);
    console.log(`[START] Authorize URL prepared (state redacted)`);

    res.json({
      ok: true,
      state,
      authorizeUrl: authorizeUrl.toString()
    });
  } catch (error) {
    console.error('[START] Error:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'Failed to start OAuth flow'
    });
  }
});

// New endpoint: Mark state as cancelled when user closes tab
app.post('/oauth/notion/cancel', express.json(), (req, res) => {
  const { state } = req.body;

  if (!state) {
    return res.status(400).json({ ok: false, error: 'Missing state' });
  }

  const stateData = stateStore.get(state);
  if (stateData && !stateData.tokenResponse && !stateData.error) {
    console.log(`[CANCEL] User closed tab for state: ${redactState(state)}`);
    stateData.error = 'Authorization was cancelled';
  }

  res.json({ ok: true });
});

// 2. OAuth callback endpoint
app.get('/oauth/notion/callback', async (req, res) => {
  const { code, state, error: oauthError, error_description: errorDescription } = req.query;

  console.log(`[CALLBACK] Received callback - state: ${redactState(state)}, code: ${!!code}, error: ${oauthError}`);

  // Check for OAuth errors
  if (oauthError) {
    console.error(`[CALLBACK] OAuth error: ${oauthError}, description: ${errorDescription}`);

    // Map error codes to user-friendly messages
    let userMessage = 'Authorization failed';
    if (oauthError === 'access_denied') {
      userMessage = 'You denied access to Notion. Please try again and click "Allow" to connect your Apple Notes.';
    } else if (errorDescription) {
      userMessage = errorDescription;
    } else {
      userMessage = oauthError;
    }

    if (stateStore.has(state)) {
      stateStore.get(state).error = userMessage;
    }

    res.status(400).send(renderCallbackPage({
      status: 'error',
      title: 'Authorization failed',
      message: `${userMessage} Try again from the app.`,
    }));
    return;
  }

  // Validate state
  if (!state || !stateStore.has(state)) {
    console.error(`[CALLBACK] Invalid state: ${state}`);
    res.status(400).send(renderCallbackPage({
      status: 'error',
      title: 'Invalid request',
      message: 'Invalid or expired state. Try again from the app.',
    }));
    return;
  }

  if (!code) {
    console.error('[CALLBACK] Missing code');
    stateStore.get(state).error = 'Missing authorization code';
    res.status(400).send(renderCallbackPage({
      status: 'error',
      title: 'Missing code',
      message: 'Authorization code is missing. Try again from the app.',
    }));
    return;
  }

  // Exchange code for token
  try {
    const credentials = Buffer.from(`${NOTION_CLIENT_ID}:${NOTION_CLIENT_SECRET}`).toString('base64');

    console.log('[CALLBACK] Exchanging code for token...');
    const tokenResponse = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${credentials}`,
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: NOTION_REDIRECT_URI,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error(`[CALLBACK] Token exchange failed: ${errorText}`);
      throw new Error(`Token exchange failed: ${errorText}`);
    }

    const tokenData = await tokenResponse.json();
    console.log('[CALLBACK] Token exchange successful');

    // Store token response
    stateStore.get(state).tokenResponse = tokenData;

    // Return success page
    res.send(renderCallbackPage({
      status: 'success',
      title: 'Connected to Notion',
      message: 'You can close this tab and return to the app.',
    }));
  } catch (error) {
    console.error('[CALLBACK] Error during token exchange:', error);
    const errMsg = error.message || 'Failed to exchange authorization code for token.';
    stateStore.get(state).error = errMsg;

    res.status(500).send(renderCallbackPage({
      status: 'error',
      title: 'Connection failed',
      message: `${errMsg} Try again from the app.`,
    }));
  }
});

// 3. Poll endpoint — POST so the verifier isn't logged in URLs.
// Requires the plaintext PKCE verifier; we hash it and compare to the
// hash committed at /start. This means even if `state` leaks (proxy logs,
// shoulder-surf, race), the token can't be redeemed without the verifier.
app.post('/oauth/notion/poll', express.json(), (req, res) => {
  if (!rateLimitPoll(req, res)) return;

  const { state, verifier } = req.body || {};

  if (typeof state !== 'string' || !state) {
    return res.status(400).json({ ok: false, error: 'Missing state' });
  }
  if (typeof verifier !== 'string' || !verifier) {
    return res.status(400).json({ ok: false, error: 'Missing verifier' });
  }

  const stateData = stateStore.get(state);

  if (!stateData) {
    return res.json({
      ok: false,
      error: 'Invalid or expired state'
    });
  }

  // Verify the PKCE proof. Constant-time compare to avoid timing leaks.
  const computedHash = crypto.createHash('sha256').update(verifier).digest('hex');
  const storedHash = stateData.verifierHash || '';
  const equalLen = computedHash.length === storedHash.length;
  let match = equalLen;
  if (equalLen) {
    try {
      match = crypto.timingSafeEqual(Buffer.from(computedHash, 'hex'), Buffer.from(storedHash, 'hex'));
    } catch {
      match = false;
    }
  }
  if (!match) {
    console.warn(`[POLL] Verifier mismatch for state ${redactState(state)}`);
    return res.status(403).json({ ok: false, error: 'Invalid verifier' });
  }

  // Check if token is ready
  if (stateData.tokenResponse) {
    console.log(`[POLL] Token ready for state: ${redactState(state)}`);
    const tokenResponse = stateData.tokenResponse;
    // Delete the state entry (one-time handoff)
    stateStore.delete(state);
    return res.json({
      ok: true,
      ready: true,
      tokenResponse
    });
  }

  // Check if there was an error
  if (stateData.error) {
    console.log(`[POLL] Error for state ${redactState(state)}: ${stateData.error}`);
    const error = stateData.error;
    stateStore.delete(state);
    return res.json({
      ok: false,
      error
    });
  }

  // Not ready yet
  return res.json({
    ok: true,
    ready: false
  });
});

// ── Entry points ─────────────────────────────────────────────────────────
//
// Local dev: `node server.js` listens on PORT.
// Production (Vercel): the platform imports the default export and routes
// requests through the Express app — there's no listen() in serverless.
//
// We detect "running directly" by checking if this file is the entry
// process. If imported (e.g. by `@vercel/node`), we just export the app.
//
// Vercel routes everything to api/index.js (see vercel.json + that file),
// which re-exports this app.

import { fileURLToPath } from 'url';
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  app.listen(PORT, () => {
    console.log('');
    console.log('═══════════════════════════════════════════════════');
    console.log('  Margin OAuth Server (Apple Notes → Notion)');
    console.log('═══════════════════════════════════════════════════');
    console.log(`  Running on: http://localhost:${PORT}`);
    console.log('');
    console.log('  Endpoints:');
    console.log(`    POST /oauth/notion/start    - Start OAuth flow (PKCE verifier_hash required)`);
    console.log(`    GET  /oauth/notion/callback - OAuth callback`);
    console.log(`    POST /oauth/notion/poll     - Poll for token (PKCE verifier required)`);
    console.log(`    POST /oauth/notion/cancel   - User cancelled in browser`);
    console.log('');
    console.log('  Environment:');
    console.log(`    NOTION_CLIENT_ID: ${NOTION_CLIENT_ID ? '✓' : '✗'}`);
    console.log(`    NOTION_CLIENT_SECRET: ${NOTION_CLIENT_SECRET ? '✓' : '✗'}`);
    console.log(`    NOTION_REDIRECT_URI: ${NOTION_REDIRECT_URI || '✗'}`);
    console.log('');
    console.log('  Local dev: ngrok http 3000 + update NOTION_REDIRECT_URI');
    console.log('  Production: deploy to Vercel — see oauth-backend/DEPLOY.md');
    console.log('═══════════════════════════════════════════════════');
  });
}

export default app;
