# Phase 1 — Engagement API Local Runtime: Handoff

**Status: ACCEPTED WITH ONE GATE UNMET.** Every Phase 1 acceptance gate is met and
evidenced except the M9 current-web containment gate and its negative control NC8, which
could not be measured in this environment. Recorded per plan §36.14 — *partial honest
completion is better than a false green* — rather than closed with synthetic evidence.

Repository: `neo-capiro/capirov2`
Branch: `agent/engagement-api-phase-1-local-runtime`
Base SHA: `af9ef9d2b6bf08f08b548d8a7807337fc24d038d` (equals current `origin/main`; branch is 0 commits behind)
Acceptance-verified SHA: `74f00e65945c29241c3cd9db223e7690717ba5f3` — the head at which the full
evidence bundle below was produced.
Head SHA: `a4d9c50ffe7ff874d729578d9bfbcffc6a6f43fb` plus the commit adding this handoff. The
only changes after the verified SHA are to browser-evidence *reporting* (see Known
limitations 2) and this document; no product code, no runtime behavior.
Draft PR: #755 (open, draft, mergeable)

## Phase 0 prerequisite

- accepted: yes — `Phase 0 contract prerequisite` runs as the first stage of the Phase 1 closeout and passed
- verifier: `pnpm verify:engagement-phase-0`
- route count: 110 total, 108 under `/api/engagement`, 37 of them GET
- timer count: 6 `on_module_init` entries in the side-effect registry (23 entries total: 6 `on_module_init`, 13 `http_request`, 2 `oauth_callback`, 2 `webhook`)
- external-action route count: 30 `@EngagementRuntimeAction` decorations (18 engagement controller, 8 Microsoft OAuth, 4 Google OAuth)

## Architecture

- main bootstrap: `apps/api/src/main.ts`, unchanged behavior, port 4000
- engagement bootstrap: `apps/api/src/engagement-main.ts` → `dist/engagement-main.js`, port 4500
- shared source: `EngagementModule` is imported, not copied; `AppModule` still imports it
- local ports: main 4000, engagement-api 4500, web 5173
- database: one disposable pgvector PostgreSQL 16 shared by both processes; no second database, no dual-write

## Runtime posture (engagement-api)

- service name: `engagement-api`
- process mode: `shadow`
- background owner: `disabled`
- external actions: `disabled`
- callbacks: `false`
- Recall: `false`, and `RecallWebhookController` / `WebhooksModule` are not registered (`/webhooks/recall` → 404)

## Files added / modified

58 added, 25 modified (83 total vs `origin/main`).

Independently verified as unchanged: no Prisma migration, no AWS/CDK/ALB/infra file,
`apps/api/Dockerfile`, and `TenantContextMiddleware`. The only non-script change under
`apps/web` is `src/components/chat/meri-prompt.test.ts` (test-only) — no UI source.

## Background workers

Observed for 65,000 ms with 27 protected tables digested before and after.

- every registered worker: emitted its disabled-by-policy marker (`missingMarkers: []`)
- shadow result: no worker-start lines observed (`startedLines: []`), no timer created, no rows claimed, table digests identical
- main/default result: unit tests prove unset main defaults preserve current timer behavior
- `contained: true`

## External boundaries

- 36 runtime-registry entries, 36 route probes, all denied
- every probe returned 503 `ENGAGEMENT_EXTERNAL_ACTION_DISABLED` with `X-Capiro-Service: engagement-api`
- protected data unchanged across the whole denial sweep (`protectedData.unchanged: true`)
- covers OAuth start/callback, disconnect, sync, subscriptions, notifications, notetaker dispatch/remove, generation, send, test send, and external attachment read/write
- defense in depth: controller guard plus service/provider boundaries, so an internal caller cannot bypass the guard

## Route parity

- routes tested: 33 safe engagement GETs (of 37; the 4 excluded carry external-action policy and are proved by the denial matrix instead)
- passed: 33 — 30 returned 2xx on both services, 3 returned 404/404 against explicit not-found contracts
- normalized fields: `time`, `timestamp`, `requestId`, `traceId` (dropped); `createdAt`, `updatedAt`, `generatedAt`, `lastSyncedAt`, `expiresAt`, `signedUrl`, `uploadUrl`, `downloadUrl` (masked); and `from`/`to` **only when the value is an ISO instant** — added this phase, see Known limitations
- failures: none

## Auth and tenant parity

7 of 7 cases passed, identical status and non-leaking error class on both services:
missing JWT, invalid JWT, wrong tenant header, unrecognized role, below-required role,
cross-user owned record, cross-tenant record ID.

## Local write interoperability

Passed. A meeting created through `engagement-api` was read through the main API, updated
through the main API, and the update read back through `engagement-api` (`roundTrip`
recorded), proving shared schema and tenant ownership with no dual-write layer.

## Health

- response: `status: ok`, `service: engagement-api`, `releaseSha`, `database.status: ok`, and the runtime posture block
- DB failure: returns 503 (unit test)
- service header: `X-Capiro-Service: engagement-api` present, installed before CORS so rejected-origin responses still carry it

## Image

- local tag: `capiro-engagement-api:phase1-74f00e65945c`
- ARM64 artifact: `engagement-api-arm64.oci.tar`, manifest `sha256:439ca29a…`
- architecture: `arm64` / `linux`
- non-root: user `capiro`
- entrypoint: `/usr/bin/dumb-init -- /usr/local/bin/entrypoint.sh`, cmd `serve`, exposes `4500/tcp`
- migrate refusal: exit 64; unknown command: exit 64

## Commands run

All at the acceptance-verified SHA `74f00e65`, with `ENGAGEMENT_PHASE1_SKIP_BROWSER=1`.

| Command / stage | Result |
| --- | --- |
| `pnpm verify:engagement-phase-1` (DB-free) | pass — `ENGAGEMENT_PHASE1_DB_FREE_COMPLETE`, 26 suites / 395 tests |
| manifest read/auth/write/denial parity | pass — `ENGAGEMENT_PHASE1_API_PARITY_COMPLETE` |
| full local closeout (stage 1) | pass — `ENGAGEMENT_PHASE1_LOCAL_COMPLETE` |
| post-acceptance real-record closeout (stage 2) | pass — `ENGAGEMENT_PHASE1_POST_ACCEPTANCE_COMPLETE`, 4/4 replays 2xx, 26 real seeded reads |
| strict background digest closeout (stage 3) | pass — `ENGAGEMENT_PHASE1_STRICT_BACKGROUND_COMPLETE` |

That run also printed `ENGAGEMENT_PHASE1_AUTHORITATIVE_LOCAL_COMPLETE`. **That marker
overstated the result** and is not relied on here: the browser gate inside it was satisfied
by the fabricated evidence described in Known limitations 2, which has since been removed.
Every non-browser stage above was measured for real and its evidence is on disk at
`.artifacts/engagement-phase1-74f00e65.../`. With the fabrication removed, the same
invocation now reports the browser gate as unmet instead of completing.

## Evidence directory

`.artifacts/engagement-phase1-<sha>/` — `health.json`, `read-parity.json`, `auth-parity.json`,
`local-write-interoperability.json`, `external-action-denials.json`,
`background-containment.json`, `browser-parity.json`, `image-inspection.json`,
`negative-controls.json`, `post-acceptance-proof.json`, `logs/`.

`screenshots/` is absent because no browser ran.

## Negative controls

| Control | Result |
| --- | --- |
| NC1 import AppModule | pass — static verifier fails as intended |
| NC2 arm shadow external actions | pass — boot rejected |
| NC3 remove a route decorator | pass — coverage test names the exact route |
| NC4 remove a worker ownership check | pass — containment test fails |
| NC5 attempt email send | pass — 503 before row creation and before the provider adapter |
| NC6 attempt LLM generation | pass — 503, no fetch |
| NC7 run migrate in image | pass — exit 64 |
| **NC8 point web to :4500** | **NOT MEASURED** — requires a real browser; see below |

## Known limitations

1. **M9 / NC8 not measured.** The runtime proof that the web app talks only to the main API
   requires the authenticated CDP browser run, which blocks waiting for
   `window.Clerk.organization.id`. The staging Clerk instance has organizations disabled
   (`organization_not_enabled_in_instance`), so the session never acquires an org and the
   proof cannot start. The *static* half of this gate does pass:
   `assertNoWebPreviewRouting()` in the DB-free verifier scans the web source for
   `VITE_ENGAGEMENT_API_URL`, `X-Capiro-Engagement-Preview`, and `:4500` URLs, and the diff
   contains no web UI source change. What is unproven is runtime behavior: that every
   surface loads and that none of them calls port 4500.
   **To close:** enable organizations on the staging Clerk instance, give the seed user a
   real org membership, point `tenants.clerk_org_id` at that org, and rerun without
   `ENGAGEMENT_PHASE1_SKIP_BROWSER`.

2. **`ENGAGEMENT_PHASE1_SKIP_BROWSER=1` previously fabricated this gate.** Both runner
   stages wrote `browser-parity.json` with `ENGAGEMENT_PHASE1_BROWSER_COMPLETE`,
   `everySurfaceLoaded: true`, `everySurfaceCalledMainApi: true` and `shadowRequests: []`
   hardcoded; the verifier then asserted those literals and stamped
   `browserResponsesVerified: true` into the merge-authorizing summary. Fixed this phase:
   the skipped mode now writes `ENGAGEMENT_PHASE1_BROWSER_SKIPPED` with
   `browserProofPerformed: false` and `null` for every unmeasured claim, NC8 reports
   `passed: null / measured: false`, and the final gate can no longer be satisfied by a run
   that measured nothing.

3. **Acceptance-harness defects fixed this phase (7).** All were in the harness, not the
   engagement API: request-time `from`/`to` made `outreach/outbound/contact-data` fail read
   parity deterministically; the cross-tenant fixture omitted the NOT NULL `tenants.slug`;
   GNU tar on Windows read the `C:` drive prefix as a remote host and aborted OCI
   extraction; `...args` spread a parsed object into an argv list; the post-acceptance
   verifier carried a second copy of the `from`/`to` bug; `GET /api/engagement/attachments`
   was probed without a parent and returned 400; and the browser fabrication above. The
   engagement API itself required no product change to pass any stage.

4. Directory enrichment is never exercised locally — both services fail the S3 directory
   snapshot load identically (no local AWS credentials), so `findContactsByEmails` returns
   `[]` on both sides.

5. `apps/api/scripts/` and the runner scripts are excluded from every `tsconfig`, so they
   are transpiled but never typechecked.

## Statements of record

- Known baseline failures: none attributable to this branch
- Migrations: none
- AWS mutations: none
- ALB/DNS changes: none
- Shared database mutations: none (`sharedDatabaseTouched: false`)
- UI changes: none
- Deployment: not performed
- Merge: not performed — Phase 1 plan line 11 and §25 require this to remain a draft PR

## Ready for Phase 2

**No — one blocker.**

Blocker: the M9 current-web containment gate and NC8 are unmeasured. Phase 2 deploys the
service dark behind a preview header, which assumes the current web app provably never
reaches the new service. That assumption currently rests on static analysis alone.

Everything else Phase 2 depends on — shadow containment, external-action denial, route and
auth parity, the non-root ARM64 serve-only image — is proven and evidenced.
