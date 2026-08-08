# Phase 7 — Hand-over notes (session 8)

## Where things stand

A–L merged to `main`. M partial and unchanged from session 7 (1 of 36 read
methods migrated; the two gaps blocking the rest are still open). **N is now 7
of 8 verbs**, with the eighth blocked for a real reason rather than for time. O
untouched.

Unlike session 7, **this session's work is committed**: branch
`agent/pe-budget-canonical-promotion-cutover-v1`, base `1553f7706`. Session 7's
tree was committed first, as its own commit, after being verified.

Authoritative spec: `phase-7-verified-canonical-promotion-production-cutover-v1.md`
(supplied out-of-band; not in this repo). Gaps escalation:
[`docs/defense-budget/PHASE-7-ARCHITECTURE-GAPS.md`](../defense-budget/PHASE-7-ARCHITECTURE-GAPS.md).

---

## 1. The session-7 anomaly is resolved — it was a real regression

Session 7 flagged "an unexplained 1-line change in
`line-reference-resolver.ts` I didn't make and can't attribute", left it
untouched, and excluded it from consideration.

It was not cosmetic. It replaced the accountless-procurement guard's
fail-closed `return []` with a code-only match, dropping the `account`,
`advanceProcurement`, and `component` filters. At
`line-reference-resolver.ts:102` a single context match becomes
`acceptedBinding(..., 'code_plus_unique_context', 1)` — so a reference carrying
no account namespace would bind **at confidence 1.0**, across account and
base/advance-procurement boundaries. That is negative control 14 (native
identity conflated), Workstream G's "keep base and advance procurement
distinct", and the doc comment three lines above the change.

Evidence gathered before touching it:

| Check                             | Result                                                                 |
| --------------------------------- | ---------------------------------------------------------------------- |
| `line-reference-resolver.spec.ts` | **23/23 passed** — nothing caught it                                   |
| `prettier --check`                | **failed** (single 140-char line) — never went through the format gate |
| mtime                             | `20:00:19`, ~6 min after session 7's last edit (`19:54:16`)            |
| `git stash` / reflog              | empty / clean                                                          |

**Reverted.** The gap that let it pass: the existing bare-short-code test only
rejects because three fixtures collide on code `12`, so the resolver returns
`conflicting`. The single-entry case — one line in the index sharing the code,
which is the realistic single-account manifest — was untested. Added as
`line-reference-resolver.spec.ts:143` and demonstrated as a negative control:
injected → failed with exactly the intended assertion (and bound a _base_
reference to an _advance-procurement_ line, confirming the base/AP crossing) →
reverted → 24/24.

The original diff is preserved outside the repo at
`scratchpad/stray-line-reference-resolver.patch`. **Provenance was never
established.** Nothing in the tree explains the write. Worth a look at what else
has write access to `C:\capiro-build`.

---

## 2. What shipped

### Workstream N — five more operator verbs

Seven of eight are now wired into `entrypoint.sh`:

| Verb                                  | Mode                 | Notes                                                  |
| ------------------------------------- | -------------------- | ------------------------------------------------------ |
| `plan-…-v1`                           | read-only            | deterministic plan id + snapshot id derived from scope |
| `validate-…-v1`                       | read-only            | blocking vs advisory checks; exit 3 on invalid         |
| `compare-…-canonical-reads-v1`        | read-only            | spawns one Nest boot per read mode                     |
| `execute-…-v1`                        | promoter role        | dry run unless `--commit --confirm <env>`              |
| `rollback-defense-budget-snapshot-v1` | promoter role        | same gating; deletes nothing                           |
| `status-…-v1`                         | read-only            | session 7                                              |
| `resume-…-side-effects-v1`            | writes one pause row | session 7                                              |

Three design points worth carrying forward:

- **`execute`/`rollback` read `PROMOTER_DATABASE_URL` and never fall back to
  `DATABASE_URL`.** A missing promoter URL is a usage error, not a reason to
  reach for whatever else is in the environment. `entrypoint.sh` deliberately
  does not call `compose_database_url` for these two.
- **`--commit` requires `--confirm <environment>`** echoing the target exactly.
  A plan id pasted against the wrong environment is the realistic operator
  error.
- **`compare` spawns itself once per read mode.** `PeSnapshotGateService`
  resolves the mode from `ConfigService`, bound at Nest boot; there is no
  supported way to flip it mid-process, and calling the private legacy/snapshot
  methods directly would compare something other than what the service serves.

### A production projection source

`src/defense-budget/promotion/promotion-projection-source-prisma-v1.ts` did not
exist. The only `PromotionProjectionSourceV1` in the repo was declared inline in
the engine rehearsal and hardcodes its lineage (`artifact-1`, `doc-1`, `ev-1`).
A plan built from it would bind every canonical row to provenance that does not
exist. The new source reads the real lineage columns the Phase 5 projection
schema already carries, derives the identity row's provenance from its own first
funding row in deterministic order, and **reports a family it cannot read**
rather than contributing a silent zero.

Only `om` has a reader. `plan --families rdte` exits 3 naming the family, which
is the invariant that unsupported items block rather than disappear.

### Gates that did not exist

- **`tsconfig.phase7.json`** — `tsconfig.json` excludes `scripts/`, and no other
  focused config covered the Phase 7 CLIs, so **none of them were typechecked by
  anything**. Adding the config immediately surfaced 12 errors: 2 real ones in
  new code (`import.meta` is a compile error under this CommonJS target) and 10
  pre-existing in session 7's engine rehearsal, which had never been typechecked.
  All fixed.
- **`verify:pe-budget-phase-7`** — the plan's Workstream O item 1. Only the
  `:db` variant existed.

---

## 3. What is blocked, and why

`authorize-defense-budget-promotion-v1` is the one unbuilt verb. **There is no
eligibility table in any migration**, and the authorization service derives
segregation-of-duties evidence from the eligibility _record_, not its hash:

```ts
const segregation = deriveSegregationEvidenceV1(plan.eligibility, request.authorizerActorId);
```

Fabricating a record to get past this makes `deriveSegregationEvidenceV1`
vacuous — authorizer-equals-reviewer and authorizer-equals-extractor both
silently pass, defeating negative controls 1–3 and invariant 3. Taking it from
the operator is refused by the service's own contract ("never taken from the
requester"). So it was left unbuilt, consistent with session 7's decision on the
other six.

This is Gap 3 in the escalation doc, alongside session 7's two. It needs a
migration and a repository, which is Workstream A/D territory — the plan is
explicit that A–D define the production trust boundary and must not be split
across parallel agents.

**Not blocked by it:** `execute` and `rollback` only ever compare
`eligibilityHash` as a string. Both shipped.

---

## 4. Baselines

All local. Every phase run as its **full named script**, which the last two
sessions did not do.

| Check                                                    | Result                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `verify:pe-budget-phase-1`                               | **PASS** — 859 tests, 59 suites, 33s                                                                               |
| `verify:pe-budget-phase-2`                               | **PASS** — 840 tests, 58 suites, 29s                                                                               |
| `verify:pe-budget-phase-3`                               | **PASS** — 216 tests, 16 suites, 68s                                                                               |
| `verify:pe-budget-phase-4`                               | **PASS** — 305 tests, 20 suites, 87s                                                                               |
| `verify:pe-budget-phase-5`                               | **PASS** — 358 tests, 28 suites, 30s                                                                               |
| `verify:pe-budget-phase-6`                               | **PASS** — 780 tests, 78 suites, **and 24/24 negative controls**, 521s                                             |
| `verify:pe-budget-phase-7` (new)                         | **PASS** — 612 tests, 26 suites                                                                                    |
| `verify:pe-budget-phase-7:db`                            | **PASS, exit 0** — **229 checks** (102 shell + 24 engine + 39 drain + 32 read + **32 new plan/validate**), was 196 |
| `tsc -p tsconfig.phase7.json` (new)                      | **0 errors**                                                                                                       |
| `tsc --noEmit -p .`                                      | **6 errors**, unchanged documented baseline                                                                        |
| `jest src/program-element src/defense-budget src/config` | **3435 passed, 258 suites** (was 3423 / 257)                                                                       |
| `prettier --check` on every file touched                 | clean                                                                                                              |
| `git diff --check`                                       | clean                                                                                                              |

Two notes on phase 6, both worth carrying forward:

- **It completed for the first time.** Session 7 reported the negative-control
  script timing out at 200s after 5/24. Run without a competing rehearsal it
  finishes in 521s and all 24 pass. The earlier timeout looks like contention,
  not a defect.
- **It needs `DATABASE_URL` set in the environment** and there is no
  `apps/api/.env`. `prisma validate` refuses to parse the phase-6 projection
  schema without it (`P1012`), which fails the script at 13s before any test
  runs. A placeholder value is sufficient — `validate` never connects. This is
  almost certainly why it has been skipped: it looks like a failure and is an
  environment gap.

### What the new rehearsal section proves

The 32 new checks spawn the **real CLIs** as the `capiro_app` serve role, so a
missing SELECT grant would fail there rather than in production. Beyond the
happy path they pin: the plan hash reproduces across two runs of an unchanged
scope (`ecd03ef4…`), the derived snapshot id is stable, an unreadable family
exits 3 and is _named_, validate refuses an unknown plan id and a drifted plan,
and drift is attributed to the pointer check specifically rather than to a
document that also happened to change.

Three of those checks exist because writing them failed first:

1. Sharing FY2027 with the engine rehearsal made the plan legitimately cover 4
   items, not 2 — correct behaviour, useless assertion. Fixed by isolating the
   fiscal year, and now asserted directly ("every planned item belongs to this
   section's SAG").
2. Splicing the args array by index to swap the family silently dropped
   `--eligibility-hash`, so the unreadable-family case failed on a usage error
   instead of the thing it tested. Replaced with a builder.
3. Staging drift by `UPDATE`-ing the filed plan was **refused by the
   append-only trigger** — Workstream D working as intended. Drift is now staged
   by filing a second plan, and the refusal itself became a check.

---

## 5. Next steps, in order of value

1. **Escalate the three gaps.** Two are now on their third session. The
   escalation doc is written and ready to file; it has not been filed anywhere
   outside this repo.
2. **Close Gap 3** — it is the smallest of the three and unblocks the last verb
   plus any real operator promotion path.
3. **Migrate `BudgetLinesReadService`'s 9 methods.** Not blocked by any gap;
   session 7's pattern applies directly.
4. **Extend the projection source to the other four families** as their readers
   become possible. Each one currently exits 3 by design.
5. Workstream O proper: the 32 negative controls, production-scale fixtures, and
   the runbooks. Untouched.

---

## 6. Safety confirmation

| Action                 | Occurred                                |
| ---------------------- | --------------------------------------- |
| commit                 | **yes** — 3 commits on the agent branch |
| push                   | no                                      |
| PR created/updated     | no                                      |
| merge                  | no                                      |
| deployment             | no                                      |
| AWS change             | no                                      |
| shared migration       | no                                      |
| production backup      | no                                      |
| production promotion   | no                                      |
| active-snapshot switch | no (disposable container only)          |
| rollback               | no                                      |
| paid parser call       | no                                      |
| production-data access | no                                      |
| alert fan-out          | no                                      |

`PE_LEGACY_BUDGET_WRITES` remains deliberately unset;
`capiro-dev-watch-budget-docs` will still exit 64 on the next deploy of this
branch, unchanged from session 7 and still accepted.
