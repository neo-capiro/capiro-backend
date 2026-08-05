# Engagement Phase 0 — Local Acceptance Runbook

## Prerequisites

- Docker installed and running (for disposable PostgreSQL)
- Node.js >= 20.11.0
- pnpm installed
- Chrome/Chromium installed (chrome-launcher finds it automatically)
- Clerk credentials for a test user (see below)

## Required Environment Variables

Set these before running:

```bash
export ENGAGEMENT_PHASE0_CLERK_ORG_ID="org_..."        # Clerk organization ID
export ENGAGEMENT_PHASE0_USER_CLERK_ID="user_..."      # Clerk user ID
export ENGAGEMENT_PHASE0_USER_EMAIL="test@example.com"  # User email
export ENGAGEMENT_PHASE0_USER_COOKIE="__session=..."    # Clerk session cookie
```

## How to Obtain a Test Session

1. Log in to the Capiro app (app.capiro.ai) in Chrome with the test user
2. Open DevTools → Application → Cookies → app.capiro.ai
3. Copy the `__session` cookie value
4. Find the Clerk organization ID and user ID from the Clerk dashboard or DevTools

**Never commit cookie values to the repository.**

## Exact Command

```bash
pnpm verify:engagement-phase-0:browser -- --sha "$(git rev-parse HEAD)"
```

Or directly:

```bash
node scripts/run-engagement-phase0-local.mjs --sha "$(git rev-parse HEAD)"
```

## Evidence Location

```
.artifacts/engagement-phase0-<sha>/
  runner-summary.json
  browser-results.json
  screenshots/
  logs/
  fixtures.json
```

## Expected Completion Marker

The runner prints a JSON object with `"marker": "ENGAGEMENT_PHASE0_LOCAL_COMPLETE"`.

## Cleanup

The runner automatically removes the disposable PostgreSQL container in its `finally` block.

Manual cleanup if the script is interrupted:

```bash
docker rm -f engagement-phase0-<pid>
```

## Troubleshooting

| Symptom | Likely Cause |
|---|---|
| `Docker not found` | Install Docker Desktop or Rancher Desktop |
| `Port 55470 already in use` | Kill the process on that port or use `--db-port` |
| `Chrome not found` | Install Chrome or set `CHROME_PATH` |
| `Clerk session not active` | Cookie may be expired — get a fresh `__session` cookie |
| `Module not found` | Run `pnpm install --frozen-lockfile` first |
| `Prisma migrate deploy fails` | Check that the Prisma migrations are present in `apps/api/prisma/migrations/` |

## Warning

**This runner must never target a shared database or AWS.** It creates its own disposable PostgreSQL container and uses local-only URLs. External provider actions are disabled via environment variables.
