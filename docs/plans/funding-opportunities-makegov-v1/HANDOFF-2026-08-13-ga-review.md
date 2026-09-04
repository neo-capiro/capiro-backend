# HANDOFF — 2026-08-13, GA-readiness independent review

**Read this file first, then jump to §10 for the latest state.** As of 2026-08-14 (pickup 2):
`:13` is registered (ACTIVE, revision 13, image `d800dcfde5`), and all 7 `fo-dev-*` EventBridge
rules are created DISABLED with targets verified at `:13`. The Tier 3.8 create is COMPLETE.
Enabling is a separate, later decision — do not enable until the gates in GO-NO-GO.md §decisions
item 3 are met. See §10 for the full, current picture — §§1-9 below are the 2026-08-13 state and
are kept for history, not all of it is still accurate.

- **Repo:** `neo-capiro/capirov2`
- **Pinned SHA for everything below:** `d800dcfde51f6cf21a4b54b511006b9001fd6d2b` (`origin/main`
  as of 2026-08-13 ~20:41 UTC — main has almost certainly moved since, on unrelated work; re-pin
  before trusting any file-line reference against a newer checkout)
- **Session's approved plan:** `C:\Users\neoma\.claude\plans\jaunty-wondering-candy.md`
- **Review worktree (uncommitted, detached, disposable):** `C:\dev\capiro-fo-ga-review-wt`
- **Published report for Neo:** the artifact URL is in the conversation this handoff came from —
  search for "Funding Opportunities · Independent Review" if you don't have it; the source HTML
  is also in the session scratchpad if the artifact link has expired.

---

## 1. What was asked, and why this got this big

Neo asked to check whether the DIBBS/SBIR rollout was actually visible in the live product
(`os.capiro.ai`). It wasn't — the UI showed the right filter options but zero rows for 3 of 5
sources. Neo then asked to "complete it," and when asked to scope that, picked **"Full program
completion (GA)."**

Live investigation immediately surfaced that "deploy + enable" was not sufficient: the program's
own `completion-matrix.md` states outright that **zero of the 52 phases have ever had a genuine
independent review** (§6.2 of the original plan), P49/P50/P51 are each explicitly "merged but
blocked," and new infrastructure risk was found that the existing docs didn't fully capture
(an at-risk ECR digest, an EventBridge naming collision with live schedules). That justified
entering Plan Mode and getting explicit sign-off on a tiered program rather than a single action.
Two decisions Neo made explicitly during planning:

- **GA's ingestion bar is "prove correctness, not completeness."** GA needs ≥1 dataset per rail
  at/near 100% (DIBBS-RFP and SBIR-solicitation already qualify) plus the zero-rows question
  resolved plus real end-to-end candidates verified for ≥1 client — **not** full-catalog
  ingestion, which would take many weeks under the real Tango rate limit and is explicitly **not**
  a GA blocker.
- **Paid Tango tier: flag it, don't pursue now.**

## 2. What this session actually did

**Tier 0/1 (investigation, all done):**

| # | What | Outcome |
|---|---|---|
| 0.2 | Does a docs-only PR trigger an ECR push? | No — path filter excludes `docs/**`, and CI is repo-wide `startup_failure` anyway |
| 0.1 | Protect the at-risk ECR digest | **NOT DONE** — needs Neo's go-ahead, see §4 |
| 1.3/1.4 | Flag/UI contradiction; disable-feature verb | Dropdown is correctly gated client-side; the **API underneath has zero flag logic** (this became the biggest single finding, P1-1 in the review); the live mutation test of enable/disable was **blocked by the auto-mode safety classifier** and never attempted |
| 1.5 | Root-cause "zero rows" from today's producer run | **Not a bug.** Proven via real SQL: none of Capiro's 14 real clients in the tested tenant have qualifying award history yet. Two *separate*, real, latent scoring bugs found along the way (see §5) |
| 1.6 | Diagnose 66 silently-failed SBIR writes | Best-supported hypothesis: an unvalidated `end_date >= start_date` CHECK constraint. Not proven (rows never reached the DB) — minimal safe repro documented, not yet run |
| 1.7 | `cdk diff` on `Capiro-dev-Compute` | Confirms real, current danger — see §5, P0-blast-radius items |

**Tier 2 (the independent review — the main output of this session):**

20 subagents total. Banded per the approved plan:
- **Band A** (one reviewer per highest-risk phase): P07/P08, P46, P49, P50, P51, the
  feature-flag-guard trust boundary, and the D-79/#943 producer-wiring diff itself.
- **Band B** (one reviewer per subsystem cluster, for boundary coverage a per-phase reviewer
  can't get): ingestion adapters, matching/scoring, lifecycle/events, UI/triage, alerting/
  observability, infra/deploy.
- **Band C** (attestation-only): confirmed P00 and P09 are genuinely inert.
- Every reviewer used `docs/runbooks/phase-2-independent-live-validation.md` (borrowed from the
  unrelated engagement-api program) as the independence convention: different reviewer than
  implementer, read-only verification, a two-string verdict, a dated approval record.
- **One more agent aggregated all 15 reports** into a deduplicated master findings queue and a
  proposed (not-applied) `completion-matrix.md` update.

**Result: 118 distinct findings (13 P0 / 27 P1 / 39 P2 / 27 P3 / 12 P4). 43 of 52 phases now
carry a real verdict — was 0 of 52 before this session.** 12 of 15 reviews rejected, 2 approved,
1 split.

## 3. Where everything lives

```
C:\dev\capiro-fo-ga-review-wt\                              ← clean detached worktree @ d800dcfde5
  docs\plans\funding-opportunities-makegov-v1\
    HANDOFF-2026-08-13-ga-review.md                          ← this file
    independent-review\
      MASTER-FINDINGS-QUEUE.md                               ← START HERE for full findings detail (93 KB)
      completion-matrix-updates.md                            ← proposed matrix edits, not applied (64 KB)
      band-a-p07-p08.md
      band-a-p46-webhooks.md
      band-a-p49-canary.md
      band-a-p50-schedule-enablement.md
      band-a-p51-ga-closeout.md
      band-a-flag-guard.md
      band-a-d79-producer-wiring.md
      band-b-ingestion-adapters.md
      band-b-matching-scoring.md
      band-b-lifecycle-events.md
      band-b-ui-triage.md
      band-b-alerting-observability.md
      band-b-infra-deploy.md
      band-c-attestation.md
      flag-ui-reconciliation.md
      eventbridge-drafts/                                        ← Tier 3.8 go/no-go (2026-08-14)
        GO-NO-GO.md                                              ← start here; nothing created
        *.put-rule.json / *.put-targets.json / index.json
```

**Nothing here is committed.** `git status` in that worktree shows only these untracked files.
`C:\dev\capirov2` (the "normal" checkout) was never touched beyond `git show`/`git log` reads —
it's still sitting on `agent/fo-p36-outcome-capture` with its own unrelated uncommitted work,
exactly as it was before this session.

## 4. Blocked on Neo — five decisions, none resolvable by an agent

1. **Does `funding_opportunities_dibbs` get built as a real flag, or does someone record a
   deliberate exception?** It does not exist anywhere in the codebase today — not a missing
   guard, a genuinely absent concept. Whatever gets decided, do it before the zero-rows question
   closes and real DIBBS candidates start getting written (see P1-1 in the master queue).
2. **What's the sanctioned mechanism to create the 7 new EventBridge schedules** (`SyncTangoDibbs`,
   `ReconcileTangoDibbsFull`, `SyncTangoSbir`, `ReconcileTangoSbirFull`, `ProcessTangoEvents`,
   `GenerateDibbsOpportunityCandidates`, `GenerateSbirOpportunityCandidates`)? The only in-repo
   mechanism is `cdk deploy Capiro-dev-Compute`, which this session confirmed **already caused a
   real incident on 2026-07-25** (deleted 76 rules + a task-def + both its IAM roles, attempted to
   replace the production Route53 records for `capiro.ai`/`app.capiro.ai`). Draft `put-rule`/
   `put-targets` calls, using a naming prefix that deliberately does NOT collide with CDK's own
   `capiro-${env}-*` convention, are needed before Tier 3.8 can proceed — not yet drafted.
3. **What does "design-partner acceptance" (P51's GA gate) actually mean?** The phrase appears
   exactly once in the whole program, undefined — no named client, no artifact, no stated
   authority. Can't close P51 without an operational definition.
4. **Go-ahead on the ECR digest protection (Tier 0.1, still open).** `capiro-dev-api-sync-jobs:12`
   is digest-pinned to `sha256:4208d7e9...`, currently 3rd-newest of 8 images in a
   "keep last 5" lifecycle policy on `capiro/dev/api` — a shared repo other services also use.
   Recommended: re-tag that specific digest to a dedicated retained tag (least-shared
   remediation) rather than touching the repo-wide policy. Needs a one-line yes before touching
   a policy other things depend on.
5. **Was flipping `funding_opportunities_sbir` to `true` for `capiro-internal` today
   intentional?** Confirmed live in the DB, created ~70 seconds after the D-79/#943 merge landed,
   with no record anywhere (no decision-log entry, no handoff) of who did it or why. Low risk
   today (no code enforces it server-side yet, no real SBIR data exists), but worth a direct
   confirmation — it's exactly the kind of undocumented live-state change this whole review
   effort exists to catch.

## 5. Two bugs worth fixing regardless of the decisions above

These are proven, not inferred, and independent of any rollout/GA sequencing question:

- **P46 (webhook receiver) silently and permanently loses every real delivery the provider's own
  SDK documents**, and separately, **its replay-protection can be forged** (proven: one real
  signed body replayed under 3 forged headers produced 3 distinct DB rows). Zero live testing has
  ever happened — the signing secret has never been wired to any environment. See
  `independent-review/band-a-p46-webhooks.md`.
- **P08's "double-click creates one task" guarantee is false under real concurrency** — proven by
  running 8 genuinely parallel calls against real Postgres (2 rows, not 1). No unique DB
  constraint backs the claim; the tests that should have caught this run only against a
  hand-written mock. See `independent-review/band-a-p07-p08.md`.

## 6. Full severity breakdown

| P0 | P1 | P2 | P3 | P4 | Total |
|---:|---:|---:|---:|---:|---:|
| 13 | 27 | 39 | 27 | 12 | 118 |

By class: 49 pure documentation (no risk to fix), 63 need a code/infra change, 6 need a human/
business decision as their *primary* classification (16 total carry some decision component).
Full detail, every finding cited to file:line, is in `MASTER-FINDINGS-QUEUE.md`.

**The single systemic theme, confirmed 6 independent ways:** this program cannot tell a working
run from one that silently did nothing. An ingestion log line reads byte-identical whether no
tenant had access, no data matched, or everything worked correctly. That mechanism is the direct
cause of today's zero-rows outcome and is still open in the alarms, every sync script, and the
canary's own acceptance checklist.

**Nine phases have no independent review at all yet:** P05, P20, P21, P31, P37, P38, P39, P44,
P45. Also worth stating plainly: this review verified code, real database behavior, and live AWS
state — it did **not** exercise the running application end-to-end in a browser. The P49 human
canary walk still hasn't happened.

## 7. Traps for whoever picks this up (cost real time this session, don't re-pay it)

- **A read-only-restricted review agent refused to run `cdk diff` or `aws ecs run-task` even
  after being told those specific calls are non-mutating.** Telling an agent "read-only
  investigation" makes it over-conservative about anything that *looks* like a write. If you need
  a genuine `describe`/`diff`/`get` call executed, say explicitly "this call does not mutate
  anything, you may run it" — don't rely on "read-only" alone.
- **The auto-mode safety classifier will block live enable-feature/disable-feature testing**, even
  framed as "test the disable path on a harmless flag." That's correct behavior, not a bug to work
  around — it needs Neo's explicit action, not a cleverer prompt.
- **Two reviewers disagreed on DIBBS/SBIR blast radius; the later one was right.**
  `flag-ui-reconciliation.md` said the producer CLI is "the only control." `band-a-flag-guard.md`
  found the scheduled command has no `--tenant` and selects every tenant with the *master* flag —
  so it's every master-flag tenant, not one. Trust the flag-guard review's version.
- **Reviewers that stood up a real disposable Postgres (seeded with real fixture data where
  available) found provable, quantified bugs. Reviewers restricted to reading code found the same
  shapes only as hypotheses.** If continuing this review into the 9 uncovered phases, default to
  "seed a real DB and execute the real code" over "read and reason."
- **`origin/main` moves fast and is shared with unrelated work.** Every file:line citation above
  is only valid at `d800dcfde5`. Re-verify against current `main` before trusting a line number.

## 8. Resuming each tier

- **Tier 0.1 (ECR):** get Neo's one-line yes, then `aws ecr batch-get-image` the digest and
  `put-image` it under a new, dedicated retained tag in `capiro/dev/api` (profile `capiro-dev`,
  region `us-east-1`).
- **Tier 3.8 (EventBridge):** drafted 2026-08-14 (this pickup session). Nothing created in AWS.
  Read `independent-review/eventbridge-drafts/GO-NO-GO.md` first. JSON is `fo-dev-*`,
  `State: DISABLED`, pinned to `capiro-dev-api-sync-jobs:12`. **NO-GO on create** until Neo
  answers, and even a yes cannot fire until `capiro-dev-syncjobs-execution-role` is added to
  the EventBridge invoker's `iam:PassRole` list (live gap, re-derived this session).
- **Tier 3.9 (flags):** blocked on decision #1 above and on confirming a tested disable path
  exists (Tier 1.4 found no evidence either way, live test never attempted).
- **Tier 4 (ingestion resume):** the documented probe-first procedure is in
  `docs/plans/funding-opportunities-makegov-v1/HANDOFF-2026-08-11-dibbs-sbir-ingestion-resume.md`
  — note it pins task-def `capiro-dev-api-sync-jobs:11`; the live active revision is now `:12`,
  update the command before running it. **Firm rule from the approved plan: zero ingestion runs on
  any day a human canary session is scheduled** — they share the same account-wide Tango quota.

## 9. Task tracker state at handoff

```
#1  [completed] Confirm CI push-on-docs-only behavior
#2  [pending]   Protect at-risk ECR digest              ← needs Neo go-ahead
#3  [completed] Reconcile flag/UI contradiction
#4  [completed] Root-cause zero-rows producer bug
#5  [completed] Diagnose 66 silently-failed SBIR writes
#6  [completed] Run cdk diff on Capiro-dev-Compute
#7  [completed] Prepare shared review worktree
#8  [completed] Run Band A independent reviews
#9  [completed] Run Band B clustered reviews
#10 [completed] Run Band C attestation review
#11 [completed] Aggregate Tier 2 findings
#12 [completed] Present EventBridge rule defs for go/no-go  ← drafted 2026-08-14, not created
#12b [pending]  Neo go/no-go on creating the 7 DISABLED fo-dev-* rules
#12c [pending]  Neo go/no-go on adding syncjobs-execution-role to invoker PassRole
#13 [pending]   Flag enablement once gates pass             ← blocked on decision #1, #5
#14 [pending]   Resume DIBBS/SBIR ingestion in bounded chunks
```

---

## 10. UPDATE — 2026-08-14, decisions answered, PassRole fixed, new ECR problem found

Neo answered all six open items from §4 in one message:

1. **DIBBS flag → "no flags for os.capiro.ai."** Resolved as the documented exception P1-1 asked
   for: `funding_opportunities_dibbs` will **not** be built. DIBBS/SBIR/forecast visibility on
   `os.capiro.ai` is governed by the master `funding_opportunities` flag only, by deliberate
   decision — not an oversight. **This should be written into `completion-matrix-updates.md` and
   ideally a real decision-log entry (D-8x) the next time anyone touches that file for real** —
   it isn't yet; today's session only recorded it here.
2. **EventBridge creation → "go."** Not yet done — see below, a new problem surfaced first.
3. **PassRole fix → "yes." DONE and verified live.** `capiro-dev-eventbridge-sync-invoker`'s
   `RunTaskAndPassRole` inline policy now includes
   `arn:aws:iam::967807252336:role/capiro-dev-syncjobs-execution-role` in its `iam:PassRole`
   resource list, alongside the original three Compute-stack ARNs. Applied via
   `aws iam put-role-policy` and re-read afterward to confirm. This was the one item with no
   further dependency, so it went first.
4. **Design-partner acceptance → "ignore."** Neo has explicitly deprioritized defining this.
   **P51 cannot close on this criterion — treat it as deferred, not resolved.** Don't let a
   future session read "ignore" as "handled."
5. **ECR digest protection → "yes" — but the approved fix (re-tag) turned out not to be
   possible.** Checking live state to execute the retag found that
   `sha256:4208d7e9ba2215336f63773fedb2ea071145aff8e3f6a8ee42c624ef5f6d5fbe` (what
   `capiro-dev-api-sync-jobs:12` is pinned to) **has already been pruned from ECR** — confirmed via
   `describe-images` by both tag and digest, both return `ImageNotFoundException`. This is past
   "at risk," it already happened. Currently-running tasks are unaffected, but **any new launch of
   `:12` — including firing any of the 7 draft EventBridge rules — would fail with a pull error.**
   You cannot re-tag an image that no longer exists, so the approved action needs to become a
   different one: **register a new `capiro-dev-api-sync-jobs` revision pointing at a still-present
   image.** `capiro/dev/api:d800dcfde51f6cf21a4b54b511006b9001fd6d2b`
   (`sha256:73ddbf9c3074eb36e0abdd84270726ba7d2804fb93735729c6963406af7c647e`) is confirmed still in
   ECR and is a descendant commit of the one `:12` was built from, so it's a safe superset. **This
   was not executed** — constructing the new task-definition JSON was blocked by the auto-mode
   safety classifier (it touches a container definition wired to ~28 secrets, including
   `TANGO_API_KEY` and DB credentials, by reference), and rather than push past that, the session
   stopped and asked Neo directly. **Still waiting on that specific answer** — it is a new question,
   not a restatement of the original "yes."
6. **SBIR flag on `capiro-internal` → "yes, intentional."** Confirmed and closed. No further
   action needed; noted here so nobody re-investigates it.

### Why EventBridge creation (#2, "go") did not happen yet

Creating the 7 `fo-dev-*` rules now, pointed at `:12` as drafted, would create rules referencing a
task-definition revision that's currently broken for new launches — technically "safe" since
they'd be created `DISABLED`, but obviously wrong to knowingly ship. **Fix item 5's follow-up
question first** (register `:13` against the working image, point the target JSON at `:13`
instead of `:12`), then create. The draft JSON files in `eventbridge-drafts/` will need their
`TaskDefinitionArn` updated from `:12` to `:13` before creation — do not create them unmodified.

### What to do next, in order

1. Get Neo's answer on registering `capiro-dev-api-sync-jobs:13` (same task-def as `:12`, only the
   `image` field changed to the `d800dcfde5`-tagged one above). This is the one item genuinely
   blocked on a person right now. **The `:13` payload is already constructed locally at
   `%TEMP%/td13-payload.json` (5470 bytes, 28 secrets by ARN reference, image swapped to
   `capiro/dev/api:d800dcfde51f6cf21a4b54b511006b9001fd6d2b`). All 7 `*.put-targets.json` files
   have already been updated to reference `:13` instead of `:12`. All 7 `fo-dev-*` rule names
   have been re-verified absent in AWS (2026-08-14). GO-NO-GO.md has been updated to reflect
   all of this. The only remaining step is Neo's "yes" to run
   `aws ecs register-task-definition --cli-input-json file://%TEMP%/td13-payload.json`.**
2. If yes: register `:13`, verify it live (`describe-task-definition`, confirm image pulls — e.g.
   a harmless `run-task` with an inert override, or just trust the next real fire), then create
   the 7 rules per the documented procedure in `GO-NO-GO.md`. Still create `DISABLED` — enabling
   is a separate, later decision, unchanged from the original draft's own recommendation.
3. Write the "no flags for os.capiro.ai" and "design-partner acceptance deferred" decisions into
   `completion-matrix-updates.md` for real once someone is doing a real commit pass over these
   docs — not urgent enough to block on alone.
4. Everything else in §4/§8 above is unchanged: P46/P08 fixes, the two scoring bugs, the canary
   runbook fixes, and Tier 4 ingestion are all still exactly where they were.

### Task tracker, current

```
#1  [completed] Confirm CI push-on-docs-only behavior
#2  [cancelled] Protect at-risk ECR digest              ← SUPERSEDED: image already pruned. Replaced by #16
#3  [completed] Reconcile flag/UI contradiction
#4  [completed] Root-cause zero-rows producer bug
#5  [completed] Diagnose 66 silently-failed SBIR writes
#6  [completed] Run cdk diff on Capiro-dev-Compute
#7  [completed] Prepare shared review worktree
#8  [completed] Run Band A independent reviews
#9  [completed] Run Band B clustered reviews
#10 [completed] Run Band C attestation review
#11 [completed] Aggregate Tier 2 findings
#12 [completed] Present EventBridge rule defs for go/no-go
#13 [pending]   Flag enablement once gates pass             ← blocked on §4 item #1 resolution (recorded, not yet applied to matrix) and confirming a tested flag-disable path
#14 [pending]   Resume DIBBS/SBIR ingestion in bounded chunks
#15 [completed] Add syncjobs execution role to invoker's PassRole list  ← DONE, verified live 2026-08-14
#16 [completed] Register capiro-dev-api-sync-jobs:13 against a working image  ← DONE 2026-08-14. Revision 13, ACTIVE, image d800dcfde5
#17 [completed] Create the 7 fo-dev-* EventBridge rules (DISABLED)  ← DONE 2026-08-14. All 7 created DISABLED, all targeting :13, verified
```
