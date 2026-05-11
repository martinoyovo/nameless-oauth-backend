# Margin OAuth backend

The OAuth proxy that exchanges Notion authorization codes for tokens on
behalf of Margin, the macOS app that syncs Apple Notes to Notion.

This repo is open-source on purpose. Margin claims your note content
stays on your Mac and we never see it. That claim is only meaningful if
you can verify it. This is one of the places to look.

## What this server does (and doesn't)

**Does:**
- Receive a Notion `code` after the user authorizes Margin in their browser
- Exchange the code for an access token via Notion's OAuth API
- Hand the token back to the Margin desktop app, once, over HTTPS
- Forget the token immediately after handoff

**Doesn't:**
- See, parse, store, or transmit any of your note content
- Keep tokens longer than the handoff (a few seconds, in memory)
- Run AI on anything
- Have a database

The desktop app talks directly to Notion's API after this handoff. The
OAuth backend is involved for ~10 seconds during the initial connect
flow, and never again.

## Security model

- **PKCE-style state binding.** Even if the `state` value leaks (proxy
  logs, shoulder-surf, race condition), an attacker can't redeem the
  token. The client commits to a SHA-256 of a random verifier when
  starting the flow and must present the plaintext verifier to
  retrieve the token.
- **One-time handoff.** Tokens are deleted from the in-memory store
  immediately after the desktop app polls successfully.
- **Rate limit.** 60 poll requests per IP per minute.
- **State expiry.** 10 minutes from start, then the flow has to restart.
- **State redaction.** `state` values are never logged in full.
- **Server-side secrets.** The `NOTION_CLIENT_SECRET` lives in the
  Vercel environment, never in code or commits.

The full server is ~500 lines of Express in [`server.js`](./server.js).
Read it.

## Endpoints

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/oauth/notion/start` | `{ verifier_hash }` | Start OAuth flow. Returns `{ state, authorizeUrl }`. |
| `GET`  | `/oauth/notion/callback` | (none) | OAuth callback. Notion redirects users here with the `code`. |
| `POST` | `/oauth/notion/poll` | `{ state, verifier }` | Poll for the token. Constant-time-compares verifier hash before release. |
| `POST` | `/oauth/notion/cancel` | `{ state }` | Mark a flow as cancelled (e.g. user closed the browser tab). |

Healthcheck at `GET /`.

## Deploying your own

`oauth-backend/DEPLOY.md` walks through the full setup. Short version:

1. Fork this repo.
2. Create two Notion integrations (dev + prod) at https://www.notion.so/my-integrations.
3. Connect the fork to Vercel.
4. Set env vars (`NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`, `NOTION_REDIRECT_URI`) for both Production and Preview scopes.
5. Set up domain CNAMEs.

You don't need to deploy this if you just want to *use* Margin — the
hosted instance handles that. Deploy it if you want your own backend
(e.g. self-hosted Margin) or if you're contributing.

## Local development

Mostly useful for debugging the Express code with breakpoints. Not the
default workflow.

```bash
cp .env.example .env       # fill in your dev Notion integration's creds
npm install
npm start                  # runs on http://localhost:3000
ngrok http 3000            # public URL for Notion to redirect to
```

Update the dev Notion integration's redirect URI to the ngrok URL.

## License

MIT.

## Contributing

Bug reports and PRs welcome. Security issues: please open a private
[security advisory on GitHub](https://github.com/martinoyovo/nameless-oauth-backend/security/advisories/new)
rather than a public issue.
