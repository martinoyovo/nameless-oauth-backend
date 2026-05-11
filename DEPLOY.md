# Deploying the Margin OAuth backend

This is the production deployment runbook. After setup, **the OAuth
backend deploys automatically on `git push`.** No Vercel CLI, no
`rm -rf .vercel` switching, no manual ceremony.

## Architecture

One Vercel project. One GitHub repo. Two branches mapped to two
environments. Two stable URLs. Two Notion integrations. Same code on
both. Vercel injects different secrets per branch.

```
GitHub repo
  │
  ├─ main branch ─────────────→ Vercel production deploy ──→ oauth.yourdomain.com
  │                             env scope: production
  │                             creds: prod Notion integration
  │
  └─ develop branch ──────────→ Vercel branch deploy ──────→ oauth-staging.yourdomain.com
                                env scope: preview
                                creds: dev Notion integration
```

**Workflow once set up:**
- Push to `develop` → Vercel auto-deploys to staging in ~20s
- Open PR `develop → main`, merge → Vercel auto-deploys to production
- Bug in prod? `git revert <bad-commit>` and push, Vercel re-deploys
  the previous version. No dashboard, no manual rollback.

---

## One-time setup

### 1. Create two Notion integrations

At https://www.notion.so/my-integrations:

**A. Dev integration** (e.g. "Margin Dev").
- Type: Public integration
- Redirect URI: `https://oauth-staging.yourdomain.com/oauth/notion/callback`
- Copy the OAuth Client ID + Secret. Label them as DEV.

**B. Prod integration** (e.g. "Margin"). This name appears on the
Notion consent screen users see.
- Type: Public integration
- Redirect URI: `https://oauth.yourdomain.com/oauth/notion/callback`
- Copy the OAuth Client ID + Secret. Label them as PROD.

The two integrations share nothing. A leak of dev secrets does not
compromise production. The prod integration must NOT whitelist
localhost, ngrok, or any preview URLs.

### 2. Fork this repo

1. Fork to your own GitHub account.
2. Clone locally if you want to make changes.
3. The fork already has `main` and `develop` branches set up.

### 3. Connect Vercel to the repo (~3 minutes)

1. https://vercel.com → "Add New..." → "Project"
2. Import your fork (Vercel asks for GitHub permission on first use).
3. Configure:
   - **Project Name**: anything you like (e.g. `oauth-backend`)
   - **Framework Preset**: "Other"
   - **Root Directory**: `./` (the repo root)
   - **Build Command**: leave blank
   - **Output Directory**: leave blank
   - **Install Command**: `npm install`
4. Don't add env vars yet. Next step.
5. Click "Deploy". First deploy will succeed but the function will
   report `"configured": false` until you set env vars in step 4.

### 4. Configure environment variables (Vercel dashboard)

In the new project → Settings → Environment Variables.

Add **each of these three variables twice**, once per environment scope:

| Variable | Production scope value | Preview scope value |
|----------|------------------------|---------------------|
| `NOTION_CLIENT_ID` | prod integration's client_id | dev integration's client_id |
| `NOTION_CLIENT_SECRET` | prod integration's secret | dev integration's secret |
| `NOTION_REDIRECT_URI` | `https://oauth.yourdomain.com/oauth/notion/callback` | `https://oauth-staging.yourdomain.com/oauth/notion/callback` |

(Use the bare Vercel URLs if you don't have a custom domain yet, see
step 5.)

When adding each variable, check the boxes for which environments it
applies to. **Production** scope = `main` branch deploys. **Preview**
scope = all other branches including `develop`. Don't set the
"Development" scope at all (that's for `vercel dev` local emulation,
which we don't use).

### 5. Configure stable domains for both environments

In the new project → Settings → Domains. Add two subdomains to the
Vercel project:

**For production (`main` branch):**
- Add `oauth.yourdomain.com`
- Vercel will show the DNS record to add at your domain registrar:
  ```
  oauth   CNAME   cname.vercel-dns.com
  ```
- SSL is automatic and free.

**For staging (`develop` branch):**
- Add `oauth-staging.yourdomain.com`
- Click "Edit" on the domain → "Git Branch" field → enter `develop`
- This makes the alias point at `develop` instead of `main`. Every push
  to `develop` updates this domain in ~20s.
- DNS:
  ```
  oauth-staging   CNAME   cname.vercel-dns.com
  ```

Vercel propagates SSL certificates within a couple of minutes after DNS
resolves. Until then, the bare `<your-vercel-project>.vercel.app` URL still works
as a fallback.

### 6. Point your desktop client at the backend

In the desktop app's `electron/config.ts`:

```ts
const OAUTH_BACKEND_URL_DEV  = 'https://oauth-staging.yourdomain.com';
const OAUTH_BACKEND_URL_PROD = 'https://oauth.yourdomain.com';
```

The desktop app and this backend are loosely coupled, they only share
URLs. If you ever change the backend domain, update those two constants
in the desktop repo and ship a new release.

### 7. Verify

Healthcheck both URLs. They tell you if env vars are set correctly:

```bash
curl https://oauth-staging.yourdomain.com/
curl https://oauth.yourdomain.com/
```

Both should return `"configured": true`. If either reports `false` with
`missingEnvVars: [...]`, fix in Vercel dashboard → Settings → Environment
Variables, then trigger a redeploy by pushing an empty commit or hitting
"Redeploy" in the Vercel dashboard.

End-to-end OAuth test:

```bash
HASH=$(node -e 'console.log("a".repeat(64))')
curl -X POST https://oauth-staging.yourdomain.com/oauth/notion/start \
  -H 'Content-Type: application/json' \
  -d "{\"verifier_hash\":\"$HASH\"}"
```

Should return `{ ok: true, state: "...", authorizeUrl: "..." }`. The
`authorizeUrl` should point at notion.com and contain the **dev**
client_id. (Repeat against production URL to verify that one uses the
**prod** client_id.)

End-to-end via the Electron app:
```bash
npm run electron:dev   # uses staging backend + dev integration
```
Click "Connect Notion". The consent screen should show your dev
integration's name. Packaged release builds use the prod backend and
show the prod integration's name.

---

## Ongoing workflow

### Backend change

```bash
git checkout develop
# edit server.js
git commit -am "your change"
git push                           # Vercel auto-deploys to oauth-staging in ~20s
```

Test it. If happy:

```bash
git checkout main
git merge develop
git push                           # Vercel auto-deploys to oauth.yourdomain.com in ~20s
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
- Uptime: set up Better Stack or UptimeRobot to ping `oauth.yourdomain.com/` every minute and alert on non-200. Free, 5 minutes to configure. **Strongly recommended** before launch.

---

## Troubleshooting

**"FUNCTION_INVOCATION_FAILED" on first request after deploy**
The serverless function crashed loading. Used to happen when env vars
were missing. That's now handled gracefully (see `server.js`
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

**`develop` deploys but `oauth-staging.yourdomain.com` doesn't update**
The branch-domain alias isn't pointing at `develop`. Vercel dashboard →
Project → Domains → edit `oauth-staging.yourdomain.com` → "Git Branch"
field should say `develop`.

**Costs**
Vercel free tier covers:
- 100 GB/month bandwidth
- 100 GB-hours of function execution
- Unlimited deployments

You'd need ~20,000 OAuth signups/month to approach the limits.
