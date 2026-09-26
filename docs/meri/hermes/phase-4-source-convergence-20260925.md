# Phase 4 source convergence, 2026-09-25

This branch starts at Meri integration commit `1819f13fc` and converges the
catalog handshake (`d30b759e1`, `80b35591a`, `bb1f3da57`), API durable
idempotency check (`63d539155`), and worker exact signed replay (`2ee1646a2`).
The dormant broker policy subset at `26109b4c5` was already on the base.
These are source changes only. The application adapter still uses the legacy
`createRun`; `createRunWithToolView` requires an explicit client flag, and the
worker overlay and runtime flag both default off. No deployment or live QA
is implied by this convergence.

## Gates before activation

1. **Retry-safe uncertain-dispatch protocol.** Choose and review either a
   protected API outbox that stores the complete signed `/v1/runs` body,
   idempotency key and authenticated scope before dispatch and reuses those
   exact bytes, or a cross-host transactional no-copy reservation/seal
   protocol that durably binds the authenticated dispatch intent and exact
   request identity before a late POST can execute. Define ownership,
   transaction boundary, reconciliation, expiry, retention, crash recovery,
   revocation and broker-effect idempotency. The current client signs a fresh
   `expires_at` for each call, so reconstructing a retry changes the body and
   the worker correctly reports an idempotency conflict. The worker's retained
   fingerprint/run state is not either complete protocol. The isolated
   SQLite-on-EFS seal prototype is not a proven cross-host transaction store
   and is excluded from this source convergence.
2. **Canonical catalog mapping.** Connect Phase 3/4's trusted capability
   registry to the compile input and establish an explicit, versioned mapping
   from each Meri capability to the worker's exact tool name and schema.
   Supply the canonical `catalog_version`, required dependencies, deployment
   ceiling, and server-resolved authorization. Compare the resulting catalog
   contract with the worker-owned digest. The digest detects worker schema
   drift; it does not establish cross-system canonical equality or broker
   permission. Run-local memory/context tools outside the raw worker catalog
   require their own reviewed contract before selection.
3. **Availability.** Provide a current, trustworthy connector availability
   snapshot to the compiler, with a policy for staleness and required-tool
   failure. The worker catalog digest describes registered schemas, not live
   connector health. The broker must continue to recheck execution
   authorization at invocation.
4. **Verification.** Review the integrated source diff and run the deferred
   focused API and worker regressions, static guardrails, typecheck, pinned
   archive and opt-in built-image contracts, authenticated capability and
   concurrent signed-run checks, MCP refresh and background-review cases,
   and deployed acceptance when those activities are authorized. Rebuild the
   exact pinned worker image before treating prior built-image evidence as
   evidence for these changes. No Jest, typecheck, build, database, Docker,
   browser, provider, or live QA was run for this source convergence.

The detailed prototype and previous local evidence are in
`phase-4-request-local-tool-view-v1.md`; none of that evidence qualifies the
new catalog or replay revisions without the deferred gates above.
