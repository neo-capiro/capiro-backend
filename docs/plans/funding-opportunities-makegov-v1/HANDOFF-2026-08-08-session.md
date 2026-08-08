# Handover — 2026-08-08 session (P40 part 3 shipped, P17 answered)

Committed to the repo deliberately. Four earlier handoffs in this program exist only on one machine's
local disk; this one does not.

**Everything below is on [PR #857](https://github.com/neo-capiro/capirov2/pull/857), which is OPEN and
NOT merged.** Three commits. Branch `agent/fo-p40-part3-dibbs-sync`, based on `main` at `d1d7030c`.

---

## The headline

**P40 part 3 is built, and P17's entitlement gate is CLOSED — `dibbs: supported`.**

A second result came free and matters more than it looks. The P17 probe calls through
`TangoDibbsClient`, which **throws** when a 200 response carries no `results` array. It returned
"Call succeeded." **So the pagination envelope is confirmed against a live response** — the largest
single unknown in P40, and it held.

Scope that precisely, because it is easy to over-read: the probe captures **no response bodies**. The
ENVELOPE is confirmed. Field types, null semantics and date formats in the mappers are still
conservative readings of published field names. Full contract validation has not happened.

---

## What shipped

| Commit | What |
|---|---|
| `0b6aec0c` | P40 part 3 — the DIBBS sync. All ten deliverables from `HANDOFF-P40-part3.md`. **D-63.** |
| `f801297e` | **D-64** — the P17 probe had D-62's error compiled into it, with a test pinning it. |
| `0c27fec0` | **D-65** — rate limiting, found by the live probe. |

New files: `tango-dibbs.client.ts`, `sync-tango-dibbs.ts`, `sync-tango-dibbs.spec.ts`.
Modified: dispatcher, FO tsconfig, ingestion schedule, FO CI, probe service + specs, decision log.

**No migration added. No schedule enabled. No AWS or deployment change.**

---

## Three decisions that will look like mistakes if you don't know why

### D-63 — this sync keeps no `tango_sync_checkpoint` row

Every other FO sync resumes from that table. This one cannot: `resource_type` carries a CHECK admitting
only `entity, opportunity, notice, forecast, vehicle, vehicle_awardee`, never widened by any migration.
A DIBBS checkpoint is unstorable.

It would also be the **wrong abstraction**. A checkpoint stores a modification-time high-water mark, and
DIBBS publishes no `modified_after` — only `issue_date_after` / `issued_date_after` / `posted_date_after`.

**So the window is an ISSUE-DATE window, not a modification window.** A solicitation amended after issue
never re-enters it, and the incremental run still reports `complete`. `--full` is the mitigation; the
shipped (disabled) schedule pairs a daily incremental with a weekly full reconciliation.
**A schedule that only ever runs the incremental will drift, silently.**

### The client throws on an unexpected envelope

Unlike `TangoSubawardClient`, which returns `items: []`. An empty page is indistinguishable from a clean
end-of-walk, so a wrong envelope would end every run with "0 records, complete" — the quietest possible
way to be wrong. **On a mismatch: update the contract doc and capture a fixture. Never widen the client
to accept both shapes.**

### D-65 — rate limiting is a normal operating condition here

**The account is capped at 25 requests per ~31 seconds.** A page-complete walk reaches that routinely.

The sync as first written had **no handling at all** — a 429 propagated out of `walkEndpoint` and would
have killed all three endpoint walks. Now: rate metadata on `TangoDibbsHttpError` so `Retry-After` is
honoured rather than guessed, bounded retry, a proactive pause on `remaining: 0`, and a throttle that
outlasts the retries stops **one endpoint**, never the run.

The unit fakes never return 429. That is exactly why 27 passing tests did not catch it, and the whole
argument for the live gate.

---

## Baselines — judge the next phase on what it introduces

- **api typecheck: 12 pre-existing errors**, none in funding-opportunities code. Measured three times
  this session (at `main` d1d7030c, after part 3, after D-65) — never moved.
- **FO CI floor: 82 suites / 2564 tests**, raised from 81/2528. **Entirely this work's**: +27 sync spec,
  +1 dispatch row, +2 probe spec (D-64), +6 rate-limit (D-65). Measured against real Postgres 16 on a
  clean migration replay, zero failures and zero skips.

A prior session's worry that #856 had staled these was **wrong** — the FO suite list is enumerated, and
#856's new `src/intelligence/news/` spec is not in it. Don't re-litigate.

---

## Open items

| Item | Owner |
|---|---|
| **Rotate the Tango API key** — it was pasted into a chat transcript this session. Update the `tango` secret in Secrets Manager too, or the probe fetches a stale value and reports an auth failure that looks like an entitlement problem. | Neo |
| ~~Merge or review PR #857. GitHub Actions is `startup_failure` repo-wide, so the local gate run is the only evidence.~~ **Reviewed and merged 2026-08-08 as `094daf1d`.** Actions was still `startup_failure`, so it merged on the local gate run alone — no CI evidence exists for it. | done |
| **Full live contract validation** — record CONTENTS, not just the envelope. Still the real gate before anything is trusted. | out-of-band |
| **SBIR/STTR entitlement is UNKNOWN, not refused.** `not_attempted` because P42/P43 have built no client. | P42/P43 |
| `20260908010000_tango_dibbs` is **deliberately not applied to `capiro-dev`**. Correct state, not an oversight. | — |
| Both DIBBS schedules ship `enabled: false`. Enable the incremental first, read one run's summary, then the full. | P50 |
| ~~`C:\dev\p17.cmd` points at a session scratch clone. After #857 merges, change its `REPO=` line to `C:\dev\capirov2`.~~ **DONE, but not as written — see D-66.** `C:\dev\capirov2` is the one path it must never point at, which the "Traps" section below already said four rows down. It now points at `C:\dev\capiro-p17-wt`, a detached worktree at `094daf1d`, and the launcher is vendored into `operator/`. | done |
| No phase in this program has ever had an independent review. Unchanged. | — |

---

## Traps this session hit, so you don't

- **`tsconfig.funding-opportunities.json` requires EVERY new FO script.** Its own header says so. A script
  not listed is typechecked by nothing.
- **`p17-tango-capability-report.json` (2026-08-07) has two SUPERSEDED rows** — `dibbs` and `sbir_sttr`.
  The file was left unmodified on purpose: editing a captured artifact to match a later understanding is
  how records stop being evidence. Cite the D-65 run instead.
- **Plan §4.6: no key through an agent session.** Standing `capiro-dev` AWS approval does not override it.
  Probe runs go through `C:\dev\p17.cmd`, operator-run.
- **PowerShell 5.1 on this box reads BOM-less UTF-8 as Windows-1252.** An em-dash becomes `â€"`, whose
  embedded quote breaks parsing several lines later. Keep `.ps1` files ASCII.
- **PowerShell has no inline env-var prefix.** `VAR=x cmd` is bash and silently does nothing useful here.
- `C:\dev\capirov2` sits on `agent/fo-p36-outcome-capture` with other agents working on it. Don't switch
  its branch; use a separate clone or worktree.

---

## Where to read, in order

1. `dibbs-sbir-rest-contract.md` — the provider contract, confirmed vs. unconfirmed marked explicitly
2. `HANDOFF-P40-part3.md` — the part-3 spec, now annotated with what was actually delivered
3. `tango-dibbs.mapper.ts` header — why every coercion is provisional
4. `sync-tango-dibbs.ts` header — the window semantics, in full
5. Decision log **D-56 → D-65**
6. Rollout runbook §30, 30a–c — before any deploy thought
