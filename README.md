# Margin OAuth backend

Express server that handles Notion OAuth on behalf of the Margin desktop
app. Deployed to Vercel for production. Runs locally with ngrok only if
you want to debug the Express code with breakpoints (not the default
workflow, the desktop app talks to the deployed staging environment
during development).

This repo is intentionally separate from the desktop app repo. The two
are loosely coupled: they only share URLs. Updates to OAuth flow that
require coordination (e.g. PKCE protocol changes) are shipped as a
backend deploy + a new desktop release.

For deployment instructions, see **[DEPLOY.md](./DEPLOY.md)**.

## Local development

1. **Install dependencies:**
   ```bash
   cd oauth-backend
   npm install
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```

   Edit `.env` and add your Notion OAuth credentials:
   - `NOTION_CLIENT_ID`: from https://www.notion.so/my-integrations
   - `NOTION_CLIENT_SECRET`: from the same page
   - Leave `NOTION_REDIRECT_URI` blank for now. We set it after ngrok starts.

3. **Start the server:**
   ```bash
   npm start
   ```

   Runs on `http://localhost:3000` by default.

4. **Start ngrok in a separate terminal:**
   ```bash
   ngrok http 3000
   ```

   Copy the HTTPS forwarding URL (e.g. `https://abc123.ngrok.io`).

5. **Update the Notion integration redirect URI:**
   - https://www.notion.so/my-integrations → your integration → "OAuth Domain & URIs"
   - Set redirect URI to:
     ```
     https://YOUR_NGROK_DOMAIN.ngrok.io/oauth/notion/callback
     ```
   - Update your `.env` to match:
     ```
     NOTION_REDIRECT_URI=https://YOUR_NGROK_DOMAIN.ngrok.io/oauth/notion/callback
     ```
   - Restart the server (`npm start`).

## Endpoints

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/oauth/notion/start` | `{ verifier_hash }` | Start OAuth flow. PKCE-style; client commits to a verifier hash. Returns `{ state, authorizeUrl }`. |
| `GET`  | `/oauth/notion/callback` | (none) | OAuth callback. Set as redirect URI in Notion integration settings. |
| `POST` | `/oauth/notion/poll` | `{ state, verifier }` | Poll for token. Server hashes verifier and constant-time-compares to the stored hash before releasing the token. Rate limited to 60 requests / 60s per IP. |
| `POST` | `/oauth/notion/cancel` | `{ state }` | Mark a flow as cancelled (e.g. user closed the browser tab). |

## Security model

- **PKCE-style binding**: `state` alone is insufficient to redeem a token.
  The client must also present the plaintext `verifier` whose SHA-256 was
  committed at `/start`. State leaks (proxy logs, shoulder-surf, race) do
  not give an attacker the token.
- **State expiry**: 10 minutes. Tokens are deleted after first poll.
- **Rate limit**: 60 poll requests per IP per minute. Defends against
  brute-force enumeration of state values.
- **State redaction**: state values are never logged in full.

## Troubleshooting

**"Invalid or expired state"**: state expired (10 min timeout) or a
serverless cold start lost the in-memory map. Start a fresh OAuth flow.

**"Invalid verifier"**: the verifier sent on `/poll` doesn't match the
hash committed at `/start`. Always start the flow fresh; verifiers are
single-use.

**"Missing or incomplete Client ID"**: check `NOTION_CLIENT_ID` is set
in `.env` (or in Vercel env for production). Restart the server.

**Notion shows "Redirect URI mismatch"**: the redirect URI in the Notion
integration settings must exactly match `NOTION_REDIRECT_URI` in `.env`,
including `https://` and `/oauth/notion/callback`. ngrok domains change
on restart unless you have a paid static domain.
