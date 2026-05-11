# Deploying the Margin OAuth backend

This is the production deployment runbook. After setup, **the OAuth
backend deploys automatically on `git push`** — no Vercel CLI, no
`rm -rf .vercel` switching, no manual ceremony.

## Architecture

One Vercel project. One GitHub repo. Two branches mapped to two
environments. Two stable URLs. Two Notion integrations. Same code on
both — Vercel injects different secrets per branch.

```
GitHub repo (this monorepo, Vercel watches the oauth-backend/ subdir)
  │
  ├─ main branch ────────────→ Vercel production deploy ──→ oauth.namelesstools.com
  │                            env scope: production
  │                            creds: "Margin" (prod) Notion integration
  │
  └─ develop branch ─────────→ Vercel branch deploy ──────→ oauth-staging.namelesstools.com
                               env scope: preview
                               creds: "Margin Dev" Notion integration
```

**Workflow once set up:**
- Push to `develop` → Vercel auto-deploys to staging in ~20s
- Open PR `develop → main`, merge → Vercel auto-deploys to production
- Bug in prod? `git revert <bad-commit>` and push — Vercel re-deploys
  the previous version. No dashboard, no manual rollback.

No more `vercel deploy --prod` from a developer's laptop.

> **Monorepo note**: this repo also contains the Electron app source
> alongside `oauth-backend/`. Vercel watches only the `oauth-backend/`
> subdirectory via the Root Directory setting — pushes that only touch
> Electron code don't trigger any deploys.

---

## One-time setup

### 1. Create two Notion integrations

At https://www.notion.so/my-integrations:

**A. "Margin Dev"** (rename your existing dev integration to this name
if you have one; otherwise create fresh).
- Type: Public integration
- Redirect URI: `https://oauth-staging.namelesstools.com/oauth/notion/callback`
  (if you don't have your domain yet, use `https://<your-project>-git-develop-<scope>.vercel.app/oauth/notion/callback` — Vercel hands you this in step 4)
- Copy the OAuth Client ID + Secret. Label them as DEV.

**B. "Margin"** (new, production-facing — this is what shows on the
consent screen the user sees).
- Type: Public integration
- Redirect URI: `https://oauth.namelesstools.com/oauth/notion/callback`
  (or the Vercel-assigned production URL until you have your domain)
- Copy the OAuth Client ID + Secret. Label them as PROD.

The two integrations share nothing. A leak of dev secrets does not
compromise production. The prod integration must NOT whitelist
localhost, ngrok, or any preview URLs.

### 2. Push this repo to GitHub

If you haven't created the GitHub repo yet (you do this — I can't
without auth):

1. github.com → New → name it `margin` (or whatever) → **Private**
2. Don't initialize with README/license/.gitignore — repo already has them.
3. Copy the `git remote add origin ...` command GitHub shows you.

Then locally, from this repo:
```bash
git remote add origin git@github.com:<you>/margin.git
git push -u origin main
git push -u origin develop
```

### 3. Connect Vercel to the repo (dashboard, ~3 minutes)

1. https://vercel.com → "Add New..." → "Project"
2. Import your GitHub repo (Vercel will ask for GitHub permission on first use)
3. Configure the project:
   - **Project Name**: `margin-oauth`
   - **Framework Preset**: "Other" (it's a plain Express app)
   - **Root Directory**: `oauth-backend` ← **important** for monorepo
   - **Build Command**: leave blank (no build step)
   - **Output Directory**: leave blank
   - **Install Command**: `npm install` (the default)
4. Don't add env vars yet — do it in the next step where you can scope them.
5. Click "Deploy". It'll fail to authenticate against Notion (no creds yet),
   but the function itself will load and the project will be created.

### 4. Configure environment variables (Vercel dashboard)

In the new project → Settings → Environment Variables.

Add **each of these three variables twice**, once per environment scope:

| Variable | Production scope value | Preview scope value |
|----------|------------------------|---------------------|
| `NOTION_CLIENT_ID` | Margin (prod) integration's client_id | Margin Dev integration's client_id |
| `NOTION_CLIENT_SECRET` | Margin (prod) secret | Margin Dev secret |
| `NOTION_REDIRECT_URI` | `https://oauth.namelesstools.com/oauth/notion/callback` | `https://oauth-staging.namelesstools.com/oauth/notion/callback` |

(Use the bare Vercel URLs if you don't have a custom domain yet — see
step 5.)

When adding each variable, check the boxes for which environments it
applies to. **Production** scope = `main` branch deploys. **Preview**
scope = all other branches including `develop`. Don't set the
"Development" scope at all (that's for `vercel dev` local emulation,
which we don't use).

### 5. Configure stable domains for both environments

In the new project → Settings → Domains.

Backend lives at `namelesstools.com` (kept separate from the future
front-end / marketing domain). Add two subdomains to the Vercel project:

**For production (`main` branch):**
- Add `oauth.namelesstools.com`
- Vercel will show the DNS record to add at your domain registrar:
  ```
  oauth   CNAME   cname.vercel-dns.com
  ```
- SSL is automatic and free.

**For staging (`develop` branch):**
- Add `oauth-staging.namelesstools.com`
- Click "Edit" on the domain → "Git Branch" field → enter `develop`
- This makes the alias point at `develop` instead of `main`. Every push
  to `develop` updates this domain in ~20s.
- DNS:
  ```
  oauth-staging   CNAME   cname.vercel-dns.com
  ```

Vercel propagates SSL certificates within a couple of minutes after DNS
resolves. Until then, the bare `margin-oauth.vercel.app` URL still works
as a fallback.

### 6. Verify the Margin desktop client matches

In the Margin desktop app repo, `electron/config.ts` should point at
these URLs:

```ts
const OAUTH_BACKEND_URL_DEV  = 'https://oauth-staging.namelesstools.com';
const OAUTH_BACKEND_URL_PROD = 'https://oauth.namelesstools.com';
```

The desktop app and this backend are loosely coupled — they only share
URLs. If you ever change the backend domain, update those two constants
in the desktop repo and ship a new release.

### 7. Verify

Healthcheck both URLs. They tell you if env vars are set correctly:

```bash
curl https://oauth-staging.namelesstools.com/
curl https://oauth.namelesstools.com/
```

Both should return `"configured": true`. If either reports `false` with
`missingEnvVars: [...]`, fix in Vercel dashboard → Settings → Environment
Variables, then trigger a redeploy by pushing an empty commit or hitting
"Redeploy" in the Vercel dashboard.

End-to-end OAuth test:

```bash
HASH=$(node -e 'console.log("a".repeat(64))')
curl -X POST https://oauth-staging.namelesstools.com/oauth/notion/start \
  -H 'Content-Type: application/json' \
  -d "{\"verifier_hash\":\"$HASH\"}"
```

Should return `{ ok: true, state: "...", authorizeUrl: "..." }`. The
`authorizeUrl` should point at notion.com and contain the **dev**
client_id. (Repeat against production URL to verify that one uses the
**prod** client_id.)

End-to-end via the Electron app:
```bash
npm run electron:dev   # uses dev backend + Margin Dev integration
```
Click "Connect Notion". The consent screen should say "Margin Dev". For
a packaged release build, it says "Margin".

---

## Ongoing workflow

### Backend change

```bash
git checkout develop
# edit oauth-backend/server.js
git commit -am "your change"
git push                           # Vercel auto-deploys to oauth-staging in ~20s
```

Test it. If happy:

```bash
git checkout main
git merge develop
git push                           # Vercel auto-deploys to oauth.namelesstools.com in ~20s
```

### Rollback

```bash
git revert <bad-commit>
git push                           # Vercel re-deploys the reverted state
```

Or use the Vercel dashboard: Deployments → find a previous good one → "Promote to Production".

### Adding a new env var

```bash
# Set it via Vercel dashboard (NOT via CLI). Pick the right scope.
# Then trigger a redeploy:
git commit --allow-empty -m "redeploy: pick up new env var"
git push
```

### Monitoring

- Logs: Vercel dashboard → Deployments → click any deployment → Functions tab
- Uptime: set up Better Stack or UptimeRobot to ping `oauth.namelesstools.com/` every minute and alert on non-200. Free, 5 minutes to configure. **Strongly recommended** before launch.

---

## Troubleshooting

**"FUNCTION_INVOCATION_FAILED" on first request after deploy**
The serverless function crashed loading. Used to happen when env vars
were missing — that's now handled gracefully (see `server.js`
`requireEnv` middleware). If you still see it, check Vercel logs for
the actual stderr.

**Healthcheck shows `"configured": false`**
Env vars aren't set against the right scope. Fix in dashboard, then
either redeploy via dashboard or push an empty commit to trigger
Vercel.

**OAuth flow returns "Invalid redirect URI" from Notion**
The redirect URI in your Notion integration's allowlist doesn't exactly
match `NOTION_REDIRECT_URI` in Vercel. Both must be identical, including
the `https://`, the trailing path, and any subdomain. Check both.

**`develop` deploys but `oauth-staging.namelesstools.com` doesn't update**
The branch-domain alias isn't pointing at `develop`. Vercel dashboard →
Project → Domains → edit `oauth-staging.namelesstools.com` → "Git Branch"
field should say `develop`.

**Costs**
Vercel free tier covers:
- 100 GB/month bandwidth
- 100 GB-hours of function execution
- Unlimited deployments

You'd need ~20,000 OAuth signups/month to approach the limits.
