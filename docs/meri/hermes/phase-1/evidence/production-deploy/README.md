# Production deploy, migration apply, and E-8 rollback rehearsal — 2026-09-20

Account **967807252336**, us-east-1, cluster **capiro-dev** (which *is* production — see `HANDOVER.md` §2.2). Executed under explicit operator authorization.

## 1. Ancestor safety — the check that nearly went wrong

`main` moved **four times** during this session. The sequence actually observed:

| Reading | Deployed commit | Verdict |
|---|---|---|
| Session start (per prior handover) | `884297998` (#1705) | NOT SAFE |
| After first `origin/main` merge | `884297998` | reported SAFE — **this reading was wrong** |
| Re-checked through the *service* | `c780031cc` (#1707) | **NOT SAFE** — would have reverted #1706 and #1707 |
| After second merge | `c780031cc` | SAFE (confirmed twice) |
| Immediately before migrate | `c780031cc` | SAFE (confirmed twice) |

The bad reading came from the documented one-liner, which resolves `--task-definition capiro-dev-api`
— the **family alias**, i.e. the latest *registered* revision, not what the service runs. It once
returned a SHA (`884297998`) that existed in **no** task definition of that family at all: revision
394 was the highest ever registered, ACTIVE or INACTIVE, and its `GIT_SHA` was `c780031cc`. The cause
of that specific spurious value was never explained, which is precisely why the check is now run
**twice, through `describe-services`**, immediately before any deploy.

## 2. Migration apply — the stale-digest trap, avoided

`capiro-dev-api-admin-migrate` rev 47 pinned `sha256:e59b3dac…`. Running it unchanged executes
`prisma migrate deploy` from that old image, skipping newer migrations **while exiting 0**.

Re-registered as **rev 48** against the freshly built image
`sha256:cc7dc8a143a329958b87fbe673cc72325de4ec4f98d444ace1458ee9ddf76274`, then run with its own
default `migrate` command. Verified beforehand that the image's `migrate` subcommand is exactly
`prisma migrate deploy` (`apps/api/scripts/entrypoint.sh:77-83`) — no `migrate dev`, `db push`,
`migrate reset` or `migrate diff` anywhere in that entrypoint.

Task `ae811154e563428cbac8abf454023e27`, exit 0, and — the part that actually matters —

```
411 migrations found in prisma/migrations
Applying migration `20280920010000_meri_hermes_durable_runs`
Applying migration `20280920020000_meri_hermes_admission_fencing`
Applying migration `20280920030000_meri_hermes_cross_replica_coordination`
Applying migration `20280920040000_meri_hermes_scaling_controls`
Applying migration `20280920050000_meri_hermes_profile_state`
The following migration(s) have been applied:
```

Exactly the five expected, and nothing from any other team.

**Pre-flight verification done independently rather than taken on trust:** the five files create 8
tables, every single `ALTER TABLE` target is one of those 8, and there are zero `DROP`/`TRUNCATE`/
`DELETE FROM`/`ALTER COLUMN`/`RENAME` statements. The only `DELETE`/`UPDATE` tokens in them are FK
`ON DELETE CASCADE` clauses and `GRANT` privilege lists on the new tables. Outward foreign keys
reference only `tenants` and `clio_conversations`, so the apply takes a brief lock on those two
parents — trivial to validate, since the child tables are empty.

An attempt to run a read-only `prisma migrate status` first **failed harmlessly** (exit 1): the image
entrypoint takes a fixed subcommand from an allowlist and rejects `npx`. No read-only pre-flight is
available through that image; the SQL analysis above stands in for it.

## 3. API deploy — the stale-SHA trap, avoided

A plain `--force-new-deployment` leaves `GIT_SHA`/`RELEASE_SHA` reporting the previous commit.
Instead, **rev 395** was registered with both the new image digest and both SHAs rewritten.

| | |
|---|---|
| Task definition | `capiro-dev-api:395` |
| Image | `capiro/dev/api@sha256:cc7dc8a1…` (linux/arm64) |
| `GIT_SHA` / `RELEASE_SHA` | `56d97272986fc6546776dc75eaac88a682209198` — equals branch HEAD |
| Result | STABLE, 2/2, new targets registered in `capiro-prod-api-tg` |

Note the service has `deploymentCircuitBreaker.enable = false`, so there is **no automatic
rollback**. What protects the deploy is `minimumHealthyPercent: 100` — old tasks keep serving until
new ones pass ALB health checks, so a bad image stalls the deployment rather than causing an outage.

## 4. E-8 rollback rehearsal — PASS

The claim under test, from `deployment-validation-and-rollback.md` §8:

> Because every migration is additive, the older revision runs unchanged against the migrated schema.

Until now this was asserted, never exercised. With the five migrations **applied**, production was
rolled back to the pre-Hermes revision and then forward again.

| Step | Task definition | Result |
|---|---|---|
| Before | `:395` (Hermes code) | 2/2, health 401 @ ~0.12 s |
| **Rollback** | `:394` (pre-Hermes) | **STABLE, 2/2, 0 pending — no crash loop** |
| After rollback | `:394` against migrated schema | health 401 @ ~0.13 s, unchanged |
| Roll forward | `:395` | STABLE, 2/2 |

The pre-Hermes revision ran against the migrated schema with no errors and no measurable change in
response behaviour. **The additive-migration rollback claim is now demonstrated, not assumed.**

## 5. E-7 browser evidence — partial, and honestly so

`https://os.capiro.ai` after the deploy: renders the Clerk sign-in view, **zero console errors**, every
asset 200 (`index-*.js`, `maplibre-*`, `theme-*.css`, `logo.png`).

Health endpoints are byte-identical before and after the whole sequence:

| Endpoint | Pre-deploy | Post-deploy |
|---|---|---|
| `os.capiro.ai/api/health` | 401 | 401 |
| `app.capiro.ai/api/health` | 401 | 401 |
| `os.capiro.ai/api/clio/hermes/capabilities` | 401 | 401 |

**What this does not show.** E-7 asks for browser evidence of the *end-to-end experience*. That
cannot be produced with the pilot gate closed — every `/api/clio/hermes/*` route 404s for a tenant
that is not gated in, and the gate stayed closed throughout. Unauthenticated probes also return 401
*before* reaching the gate, so they cannot distinguish "gate closed" (404) from "not signed in"
(401); separating those requires an authenticated session as a gated user. E-7 is therefore
**partial**: the deploy is demonstrated inert and the app demonstrated healthy, but the Hermes user
journey is unevidenced. See `../../v5-v7-blocked-on-resolver-binding.md`.

## 6. Net production delta

- Database: 5 additive migrations applied (8 new tables). No pre-existing table altered.
- `capiro-dev-api`: rev 394 → **395** (new image, honest SHAs). Rolled to 394 and back during E-8.
- `capiro-dev-api-admin-migrate`: rev 47 → **48** (fresh image).
- No feature flag enabled. No tenant added to any allowlist. The Hermes surface is deployed and inert.
