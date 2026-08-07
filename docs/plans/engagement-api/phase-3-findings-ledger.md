# Phase 3 — Findings Ledger

Every defect found during Phase 3, its classification, and its disposition.
Phase 3 cannot close until **open P0 = 0, open P1 = 0, blocking P2 = 0**
(plan, micro-session 3.R).

Repairs happen in a dedicated 3.R session per coherent finding — never as a
silent fix inside an unrelated session (master execution prompt, rule 14).

**Status:** 1 open (P1) · 1 closed

| ID | Severity | Classification | Surface | Summary | Status |
|---|---|---|---|---|---|
| F-001 | P1 | current baseline defect | build tooling | Phase 2 verifier's "no product web change" gate fails on every descendant branch | **closed** |
| F-002 | P1 | current baseline defect | build tooling | No-preview-header guard forbids the exact string Phase 3 must introduce | open — repair sequenced with 3.3 |

---

## F-001 — Phase 2's "no product web change" gate fails on every descendant branch

**Severity:** P1 — blocks `verify:engagement-phase-3`, whose stage 1 must run the
Phase 0–2 verifiers (plan, 3.13).
**Classification:** current baseline defect (accepted Phase 2 work, surfaced by
Phase 3).
**Owning boundary:** `scripts/verify-engagement-phase2-code.sh`.

### Reproduction

```bash
git checkout agent/engagement-api-phase-3-full-ui-parity
git diff --name-only 47902517c7dd64a408a87cef57323812407c29c8 HEAD | grep -E '^apps/web/'
```

At commit `b51d404d` this prints
`apps/web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json`,
and the gate reports **FAIL — product web source was modified since the Phase 2
base**.

### Why it is a defect and not expected behaviour

The gate asserts a property of **Phase 2's own commit range** — Phase 2 was a
dark-infrastructure phase and legitimately must not touch product web. It
implements that by comparing `PHASE2_BASE..HEAD`, so it re-evaluates on every
later commit and mislabels *any* descendant's web change as a Phase 2 scope
violation.

Phase 3 must change `apps/web`. The plan itself specifies the offending path:

> `apps/web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json`
> — plan, micro-session 3.1, Proposed files

So the conflict is inherent to the phase sequence, not to how 3.1 was
implemented. 3.3 will widen it further (`App.tsx`, `api-client.ts`).

### Main vs preview

Not applicable — a build gate, not a runtime behaviour.

### Evidence

- Gate source: `scripts/verify-engagement-phase2-code.sh:255-259`
- Phase 3 plan, micro-session 3.1 "Proposed files"
- Reproduced at `b51d404d`

### Repair — CLOSED

Applied in the 3.R session committed alongside this update.

The check moved out of inline bash into `scripts/verify-engagement-phase2-scope.mjs`,
with the range bounded to `PHASE2_BASE..PHASE2_HEAD` (`3841a5ee`, overridable via
`ENGAGEMENT_PHASE2_HEAD_SHA` exactly as `PHASE2_BASE` already was). The assertion
keeps its meaning — *Phase 2 did not touch product web* — and stops re-evaluating
against descendants.

**Smallest owning boundary.** Only the web gate was rescoped. The frozen-Compute-stack
and migration gates immediately below it use the same `BASE..HEAD` shape, but they
are **correct** open-ended: Phase 3 must not touch `compute-stack.ts` or add a
migration either, so the wider assertion is worth keeping there. Rescoping all
three would have been the tidier-looking change and would have silently dropped
two live protections.

The predicate is exported and pure so the negative control proves it still bites,
rather than asserting that a shell `grep` was spelled correctly.

**Regression test:** `scripts/verify-engagement-phase2-scope.spec.mjs` (7 assertions)
pins the exact distinction the old gate could not make — the real Phase 2 range
must be clean, while the real Phase 3 range is allowed to touch `apps/web`. That
test also fails if F-001 ever stops reproducing, so it cannot rot into a
tautology.

**Verified:** `OK  no product web source change in 47902517..3841a5ee (61 files in range)`.

The gate was not deleted. Phase 2 note 9 applies: never widen a check by removing it.

---

## F-002 — The no-preview-header guard forbids the exact string Phase 3 must introduce

**Severity:** P1 — will fail deterministically at micro-session 3.3.
**Classification:** current baseline defect (superseded premise).
**Owning boundary:** `scripts/verify-engagement-web-no-preview-header.mjs`.

### Reproduction

Not yet failing at `b51d404d` — the guard passes today. It fails the moment 3.3
lands, because the guard rejects the literal token anywhere under
`apps/web/src`:

```js
const FORBIDDEN = ['X-Capiro-Engagement-Preview', 'VITE_ENGAGEMENT_API_URL', ...]
```

and Phase 3's preview activation contract requires the web to send exactly that
header on Engagement routes in preview mode.

### Why it is a defect and not expected behaviour

The guard's premise is stated in its own header comment:

> that header is a routing decision the API layer never delegates to the browser

That was true through Phase 2, when the header existed only so an operator could
reach the dark service by hand. Phase 3 changes it deliberately: the browser
becomes the thing that sets the header, session-scoped, on Engagement routes
only. The guard therefore encodes a premise Phase 3 supersedes.

The risk of getting the repair wrong is real. The property worth protecting is
**not** "the string never appears" but "the header is never sent in normal mode,
and never on a non-Engagement route." Deleting the guard would drop that
protection entirely at the exact moment it starts to matter.

### Evidence

- Guard source: `scripts/verify-engagement-web-no-preview-header.mjs:26-31`
- Guard premise: same file, lines 5-10
- Phase 3 plan, "Preview activation contract"
- Invoked by `scripts/verify-engagement-phase2-code.sh:267-268`

### Proposed repair (3.R, sequenced with 3.3/3.4)

Replace the blanket string ban with a scoped assertion:

1. The token may appear **only** in the dedicated preview module
   (`apps/web/src/lib/engagement-api-preview.ts`) and its spec.
2. No other file under `apps/web/src` may reference it.
3. `VITE_ENGAGEMENT_API_URL` and the `localhost:4500` forms stay banned outright
   — Phase 3 routes through the existing base URL and the ALB preview rule, and
   never points the browser at the service directly.

That is strictly stronger than the current check for everything except the one
file that has to have it.

---

## Findings not yet triaged

None.

## Accepted baseline behaviour

None recorded yet.
