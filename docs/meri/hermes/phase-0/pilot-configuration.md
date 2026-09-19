# Pilot configuration — `capiro-internal`

Prepared September 19, 2026. This page records how the pilot tenant was resolved and exactly which switches enable, disable and roll back the Hermes runtime. **Nothing in this page has been applied to a deployed environment.** Phase 0 ran only against the local fixture database and local containers.

## 1. Canonical tenant identity

| Item | Value | How it was obtained |
|---|---|---|
| Tenant slug | `capiro-internal` | Supplied by the user |
| Canonical tenant id | `17b63099-bc0f-4ac5-b596-496161e9481e` | Authorized read-only admin lookup: `apps/api/scripts/diag-tenant-config.ts` executed earlier on 2026-09-19 against the deployed database (evidence file `C:/dev/main/outputs/legiwatch-ux-implementation-qa/production-final-prior-20260919-022259/tenant-diag-phase3-acceptance.log`, `TC_ALL_TENANTS` block); cross-checked with two authenticated `/api/me`-style probe responses from the same QA run (`authenticated-deep-qa.json` files) that return `{"id":"17b63099-…","slug":"capiro-internal","name":"Capiro"}` |
| Environment | AWS account `967807252336`, region `us-east-1`, ECS cluster **`capiro-dev`**, Aurora cluster `capiro-dev-data-auroracluster23d869c0-ltmz40k47ewv`. Despite its name this is the **live production** deployment serving `os.capiro.ai` / `app.capiro.ai` (see `infra/cdk/lib/config.ts` and `infra/cdk/DRIFT-FINDINGS.md`). There is no separately provisioned staging environment for Meri today. |
| Clerk organization | `org_3DB7EKoeKfF8ZLu6cW4d9Vn6CT0` (recorded in the same lookup; not a secret) |
| Tenant name / status | `Capiro`, `active`, plan tier `FOUNDATION`, 8 members, 58 clients at lookup time |

What this session did **not** do: it did not re-query the deployed database, did not create or modify any tenant, and did not guess user ids. Before enabling the pilot, re-verify the id with a dry run of the existing flag script (it prints the resolved id without writing):

```bash
pnpm --filter @capiro/api set:tenant-flag -- --slug capiro-internal --flag meri.hermesRuntime --value true
```

(Dry-run by default; the command above changes nothing until `--commit` is added.)

### Test identities

Phase 0 used **fixture identities only** (`scripts/meri-hermes/phase0-fixtures.json`: Alice and Bob in the fixture pilot tenant, Carol in an outside tenant). Two approved internal production identities with separate private scopes must be designated by the user before a deployed pilot; this session deliberately did not select real user ids.

## 2. The three-key gate (server side, default closed)

Implemented in `apps/api/src/common/meri-hermes-flags.ts` and `MeriFeatureFlagsService.isMeriHermesRuntimeEnabled`; routed in `apps/api/src/meri/meriv3-runtime.proxy.ts` ahead of the MeriV3 canary check.

| Key | Where | Value to enable the pilot | Default |
|---|---|---|---|
| 1. Global switch | API task definition env `MERI_HERMES_ENABLED` | `true` | unset → off |
| 2. Canonical tenant allowlist | API env `MERI_HERMES_PILOT_TENANT_IDS` | `17b63099-bc0f-4ac5-b596-496161e9481e` (comma-separated UUIDs; slugs are ignored) | empty → nobody |
| 3. Per-tenant flag | `tenants.settings_jsonb.clioFeatureFlags["meri.hermesRuntime"]` | `true` via `set:tenant-flag … --commit` | absent → off |

All three must be open. The tenant id is the authenticated `TenantContext.tenantId` resolved by the tenant middleware; a client-supplied tenant field or slug never widens the gate (unit tests in `meri-hermes-flags.spec.ts`; harness checks ISO2/ISO3).

Runtime configuration the API additionally needs when key 1 is on (names only; values live in Secrets Manager / task definitions):

| Variable | Purpose |
|---|---|
| `MERI_HERMES_RUNTIME_URL` | Base URL of the worker API server for the scope (Phase 0: one worker) |
| `MERI_HERMES_API_KEY` | Bearer key for that worker (`API_SERVER_KEY` on the worker side) |
| `MERI_HERMES_BROKER_SIGNING_KEY` | ≥32-char HMAC key that mints/verifies scope-bound worker tokens. **Not** `INTERNAL_SERVICE_SECRET` |
| `MERI_HERMES_MODEL` | Model id handed to Hermes (recommended below) |
| `MERI_HERMES_RUN_MAX_WALL_MS` | Per-run wall-clock budget (default 600000) |
| `MERI_HERMES_BUILD_TAG`, `MERI_HERMES_BUILD_COMMIT`, `MERI_HERMES_IMAGE_DIGEST` | Reported by `GET /api/clio/hermes/capabilities` |

If key 1–3 are open but any of the first three variables is missing, the pilot tenant's turn returns an explicit `error` frame (`Hermes runtime is enabled for this tenant but … is not configured`) followed by `done`; it does **not** fall back to V3/legacy. This is intentional (handoff §1) and covered by `meriHermesConfigurationError` tests and the proxy spec.

## 3. Worker configuration (per execution scope)

The worker image `meri-hermes-worker:v2026.9.14-meri` receives, at provisioning time:

| Variable | Purpose |
|---|---|
| `API_SERVER_KEY` | Bearer key the Meri API uses to call this worker |
| `MERI_BROKER_URL` | `https://<api-host>/api/internal/hermes/broker` |
| `MERI_WORKER_TOKEN` | Scope-bound token minted by Meri (`mintMeriHermesWorkerToken`), TTL ≤ 12 h, bound to tenant + user + authorization version |
| `MERI_EXECUTION_SCOPE_ID` | `tenant:<tenantId>:user:<userId>` |
| `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`) | Model credential for the worker only; narrow budget recommended |
| `MERI_HERMES_MODEL`, `MERI_HERMES_PROVIDER`, `MERI_HERMES_BASE_URL` | Model routing (`custom` + `https://api.openai.com/v1` for the platform OpenAI key) |
| `MERI_SOUL_B64` | Tenant persona rendered by Meri (base64 SOUL.md) |
| `HERMES_EXEC_ASK=1` | Required for native approvals to block instead of auto-deny on the `api_server` platform (see `hermes-source-evidence-a.md` §8) |

The worker never receives `INTERNAL_SERVICE_SECRET`, `DATABASE_URL`, Clerk keys or connector OAuth material.

## 4. Recommended model / region (from existing approved configuration)

The platform already standardises Meri V3 on OpenAI models through the `capiro/dev/openai-api-key` secret (`docs`: `llm-provider-inventory-2026-09-15.md`): `gpt-5.6-luna` (Fast), `gpt-5.6-terra` (Standard), `gpt-5.6` (Deep/Max). Anthropic (`capiro/dev/anthropic-api-key`, Sonnet 4.6) is the approved alternate. Recommendation for the pilot: **`gpt-5.6-terra` as the default Hermes model**, `gpt-5.6-luna` for background review/compression (auxiliary tasks), both selectable per tenant via `MERI_HERMES_MODEL` / `auxiliary.*` in the worker config. Region stays `us-east-1` with the rest of the platform; no data-residency constraint was stated. The Phase 0 harness ran with `gpt-5.6-luna` to keep cost low (see `measurements.md`).

Unresolved (needs a product/ops decision, not invention): whether the pilot uses the platform key or a dedicated, budget-capped key per tenant; the plan recommends a narrow-budget credential per worker.

## 5. Enable sequence (deployed pilot — later phase, not executed)

1. Build and push the **arm64** worker image; record the digest in `pins.md`.
2. Provision the worker task (Fargate, 1 vCPU / 2 GiB to start) with the variables in §3; verify `GET /health` and `/v1/capabilities` through the private network.
3. Set the API variables in §2 (URL, key, signing key, model) — key 1 still `false`.
4. `set:tenant-flag --slug capiro-internal --flag meri.hermesRuntime --value true --commit` (key 3).
5. Set `MERI_HERMES_PILOT_TENANT_IDS=17b63099-bc0f-4ac5-b596-496161e9481e` (key 2).
6. Flip `MERI_HERMES_ENABLED=true` (key 1). The 60-second flag cache means the first Hermes turn happens within a minute.
7. Verify with a designated internal identity: `GET /api/clio/hermes/capabilities` returns 200 for the pilot and 404 for any other tenant.

## 6. Disable / rollback (any one key)

| Action | Effect | Time |
|---|---|---|
| `MERI_HERMES_ENABLED=false` (or unset) | Every tenant leaves Hermes; new turns route to V3/legacy exactly as before; `/api/clio/hermes/*` returns 404 | next request (env read per call) |
| Remove the id from `MERI_HERMES_PILOT_TENANT_IDS` | Same, for that tenant only | next request |
| `set:tenant-flag … --value false --commit` | Same, without a deploy | ≤60 s (flag cache) |

Rollback does not touch existing conversations: the user and assistant messages Hermes wrote are ordinary `clio_messages` rows (metadata `runtime: "hermes"`), so history stays visible. In-flight Hermes runs finish or are stopped through `POST /api/clio/hermes/runs/:id/stop`; the prototype run store is process-memory, so an API restart during a run leaves that run `interrupted` and the fresh-attempt contract applies (`contracts.md` §Run lifecycle). Harness check ISO5 exercises the flag-off path.
