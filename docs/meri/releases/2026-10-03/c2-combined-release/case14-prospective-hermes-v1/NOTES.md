# Case14 prospective pending-memory setup — preparation only

This directory is a prospective local recipe and run note, not a fixture receipt, plan result, or execution authority. `NEW_UUID_V4_REQUIRED` is intentionally invalid; no Case14 fixture instance or prior approval is asserted. No command was run against the API/database, and no application, journal, provider, cloud, or fixture state was changed.

## Inputs grounded in the reviewed evidence

- Tenant T1: `f2d6cf8f-057c-479a-8110-62fe5086d43f`, slug `meri-foundation-20260928-t1`.
- Pat: `b1f758fc-17bd-40f8-bef2-fa2d2380300f`, Clerk `user_3Jw2FvWZkYGKmxWGx13tNJxFD2A`; Case14 context must be `standard_user`.
- Priya: `fb218bf5-2674-4ced-bca3-7a5d0c01592f`; Aster client: `41f9ec63-3963-479f-b747-59a3767ef44b`.
- The three actor and three client mappings in the recipe are from `case17-regression-v3-prepared.json` solely as identity mappings. Its Case17 instance and candidate IDs are not reused.
- Frozen source selection for caseId `14` is exactly `MEM-PROPOSAL-14` (pending synthetic Aster candidate; Pat proposer, Priya reviewer). Existing source selection derives the candidate physical ID from a fresh instance UUID; do not provide or guess a candidate ID.
- Latest exact native Case14 owner read: `CANONICAL_OWNER_ABSENT`, operation absent, rollback observed, zero provider calls/writes, no acceptance authority. This supersedes the earlier protected-read uncertainty only for that observation. It is not approval or execution authorization. Cleanup is stopped/inactive. Served API SHA at that observation remains `4f0253874357c272fda1ae2a5271ee4af645f0bc`; source repair/build and any newer package are lead-owned.

## Exact recipe and plan command

The existing CLI accepts an input object with exactly the top-level key `recipe`, or `recipe` plus `expectedPlanSha256` for execute. The recipe has exactly: `schemaVersion`, `target`, `fixtureNamespace`, `caseId`, `fixtureInstanceId`, `ctx`, `clerkUserId`, `actors`, `clients`. See `prospective-recipe.template.json`; replace only the UUID placeholder with a newly generated lowercase UUIDv4 before any live plan. Do not treat that replacement as evidence that a fixture exists.

Lead-only, after separately confirming current source/package and operation status, the native plan invocation is:

`node scripts/meri-pending-memory-setup.mjs plan --input-env MERI_PENDING_MEMORY_SETUP_INPUT --out <absolute-new-plan-receipt.jsonl>`

Run from `C:/dev/main/meri-c1-20261002/apps/api`. `MERI_PENDING_MEMORY_SETUP_INPUT` must contain JSON `{ "recipe": <the exact recipe> }`. `--out` must be a new absolute path (the CLI opens with exclusive create). Existing script requires `DATABASE_URL`; the existing dependency factory additionally requires `MERI_SYNTHETIC_FIXTURE_NAMESPACE=meri-foundation-20260928`, all four governance flags `MEMORY_GOVERNANCE_LIFECYCLE`, `MEMORY_GOVERNANCE_CENTER`, `MEMORY_GOVERNANCE_ENFORCE`, `MEMORY_CLIENT_REVIEW` equal `enforce`, and `MEMORY_GOVERNANCE_TENANTS` to include both exact authorized T1 and T2 UUIDs. Use only the approved existing private DB runtime/configuration; this note does not provide credentials or authorize calls. Do not add provider credentials, install a budget, or launch an alternate service graph.

## Plan semantics / stop conditions

`plan` dispatches to `inspectPendingMemorySetup`, not execute. The wrapper first validates Pat's current active `standard_user` membership and Clerk identity, then installs the existing memory-governance tenant scope and Pat tenant context; the inspection itself runs through `withTenantUser` as that ordinary Pat actor. It validates the synthetic namespace and Aster client wall; selects the frozen Case14 record; reads tenant settings/version and requires no `pendingMemorySetups['14']` operation; and requires the deterministic candidate to be absent. It emits a content-addressed plan containing recipe hash, manifest content hash, tenant row version (`xmin`), prior settings hash, source IDs, and `liveAcceptance: NOT_RUN` plus `planSha256`. The hashes/version are runtime results and are deliberately not prefilled here.

This is application-level no-write planning, not a PostgreSQL READ ONLY transaction: current checks use `FOR UPDATE` on the tenant and `FOR SHARE` on actor/client rows, and canonical owner reads may take their source-required locks. It does not create a candidate or claim. A hash does not attest fixture readiness or authorize execution.

If the existing Case14 operation appears, planning stops with `PENDING_MEMORY_EXISTING_OPERATION_REQUIRES_RECONCILIATION`; recover and reconcile that operation/locator, never reset it or choose another instance to evade it. Existing candidate, identity, membership, tenant, or client-wall mismatch is also a stop, not a retry invitation. The claim and candidate creation happen only in the separate `execute` path, which requires a fresh exact plan hash and durable journal; this preparation grants neither permission nor authority to run it.

## Minimal lead-owned lifecycle / next branch

1. Confirm the currently packaged API/source and perform the canonical Case14 owner read before planning; re-check current Pat identity. Do not rely on a past absence if state may have changed. Keep this local preparation separate from the lead-owned source repair/build.
2. Only if the fresh scoped read confirms operation absence, produce a new UUIDv4 recipe from this template, run the existing `plan` command above, and retain its exact output, `planSha256`, tenant row version, prior settings hash, and manifest hash. Do not execute as part of planning.
3. Reconcile the fresh result: `CANONICAL_OWNER_PENDING` → use the existing one-decision approval path only with its own explicit authority; `CANONICAL_OWNER_APPROVED` → do not replay approval, preserve actual audit/item/version and prepare recall prerequisites separately; `CANONICAL_OWNER_ABSENT` → prospective plan may proceed if all checks pass; claimed/invalid/other operation → stop and reconcile. No branch here authorizes approval or capture.
4. Any later setup execution is a distinct lead decision/path requiring current revalidation and the exact returned plan hash. It can create only the canonical pending Case14 candidate and claim; it does not approve, bind, call a model/provider, or establish live acceptance. Preserve its journal and reconcile partial outcomes rather than reset/retry.

Prohibited in this preparation: execute, bind, approve, provider-budget plan/install, new conversation or model turn, candidate-ID guessing, reset, journal reserve/restore/adopt/refund/settle, Case20 rerun, or any mutation of repository, fixture, or journal state.