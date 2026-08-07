# Phase 3 — Findings Ledger

This file began as the narrative findings ledger for micro-sessions 3.0–3.3.
The authoritative closeout ledger is now:

```text
docs/plans/engagement-api/phase-3-findings-ledger.v2.json
```

The JSON ledger is machine-checked by `scripts/verify-engagement-phase3-scope.mjs`
and is the source of truth for Phase 3 closeout counts.

## Current closeout counts

```text
Open P0:        0
Open P1:        0
Blocking P2:    0
```

## Findings

| ID | Severity | Classification | Surface | Summary | Status |
|---|---|---|---|---|---|
| F-001 | P1 | current baseline defect | build tooling | Phase 2's no-product-web gate re-evaluated descendant Phase 3 web changes as Phase 2 scope drift | **FIXED** |
| F-002 | P1 | current baseline defect | build tooling | Phase 2 web guard forbade the preview header Phase 3 deliberately introduces | **FIXED** |
| F-003 | P2 non-blocking | current baseline defect | build tooling | broad `apps/api` typecheck short-circuits on pre-existing defense-budget TS6059 errors and suppresses later tsconfig projects | **BASELINE_ACCEPTED**; Phase 3 invokes its acceptance tsconfig directly |
| F-004 | P1 | preview-routing defect | URL/history/cache | React Query could reuse data across main/preview and accept an in-flight old-mode response after a mode transition | **FIXED** |
| F-005 | P2 blocking | fixture/harness defect | local browser harness | deterministic fixtures use synthetic Clerk identities and could not authenticate a real browser session | **FIXED** via runtime-only auth binding in the disposable DB |
| F-006 | P1 | Phase 3 security regression | local browser harness | initial local-runner design placed temporary bearer material inside the retained evidence tree | **FIXED**; bearer lives in OS temp storage and is deleted during cleanup |

## F-001 — Phase 2 descendant-scope verifier

**Owning boundary:** `scripts/verify-engagement-phase2-code.sh`.

The original Phase 2 web-scope check compared the Phase 1 base through current
`HEAD`, so any legitimate Phase 3 web change caused the Phase 2 prerequisite to
fail. The repair extracted the check into
`scripts/verify-engagement-phase2-scope.mjs` and bounded the property to the
actual accepted Phase 2 range (`PHASE2_BASE..PHASE2_HEAD`). Migration and frozen
Compute-stack checks deliberately remain open-ended because Phase 3 must still
not change either.

Negative controls prove the real Phase 2 range is clean while a fabricated web
change inside that range is rejected.

## F-002 — Preview-header containment guard

**Owning boundary:** `scripts/verify-engagement-web-no-preview-header.mjs`.

Phase 2's blanket token ban encoded a premise Phase 3 intentionally supersedes.
The repair permits the exact preview token only in the dedicated preview module
and its spec, while `VITE_ENGAGEMENT_API_URL` and direct `localhost:4500`
references remain banned everywhere. The guard also rejects stale allowlist
entries whose file no longer contains the token.

Negative control: placing the token in an unrelated web source file fails the
guard.

## F-003 — broad API typecheck short-circuit

**Classification:** accepted pre-existing baseline; not a Phase 3 product defect.

The first `tsc --noEmit` in `apps/api`'s multi-project `&&` chain fails on four
pre-existing defense-budget `TS6059` imports, so later projects would otherwise
never execute. Phase 3 does not silently repair unrelated defense-budget specs.
Instead `pnpm verify:engagement-phase-3` directly executes:

```bash
pnpm -C apps/api exec tsc -p tsconfig.engagement-phase3-fixtures.json --noEmit
```

That narrow project includes the fixture plan/seed/spec plus the runtime auth
binder, external-action DB-invariant verifier, and safe-write interoperability
proof. The Phase 3 acceptance scripts therefore remain genuinely typechecked.

## F-004 — main/preview cache collision and in-flight race

**Owning boundary:** web axios + React Query mode transition.

Main and preview previously shared ordinary React Query keys, so a result from
one runtime could be reused as evidence for the other. A second race existed
when a request dispatched under one mode completed after the operator toggled.

Repair:

- mark every accepted Engagement request with dispatch-time `main` or `preview`;
- mark actual Engagement response objects at the axios boundary;
- cancel and remove only Engagement-owned queries on a real mode transition;
- preserve non-Engagement caches on mixed pages;
- reject old-mode responses with `ENGAGEMENT_PREVIEW_STALE_RESPONSE` even when
  the query function did not consume React Query's AbortSignal.

Negative controls cover both toggle directions and broad-key over-eviction.

## F-005 — deterministic fixtures versus real authentication

**Owning boundary:** local acceptance fixture harness.

The committed fixture contract correctly uses synthetic Clerk IDs so it stays
portable and byte-stable, but a real Clerk browser session cannot authenticate
as those identities. Replacing the committed IDs with environment-specific
values would make the fixture contract non-deterministic.

Repair: after deterministic seed, `bind-engagement-phase3-auth-fixtures.ts`
updates only Clerk identity columns on the disposable fixture users/tenants to
explicit dedicated acceptance actors. Fixture ids, roles, memberships, clients,
content and state remain unchanged. The binder refuses non-loopback databases
without the same explicit disposable-DB acknowledgement as the seed.

## F-006 — bearer material in retained evidence

**Owning boundary:** local acceptance runner.

During Stage 3.5 implementation, the first runner draft placed the browser
bearer-token path under `.artifacts/engagement-phase3-<sha>/`. That would have
made retained/uploadable acceptance evidence contain reusable auth material.

Repair:

- token file is created under `os.tmpdir()`;
- network evidence strips authorization/cookie/set-cookie headers;
- runner `finally` force-deletes the token;
- runbook explicitly requires that no bearer file exist under `.artifacts/`.

No version containing the unsafe token behavior was accepted as Phase 3 green.

## Closeout rule

Phase 3 may not report `PHASE3_CODE_COMPLETE_GREEN` unless the machine-readable
ledger remains at:

```text
openP0 = 0
openP1 = 0
blockingP2 = 0
```

and the permanent scope, prototype-boundary, DB-free, and local acceptance gates
support that result with execution evidence.
