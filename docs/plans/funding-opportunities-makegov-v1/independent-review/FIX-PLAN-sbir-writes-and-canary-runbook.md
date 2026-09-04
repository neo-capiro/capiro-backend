# Fix plan — SBIR solicitation write failures and the P49 canary runbook

**Status:** plan only. Nothing in this document has been applied. No source file, no
runbook, and no infrastructure has been touched while producing it.

**Pinned commit:** `origin/main` @ `3e2a691baa2a94802047ded1c3fe7a5dfd4e366c`, fetched and
read `2026-08-14`. Every quotation and line number below was read via
`git show 3e2a691baa2a94802047ded1c3fe7a5dfd4e366c:<path>` from `C:\dev\capirov2`; that
working tree was never touched (it has unrelated uncommitted changes from other work —
`git status` shows modifications under `apps/api/src/meri/**` and elsewhere — none of
which were read, and none of which are part of this plan). Read-only AWS calls
(`describe-task-definition`, `describe-services`, `gh run list`) were made against
`capiro-dev` to verify the two facts below that a static read cannot confirm; nothing was
mutated.

**Drift check against the prior independent review:** Band A's canary review
(`band-a-p49-canary.md`, findings F1–F4) was pinned to `d800dcfde5`, which is 7 commits
behind current `origin/main`. None of those 7 commits touch any file this plan cites:

```
git log --oneline d800dcfde5..origin/main -- \
  apps/api/scripts/sync-tango-sbir.ts \
  apps/api/src/external/tango/tango-sbir.mapper.ts \
  apps/api/prisma/migrations/20260909010000_tango_sbir_sttr/migration.sql \
  apps/api/scripts/sync-tango-entities.ts \
  apps/api/scripts/sync-tango-vehicles.ts \
  apps/api/scripts/reconcile-tango-webhook-alerts.ts \
  docs/runbooks/funding-opportunities-makegov-canary.md \
  docs/runbooks/funding-opportunities-rollout.md
# (empty output)
```

Everything below is current, not stale.

**Two live facts confirmed today, not assumed:**

- `capiro-dev-api-sync-jobs`'s active task-definition revision is still **`:13`**
  (single container `api-sync-jobs`, image tag
  `d800dcfde51f6cf21a4b54b511006b9001fd6d2b`) — unchanged since the prior review.
- **`capirov2` CI is still repo-wide broken.** `gh run list --branch main --limit 8` on
  `2026-08-14` shows eight consecutive `startup_failure` runs, 0s duration each, going
  back through today's merges — consistent with the known standing issue (CI blocked
  since 2026-07-31). This directly affects Fix A §3 below: the normal
  merge-to-main-builds-a-new-image pipeline (`.github/workflows/api-image.yml`) is not
  currently usable. **Re-check `gh run list --branch main --limit 3` before executing
  Fix A** — if CI has been repaired by then, the manual build step in §3 is unnecessary.

These two fixes are independent of each other and can be assigned, sequenced, or done in
parallel in either order.

---

# Fix A — 66 of 240 SBIR-solicitation writes silently failed

## A.0 Why `end_date < start_date` is the best-supported hypothesis, confirmed structurally

Before touching anything, it's worth stating why the three *other* CHECK constraints on
`tango_sbir_solicitation` are already structurally guarded — which is what leaves
`tango_sbir_solicitation_dates_chk` as the standout candidate rather than one hypothesis
among four equally-likely ones:

| Constraint | Guarded by | How |
|---|---|---|
| `tango_sbir_solicitation_id_chk` (`btrim(tango_sbir_id) <> ''`) | `mapSbirSolicitation` | `str()` (`tango.mappers.ts:68-76`) already collapses `''`/whitespace-only to `null`, and the mapper returns `null` (counted as `droppedNoId`, never upserted) when `tangoSbirId` is null. |
| `tango_sbir_solicitation_number_chk` (`btrim(solicitation_number) <> ''`) | same mapper, same `str()` | Identical reasoning — a blank `solicitation_number` returns `null` from the mapper (`droppedNoRequiredField`), never reaches the upsert. |
| `tango_sbir_solicitation_year_chk` (`year BETWEEN 1980 AND 2200`) | `solicitationYear()` (`tango-sbir.mapper.ts:81-85`) | Its own doc comment states the reason explicitly: out-of-range becomes `null` rather than failing the insert, "the same choice `reconcileQuantity` makes in the DIBBS mapper." |
| `tango_sbir_solicitation_dates_chk` (`end_date >= start_date` when both present) | **nothing** | `startDate`/`endDate` are each passed through `dateOnly()` independently (`tango-sbir.mapper.ts:113-114`) with zero cross-field check. |

That is the whole argument for why this constraint, and not one of its three siblings, is
the one worth instrumenting first.

## A.1 Step 1 — Confirm the catch block and constraint (done; here is what was found)

**The catch block.** `apps/api/scripts/sync-tango-sbir.ts`, inside `walkEndpoint()`,
current text (lines 432–444 as read at the pinned commit):

```ts
      summary.written += 1;
      if (options.commit) {
        try {
          if (endpoint === 'solicitation') {
            await deps.upsertSolicitation(row as TangoSbirSolicitationRow);
          } else {
            await deps.upsertTopic(row as TangoSbirTopicRow);
          }
        } catch {
          summary.errored += 1;
          summary.written -= 1;
        }
      }
```

Confirmed exactly as described: a bare `catch {}` with no binding, incrementing
`errored` and decrementing `written`, discarding the actual exception object entirely.
Nothing else in the file logs it, and nothing upstream of `main()`'s own top-level
`.catch()` (line ~622) sees an error thrown from inside a `commit`-mode upsert, because
this block never rethrows.

**The constraint.** `apps/api/prisma/migrations/20260909010000_tango_sbir_sttr/migration.sql:161-167`:

```sql
  -- A cycle that ends before it starts is a mapping error, not a real cycle.
  -- Both nullable, so this only fires when the provider stated both.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tango_sbir_solicitation_dates_chk'
  ) THEN
    ALTER TABLE "tango_sbir_solicitation"
      ADD CONSTRAINT "tango_sbir_solicitation_dates_chk"
      CHECK ("start_date" IS NULL OR "end_date" IS NULL OR "end_date" >= "start_date");
  END IF;
```

Confirmed present, unchanged, exactly as described. It sits on `tango_sbir_solicitation`
— the SOLICITATION table specifically, matching the fact pattern ("66 of 240
**solicitation** writes"), not `tango_sbir_topic` (which carries its own, separate
`tango_sbir_topic_dates_chk` on `open_date`/`close_date` — untouched by this fix; see the
note at the end of A.4).

**The mapper.** `apps/api/src/external/tango/tango-sbir.mapper.ts:96-123`, the relevant
lines:

```ts
    startDate: dateOnly(raw['start_date']),
    endDate: dateOnly(raw['end_date']),
```

Confirmed: each field is mapped through the shared `dateOnly()` helper (imported from
`tango-dibbs.mapper.ts`, `tango-sbir.mapper.ts:8`) completely independently. There is no
call anywhere in `mapSbirSolicitation` that compares the two results to each other before
returning the row. A record whose provider-stated `end_date` precedes its `start_date`
passes the mapper untouched and fails only when Prisma attempts the actual insert.

**Conclusion of Step 1:** every piece of the hypothesis is confirmed to still be present,
unchanged, at current `origin/main`. Nothing here is new — it matches the prior review
exactly — but it is now re-verified against today's tip rather than a 7-commit-old pin.

## A.2 Step 2 — Temporary diagnostic patch

**Goal:** make the next real run tell you the actual Postgres error — constraint name
included, if it's a check-violation — without changing what the sync *does*. Still
dry-run-safe, still counts the row as `errored`, still doesn't throw, still doesn't
retry. Only new behavior: one log line per failed upsert.

**File:** `apps/api/scripts/sync-tango-sbir.ts`

**Import change** — add `Prisma` to the existing `@prisma/client` import (the file
currently imports only `PrismaClient`):

```diff
- import { PrismaClient } from '@prisma/client';
+ import { Prisma, PrismaClient } from '@prisma/client';
```

`redact` is already imported (`tango.errors.js`, line 90) — reuse it, do not add a
second redaction helper.

**The catch block itself** — replace the block quoted in A.1 with:

```ts
      summary.written += 1;
      if (options.commit) {
        try {
          if (endpoint === 'solicitation') {
            await deps.upsertSolicitation(row as TangoSbirSolicitationRow);
          } else {
            await deps.upsertTopic(row as TangoSbirTopicRow);
          }
        } catch (error) {
          summary.errored += 1;
          summary.written -= 1;
          // TEMPORARY DIAGNOSTIC — see this file's decision-log entry once filed.
          // Remove or convert per Step 5 once the real cause is confirmed.
          const message = error instanceof Error ? error.message : String(error);
          const prismaDetail =
            error instanceof Prisma.PrismaClientKnownRequestError
              ? { code: error.code, meta: error.meta }
              : undefined;
          const idForLog =
            endpoint === 'solicitation'
              ? (row as TangoSbirSolicitationRow).tangoSbirId
              : (row as TangoSbirTopicRow).tangoSbirId;
          console.error(
            `TANGO_SBIR_SYNC_UPSERT_ERR ${JSON.stringify({
              endpoint,
              tangoSbirId: idForLog,
              // Logged because dates are the live suspect — seeing the exact
              // pair that failed proves or disproves the hypothesis without
              // needing DB access at all.
              ...(endpoint === 'solicitation'
                ? {
                    startDate: (row as TangoSbirSolicitationRow).startDate,
                    endDate: (row as TangoSbirSolicitationRow).endDate,
                  }
                : {}),
              message: redact(message),
              ...prismaDetail,
            })}`,
          );
        }
      }
```

Notes on this exact form:

- **Behavior is unchanged.** Still catches, still increments `errored`, still
  decrements `written`, still swallows rather than rethrows — the run completes exactly
  as it does today. The only addition is the `console.error` line.
- **`error instanceof Prisma.PrismaClientKnownRequestError`** is the established pattern
  in this codebase (`funding-opportunities.service.ts:449`, `memory-candidate.service.ts:676`,
  `sync-sam-opportunities.ts:828`, and seven other call sites) — matching it here keeps
  this file consistent with how the rest of the program inspects Prisma errors.
  A Postgres CHECK-constraint violation normally surfaces through Prisma as error code
  **`P2004`** ("A constraint failed on the database") with `meta.database_error` holding
  the raw Postgres message — which, for a `CHECK` violation, names the constraint
  (`...violates check constraint "tango_sbir_solicitation_dates_chk"`). This is stated
  as an expectation to verify against the real log output, not a certainty — log `.code`
  and `.meta` unconditionally so whatever Prisma actually reports is captured, rather
  than hard-coding a branch on `P2004` and potentially missing a different code.
- **Logging `startDate`/`endDate` directly** turns this into a hypothesis-confirming
  diagnostic on sight: if the hypothesis is right, the log line itself will show
  `endDate` earlier than `startDate` for (most of) the 66 failures, with no need to
  cross-reference `.meta.database_error` at all. Redaction is applied only to the error
  `message` (which could theoretically echo back request content); the dates and the
  provider's own id are not secrets.
- **No behavior change to `errored`/`written` semantics** — this deliberately does NOT
  add a new counter yet. That comes in Step 4, conditionally, once the cause is
  confirmed. Adding a new counter now, before knowing whether the hypothesis is even
  correct, would be premature.

Update the existing test file, `apps/api/scripts/sync-tango-sbir.spec.ts`, only enough to
keep it passing: if any existing test asserts on `console.error` call counts or
exact catch-block behavior around a thrown upsert, confirm it still passes with the
added log line (it should, since `errored`/`written` counting is unchanged). No new test
is needed for a temporary diagnostic.

## A.3 Step 3 — The resume command, and the deploy step it depends on

**This is the part most likely to be executed wrong: running the command below against
the *currently active* `capiro-dev-api-sync-jobs:13` will NOT exercise the diagnostic
patch, because revision `:13`'s image (`d800dcfde5...`) predates it.** The patch has to
ship as a new image and a new task-definition revision before the resume command means
anything. This is the same "pin a new task-def revision and keep the prior one for
rollback" discipline this program already uses elsewhere — `:13` stays as-is and as the
rollback target; a new revision (`:14`, assuming nothing else registers one first) is
what actually gets invoked.

**3a. Get the diagnostic-patched code into a runnable image.**

Re-check CI status first — this may no longer be necessary by execution time:

```bash
gh run list --branch main --limit 3
```

- **If CI is green again:** commit the Step 2 patch on a branch, open/merge a PR touching
  `apps/api/scripts/sync-tango-sbir.ts` (this path matches `api-image.yml`'s trigger
  filter, `apps/api/**`), and let `.github/workflows/api-image.yml` build and push
  `capiro/dev/api:<merge-sha>` automatically. Skip to 3b once that image exists in ECR.
- **If CI is still broken (the confirmed state as of 2026-08-14):** build and push
  manually, replicating `api-image.yml`'s exact parameters so the artifact is identical
  to what CI would have produced:

  ```bash
  aws ecr get-login-password --region us-east-1 --profile capiro-dev \
    | docker login --username AWS --password-stdin 967807252336.dkr.ecr.us-east-1.amazonaws.com

  # Run from the monorepo root — context is "." in api-image.yml, not apps/api.
  docker buildx build \
    --platform linux/arm64 \
    -f apps/api/Dockerfile \
    -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api:sbir-dates-diag-$(git rev-parse --short HEAD) \
    --push \
    .
  ```

  Use a distinguishable tag (not `latest`, not a bare SHA that could be confused with a
  real merge commit) precisely because this is a manual, off-pipeline build of code that
  is not yet merged — the tag itself should make that obvious to the next person who
  looks at the task definition.

**3b. Register a new `capiro-dev-api-sync-jobs` revision pointing at that image.**

```bash
aws ecs describe-task-definition --region us-east-1 --profile capiro-dev \
  --task-definition capiro-dev-api-sync-jobs:13 \
  --query taskDefinition > /tmp/sync-jobs-td.json
# Edit the single containerDefinitions[0].image field to the new tag from 3a.
# Strip the output-only fields register-task-definition rejects
# (taskDefinitionArn, revision, status, requiresAttributes, compatibilities,
# registeredAt, registeredBy) before calling register.
aws ecs register-task-definition --region us-east-1 --profile capiro-dev \
  --cli-input-json file:///tmp/sync-jobs-td.json
```

Note the new revision number this prints (referred to below as `<DIAG-REV>`). `:13`
remains registered and untouched as the rollback target.

**3c. Run the diagnostic pass.**

```bash
aws ecs run-task --profile capiro-dev --region us-east-1 \
  --cluster capiro-dev \
  --task-definition capiro-dev-api-sync-jobs:<DIAG-REV> \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-0e38bd390f8961fef,subnet-0920665f91c905f01,subnet-06db79cd21239de19],securityGroups=[sg-01def4e5c0fe44d4a],assignPublicIp=DISABLED}' \
  --overrides '{"containerOverrides":[{"name":"api-sync-jobs","command":["sync-tango-sbir","--endpoint=solicitation","--commit","--full"]}]}'
```

Why each piece of this command is what it is:

- **`--task-definition capiro-dev-api-sync-jobs:<DIAG-REV>`, not the bare family name.**
  A bare family name resolves to the highest **ACTIVE** revision, which is `:13` today —
  the old code. Pinning the explicit new revision is the only way to guarantee the
  patched catch block is what actually runs. (Per the `run-task`/`update-service`
  classifier note in the rollout runbook, this command needs Neo to run it via `!`.)
- **`--endpoint=solicitation`** — scopes the run to the failing endpoint only; there is no
  reported problem with `topic` writes, and there is no reason to spend rate-limit budget
  re-walking topics for this diagnostic.
- **`--commit`** — required. Without it, `walkEndpoint` never calls `deps.upsertSolicitation`
  at all (`options.commit` gates the entire `try`/`catch` block), so a dry run would
  produce zero diagnostic output no matter what.
- **`--full`** — required, and specifically because of how the incremental window is
  derived: with 173 rows already stored, a plain incremental run computes its window
  from `MAX(start_date)` across those 173 rows minus a 7-day overlap
  (`realHighWaterMark`, `sync-tango-sbir.ts:545-554`). Nothing guarantees the 66
  previously-failed records fall inside that window — they never got a chance to move
  the high-water mark forward in the first place, since they never wrote — so an
  incremental run could easily skip back over exactly the rows this diagnostic needs to
  see. `--full` drops the window entirely and walks the whole catalog, guaranteeing the
  previously-failed rows are re-fetched and re-attempted.
- **Container name `api-sync-jobs`** — confirmed today via
  `aws ecs describe-task-definition ... --query "taskDefinition.containerDefinitions[].name"`,
  which returns exactly one container: `api-sync-jobs`. (The rollout runbook uses `sync`
  in one example and `api` in another for this same task family — neither matches the
  live container name. Use `api-sync-jobs`, confirmed against the real task definition;
  this mismatch in the rollout runbook is outside this plan's scope but worth a note if
  someone else hits it.)
- **NETCFG** (subnets/security group) — copied from the rollout runbook and cross-checked
  today against the live `capiro-dev-api` service's own `networkConfiguration`; identical.

**Read the output.** Each failed row now logs a `TANGO_SBIR_SYNC_UPSERT_ERR` line with
the provider id, the two dates as mapped, the Prisma error code/meta, and the (redacted)
message. This is the evidence that either confirms or refutes the dates hypothesis —
proceed to A.4 only once you have it, and follow whatever it actually says over the
hypothesis if the two disagree.

## A.4 Step 4 — The permanent fix (conditional on A.3's confirmation)

**Only implement this if the diagnostic confirms `end_date < start_date` (or
equivalently, Prisma reports `P2004` naming `tango_sbir_solicitation_dates_chk`, or the
logged date pair itself shows the inversion) as the actual cause of some-or-all of the
66 failures.** If the log shows something else (a different constraint, a connection
error, a unique-key collision, anything not date-order-shaped), stop here and re-scope:
the fix below does not apply, and the real error message is now sitting in CloudWatch
waiting to be read and diagnosed on its own terms.

**Recommendation: implement the "store what we can" variant — keep the row, null the
offending `end_date`, count it distinctly.** Not silent rejection of the whole record.
This program already has two directly on-point precedents for exactly this choice, both
in files this fix sits next to:

1. `reconcileQuantity()`, `apps/api/src/external/tango/tango-dibbs.mapper.ts:132-140` —
   drops `quantity` rather than the whole DIBBS RFQ row when `unit_of_issue` is missing
   (a different CHECK, same shape of problem), with its own doc comment stating the
   principle directly: *"inventing a unit... would be inventing the FACT... while
   dropping the whole solicitation would lose a real, biddable item over a secondary
   field."*
2. `solicitationYear()`, `apps/api/src/external/tango/tango-sbir.mapper.ts:81-85` — in
   this SAME file, already nulls an out-of-range year rather than failing the whole
   insert, citing `reconcileQuantity` by name as the precedent it is following.

A `start_date`/`end_date` pair is the same shape of problem as those two: two
independently-plausible fields whose *combination* is what the database refuses.
Between the two dates, `endDate` is the one to drop, not `startDate` — a solicitation's
opening date is what a pursuer anchors a go/no-go decision on, and treating a close date
as "not yet known" is a smaller, more honest loss than discarding a real, biddable cycle
entirely over a secondary field. This also directly satisfies the "legitimate real-world
reason" framing (option (b) in the brief): a data-entry error upstream on the close date
alone shouldn't cost the whole record when the open date is fine.

**Implementation, following the DIBBS file's own established pattern exactly** (the
mapper computes the reconciled value and discards the flag; the sync script recomputes
the SAME function on the SAME inputs to get the flag for counting — see
`sync-tango-dibbs.ts:433-437`'s own comment for why that duplication is deliberate: *"The
mapper calls reconcileQuantity and discards the flag, so the count is recomputed here by
calling the SAME exported function on the SAME inputs — rather than re-deriving the
condition, which would be a second thing that can disagree with the mapper."*):

**1. `apps/api/src/external/tango/tango-sbir.mapper.ts`** — add, near `solicitationYear`:

```ts
/**
 * A cycle whose end date precedes its start date cannot satisfy
 * `tango_sbir_solicitation_dates_chk`. Both dates are already well-formed
 * (each passed through `dateOnly()`); only their relationship is wrong.
 *
 * Same choice `reconcileQuantity` makes in the DIBBS mapper: lose the
 * secondary fact, keep the row. `endDate` is dropped, not `startDate` — an
 * opening date is what a pursuit decision anchors on; an unresolvable close
 * date becomes "not yet known" rather than costing the whole record.
 */
export function reconcileSolicitationDates(
  startDate: Date | null,
  endDate: Date | null,
): { startDate: Date | null; endDate: Date | null; endDateDropped: boolean } {
  if (startDate != null && endDate != null && endDate.getTime() < startDate.getTime()) {
    return { startDate, endDate: null, endDateDropped: true };
  }
  return { startDate, endDate, endDateDropped: false };
}
```

Then in `mapSbirSolicitation`, replace the two independent `dateOnly()` calls:

```diff
-    startDate: dateOnly(raw['start_date']),
-    endDate: dateOnly(raw['end_date']),
+    ...reconcileSolicitationDates(dateOnly(raw['start_date']), dateOnly(raw['end_date'])),
```

(or bind to a local `const { startDate, endDate } = reconcileSolicitationDates(...)`
above the returned object if the spread reads awkwardly next to the rest of the object
literal — either is fine, the DIBBS file uses the destructure-then-assign form).

**2. `apps/api/scripts/sync-tango-sbir.ts`:**

- Add `reconcileSolicitationDates` to the existing `tango-sbir.mapper.js` import, and add
  `dateOnly` from `tango-dibbs.mapper.js` (not currently imported in this file — needed
  here only to recompute the same inputs the mapper already computed, exactly mirroring
  how `sync-tango-dibbs.ts` imports `decimalString`/`str` for the identical purpose).
- In `walkEndpoint()`, immediately after the existing null-check on `row` and the
  existing `topic`/`onTopicWithNoCycle` block, add the solicitation-side counterpart:

  ```ts
  // The mapper calls reconcileSolicitationDates and discards the flag, so the
  // count is recomputed here on the SAME inputs — see sync-tango-dibbs.ts's
  // identical pattern and its comment for why that beats re-deriving the
  // condition. Topics are excluded: tango_sbir_topic_dates_chk (open/close) is
  // a different constraint this fix does not touch.
  if (endpoint === 'solicitation') {
    const { endDateDropped } = reconcileSolicitationDates(
      dateOnly(raw['start_date']),
      dateOnly(raw['end_date']),
    );
    if (endDateDropped) onDateOrderInvalid();
  }
  ```

- Add a `onDateOrderInvalid: () => void` parameter to `walkEndpoint`'s signature
  (mirroring the existing `onTopicWithNoCycle` parameter immediately next to it), and
  thread a new counter through `runSbirSync` exactly as `topicsWithNoStatedCycle` already
  is:

  ```ts
  let solicitationsWithInvertedDates = 0;
  const onDateOrderInvalid = () => { solicitationsWithInvertedDates += 1; };
  // ...
  summaries.push(await walkEndpoint(endpoint, deps, options, windowFrom, onTopicWithNoCycle, onDateOrderInvalid));
  // ...
  return {
    endpoints: summaries,
    topicsWithNoStatedCycle,
    solicitationsWithInvertedDates,
    commit: options.commit,
    windowKind,
    completeness: ...,
    rateLimited: ...,
  };
  ```

- Add `solicitationsWithInvertedDates: number;` to the `SbirSyncSummary` interface, with
  a doc comment stating it is a **written** row with `endDate` nulled, not a dropped one
  — the same distinction `topicsWithNoStatedCycle`'s own comment draws ("Allowed and
  stored... MATERIALLY NONZERO IS A CONTRACT SIGNAL, NOT NOISE").

This keeps the fix entirely inside the pattern this file and its sibling already use
twice, and gives the operator a counter that is impossible to confuse with `errored`:
a nonzero `solicitationsWithInvertedDates` means "written, with a field dropped," never
"failed."

**3. Tests.** Add to `apps/api/src/external/tango/tango-sbir.mapper.spec.ts`, in the
`describe('mapSbirSolicitation', ...)` block, a case in the same style as the existing
`'stays inside the CHECK the column carries, so a bad year cannot fail a good row'` test
(line 244) for `solicitationYear` — e.g. `'stays inside the CHECK the column carries:
nulls end_date when it precedes start_date'` — asserting `row.endDate` is `null` and
`row.startDate` is preserved when `end_date < start_date` in the fixture. Add a companion
case confirming an ordinary valid pair (`end_date >= start_date`) is left untouched. Add
a matching `parseArgs`/summary-level test in `sync-tango-sbir.spec.ts` asserting
`solicitationsWithInvertedDates` increments exactly once per such record and `errored`
does not.

**Note on scope:** `tango_sbir_topic_dates_chk` (`open_date`/`close_date` on the sibling
topics table) is a structurally identical defect and is NOT covered by this fix — the
66-failure report is specifically about solicitation writes, and `mapSbirTopic` maps
`openDate`/`closeDate` with the same independent-`dateOnly()` pattern. Flagging this as a
separate, smaller follow-up rather than folding it in here, since there is no reported
failure on the topic endpoint to justify touching it under this ticket; whoever picks up
Step 4 may reasonably decide to fix both while in the file, but that is a scope
expansion the requester should sign off on explicitly rather than something bundled in
silently.

**4. Deploy and re-run.** Once the permanent fix replaces the diagnostic patch (see A.5),
repeat A.3's 3a–3c sequence once more (new image, new task-definition revision, same
exact `run-task` command from A.3) to actually recover the 66 rows for real. This is the
same command already specified in A.3 — it does not change between the diagnostic pass
and the real repair pass, only the image behind the task-definition revision changes.

## A.5 Step 5 — Retire or convert the diagnostic logging

**Recommendation: convert it to a permanent, low-noise structured log line, not a bare
removal.** Reasoning: this sync's own file header already treats "nothing has ever seen
a real response" / "expect at least one type here to be wrong" as a standing condition,
not a one-time bootstrapping concern — the SBIR/STTR integration is going to keep
surfacing contract surprises for a while yet, and a silent bare `catch {}` is exactly the
failure mode this whole exercise just spent a diagnostic run proving is costly to debug
after the fact. Once this specific hypothesis is resolved, keep a log line, but shrink it
to match what a healthy, low-noise operating log should look like:

```ts
        } catch (error) {
          summary.errored += 1;
          summary.written -= 1;
          const message = error instanceof Error ? error.message : String(error);
          const code =
            error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined;
          console.error(
            `TANGO_SBIR_SYNC_UPSERT_ERR ${JSON.stringify({
              endpoint,
              tangoSbirId:
                endpoint === 'solicitation'
                  ? (row as TangoSbirSolicitationRow).tangoSbirId
                  : (row as TangoSbirTopicRow).tangoSbirId,
              code,
              message: redact(message),
            })}`,
          );
        }
```

Differences from the temporary version in A.2: drop the full `meta` object (useful for
first-contact diagnosis, noisy for routine operation — `code` alone is enough to spot a
recurring constraint by name) and drop the raw `startDate`/`endDate` fields (their
purpose was confirming this one hypothesis; once `reconcileSolicitationDates` exists,
a genuine date-order problem can no longer reach this catch block at all, so logging
dates here permanently would be dead weight for the specific case this investigation was
about, while remaining generically useful for whatever *other* constraint eventually
trips it).

If a future reviewer prefers strict silence-by-default instead, the alternative is
deleting the `console.error` entirely and relying solely on `errored` — but that
reintroduces exactly the blind spot this whole fix exists to close (a future contract
surprise on this endpoint would again be invisible), so it is not the recommended
choice. State the choice made either way in the PR description, since it is a real
trade-off and not a default.

---

# Fix B — P49 canary runbook: four broken steps (documentation only)

File: `docs/runbooks/funding-opportunities-makegov-canary.md`. All four defects were
independently confirmed today against current `origin/main` (see the drift check at the
top of this document — nothing in this file changed since the prior review's pin). No
source file needs to change for defects 1, 3, and 4. Defect 2 is the one with a
recommended code change; see below.

## B.1 Defect 1 — §5's flag is read by no code anywhere

**Confirmed:** `git grep -n "funding_opportunities_tango_shadow" origin/main` (whole
repo) returns exactly two hits:

- `apps/api/prisma/migrations/20260821010000_tango_source_substrate/migration.sql:23` —
  a comment: *"`funding_opportunities_tango_shadow` — the flag that **will eventually**
  gate the sync jobs that DO call it — is not read by anything this migration touches,
  and stays off."*
- `docs/runbooks/funding-opportunities-makegov-canary.md:79` — the runbook row itself.

No guard class, no service, no constant. Zero application code reads it.

**Why it's dead rather than merely unwired:** the migration comment shows the ORIGINAL
P15-era intent was for this flag to gate P19's entity-shadow sync job. But P19 shipped a
different mechanism instead — a static `enabled: false` toggle in
`infra/cdk/lib/ingestion-schedule.ts` (confirmed today: `SyncTangoEntities` at line 578,
`enabled: false` at line 584; `SyncTangoVehicles` at line 609, `enabled: false` at line
615) gates whether the **automatic EventBridge schedule** runs the job at all. That is a
global on/off, not a per-tenant capability — consistent with every other ingestion job in
that file, and consistent with the "no per-capability flags for background sync jobs"
pattern this program has settled on. Per-tenant `intel_feature_flag` rows exist for
tenant-**visible surfaces** (the vehicle-fit field, the forecast card, etc.), never for
whether a sync job is allowed to run.

**But note this doesn't make `ingestion-schedule.ts`'s toggle a substitute gate for step
5, either** — it only controls the *scheduled, automatic* invocation. A manual
`ecs run-task` (which is what every step in this canary does) was never subject to it and
isn't subject to any check, in `sync-tango-entities.ts`'s own code, other than
`TANGO_API_KEY` being configured. So the honest statement is not "the real gate is X" —
it's "there is no per-tenant gate for this step at all, by design; containment here is
entirely the manual bounded invocation," which is exactly what Defect 2 (B.2) is about.

**Fix — before:**

```
| 5 | Entity shadow, one reviewed client | `funding_opportunities_tango_shadow` | `sync-tango-entities --client=<id>` |
```

**Fix — after:**

```
| 5 | Entity shadow, one reviewed client | *(none — see note)* | `sync-tango-entities --client=<id> --limit=<n>` |
```

And add a note directly under the §5–13 table (after the existing "After each: counts
should change..." paragraph), in the same explicit-about-absence style this program
already uses elsewhere (compare rollout §23's *"This is gated by a NEW flag... and it is
NOT a route guard"*):

```
**Step 5 has no tenant-level flag.** `funding_opportunities_tango_shadow` was never wired
to any code — confirmed by `git grep` returning only a migration comment and this line's
own prior text — and has been removed from this table rather than left as a false record
of containment. `sync-tango-entities.ts` checks only that `TANGO_API_KEY` is configured;
nothing in it consults `intel_feature_flag`. Containment for this step is entirely
`--client=<id>` and `--limit=<n>` (see the invocation form below, once implemented) — do
not skip either.
```

Do not simply delete the cell and leave it blank — that reads as an oversight rather than
a confirmed fact, and this program's own convention (see rollout §23, quoted above) is to
say explicitly when something is not gated rather than stay silent about it.

**Row 6 is unaffected — do not apply this same edit there.** `funding_opportunities_vehicle_fit`
(row 6) is a real, code-read flag (`acquisition-position.ts`, gating the
`acquisitionPosition` field on the opportunity response per rollout §"P23"). It does not
gate `sync-tango-vehicles.ts` itself — no sync script in this pair checks any flag — but
it is not a dead flag the way `_tango_shadow` is, so it stays in the table as-is.

## B.2 Defect 2 — `--client=<id>` does not exist on either script; recommend implementing it (small change)

**Confirmed, both scripts, current `origin/main`:**

- `sync-tango-entities.ts`'s `parseArgs` (lines 88–95) reads only `--commit` and
  `--limit`. `ParsedArgs` (lines 83–86) has exactly two fields: `commit`, `limit`. There
  is no `client` field anywhere in this file.
- `sync-tango-vehicles.ts`'s `parseArgs` (lines 87–94) is byte-for-byte the same shape:
  only `commit` and `limit`.
- Neither script's arg parser rejects an unrecognized flag — `--client=<id>` is silently
  dropped, and the run proceeds and prints a normal-looking summary. The operator gets no
  error and no indication that the flag did nothing.
- Both scripts are genuinely all-tenant by construction: `sync-tango-entities.ts`'s
  `realReadClientBatch` (lines 250–261) runs `tx.client.findMany({ where: { uei: { not:
  null } }, ... })` with no tenant or client predicate, inside an RLS-bypass transaction
  covering every tenant's `clients` rows. `sync-tango-vehicles.ts`'s `loadKnownUeisReal`
  (lines 271–284) does the identical `tx.client.findMany({ where: { uei: { not: null } }
  })`. This directly contradicts the runbook's own opening line, "**Scope:** the internal
  tenant only," and step 5's own label, "one reviewed client."

**Recommendation: implement real `--client=<id>` scoping in both scripts (option (a)).**
This is a small, low-risk change in both files — smaller than option (b)'s alternative of
rewriting the runbook to admit an unbounded cross-tenant claim and then bolting on
compensating language. The size estimate below is based on two working precedents
already in this program:

- `apps/api/scripts/repair-set-aside-certifications.ts` — `tenantId: string | null`
  parsed via `value(argv, 'tenant')` (line 73), threaded straight into a Prisma `where`:
  `...(options.tenantId ? { tenantId: options.tenantId } : {})` (line 175).
- `apps/api/scripts/review-tango-enrichment-candidate.ts` — `--tenant`/`--client` parsed
  (lines 46, 53) and passed to a service method as `{ clientId: args.clientId, ... }`.

Both are a `flagValue()` read plus a one-line conditional spread in a `where` clause —
exactly the shape needed here, and exactly the pattern already established by
`flagValue()` existing verbatim in both target files already (it's the same helper both
scripts already define locally for `--limit`).

**Why the change is small in each file specifically:** in both scripts, the *pure,
tested core* (`runEntitySync` / `runVehicleSync`) never needs to change at all — the
client filter only needs to reach the "real wiring" functions at the bottom of each file,
which are already constructed as closures inside `main()` and passed in as injected
dependencies. Concretely:

**`sync-tango-entities.ts`:**

1. Add `clientId?: string` to `ParsedArgs` (line 83–86) and `clientId: flagValue(argv, 'client'),`
   in `parseArgs` (inside the object at line 91–94).
2. Change `realReadClientBatch(prisma: PrismaClient)` (line 250) to
   `realReadClientBatch(prisma: PrismaClient, clientId?: string)`, and add
   `...(clientId ? { id: clientId } : {})` into the `where` object at line 254 (alongside
   the existing `uei: { not: null }`).
3. In `main()` (line 278), pass `args.clientId` through: `realReadClientBatch(prisma, args.clientId)`.

**`sync-tango-vehicles.ts`:**

1. Add `clientId?: string` to `ParsedArgs` (line 82–85) and the matching `parseArgs` line.
2. Change `loadKnownUeisReal(prisma: PrismaClient)` (line 271) to
   `loadKnownUeisReal(prisma: PrismaClient, clientId?: string)`, and add
   `...(clientId ? { id: clientId } : {})` into the `where` at line 274.
3. In `main()` (line 358), pass it through: `loadKnownUeis: () => loadKnownUeisReal(prisma, args.clientId)`.

Neither change touches `SyncDeps`/`VehicleSyncDeps`, `SyncOptions`/`VehicleSyncOptions`,
or the exported pure functions those interfaces feed — so the existing
`sync-tango-entities.spec.ts` / `sync-tango-vehicles.spec.ts` fake-based test suites for
the core walk logic need no changes. Only `parseArgs`'s own test cases need a new
assertion for `--client=`.

**Important caveat that survives the fix — say this in the runbook regardless:**
scoping `sync-tango-vehicles.ts` to one client narrows what gets **written**
(`client_relevant_vehicle` rows), not what gets **fetched**. The outer loop in
`runVehicleSync` walks the provider's global vehicle catalog (`gateway.listVehicles`,
~20,709 vehicles per the rollout runbook's own P22 section) regardless of `clientId` —
there is no vehicle-side UEI filter on the provider's list endpoint (the file's own
header says so). `--limit` is what actually bounds the provider-request cost of this
step, and the current canary command has none. Recommend the fixed §6 command read
`sync-tango-vehicles --client=<id> --limit=50` (matching the bound the rollout runbook
itself uses for this exact script at P22), not just `--client=<id>` alone. Apply the same
`--limit` addition to §5's `sync-tango-entities` command for the same reason, even though
entities *are* narrowed at the fetch layer by `--client`.

**Runbook text change** (once the code above ships) — the flag name in the table does not
need to change, since `--client=<id>` is already what's documented; only the omitted
`--limit` needs adding:

```
| 5 | Entity shadow, one reviewed client | *(none — see B.1's note)* | `sync-tango-entities --client=<id> --limit=50` |
| 6 | Vehicles for that client | `funding_opportunities_vehicle_fit` | `sync-tango-vehicles --client=<id> --limit=50` |
```

**If (a) is rejected for any reason** (e.g., nobody wants to touch these scripts right
now), the fallback is option (b): rewrite the runbook's "Scope: internal tenant only"
line to state plainly that these two syncs are global across all tenants, and require
`--limit` on both as the only real bound, with an explicit operator warning that
`--commit` on either is a full-catalog, cross-tenant write with no isolation. That is a
strictly worse outcome for a canary whose entire premise is contained blast radius, which
is why (a) is the recommendation here.

## B.3 Defect 3 — §16's "two quiet passes" is inert; replace with rollout §29's procedure

**Confirmed, current `origin/main`:** canary §16 (lines 142–159):

```
## 16. The two quiet passes

**This is the acceptance step most likely to fail, and the one worth the most.**

Run the lifecycle and event processors **twice, with no source change between**:

process-funding-opportunity-lifecycle
process-tango-events
# …no sync in between…
process-funding-opportunity-lifecycle
process-tango-events

The second pass must report **no new alerts**. If `alertsWritten` grows on
unchanged data, the change fingerprint is not stable and the dedupe index will
not save you — stop, and do not enable any schedule.
```

Neither invocation ever includes `--commit`. Both `process-funding-opportunity-lifecycle`
and `process-tango-events` are dry-run by default and perform no write, no lease, and no
status change without it — meaning pass 2 recomputes from byte-identical state to pass 1
and will always report the *same* number as pass 1 (never "no new," since nothing was
ever "new" to begin with in a dry run). The stated pass criterion — "no new alerts" as
if that means zero — is not a state the code can distinguish from "quiet because nothing
was ever tested," because §16 also never states the prerequisite: `process-tango-events`
reads from `tango_opportunity_notice`, populated only by
`sync-tango-opportunity-notices --commit`, which §16 never runs. Skip that prerequisite
and both passes trivially report the same (possibly zero) number regardless of whether
anything actually works — the checklist box gets ticked, and nothing was tested.

**The correct procedure exists already**, `docs/runbooks/funding-opportunities-rollout.md`
§29 ("Drain webhook events into alerts (P48)"):

```
Run the notice sync FIRST — the drain reads what that sync holds and does not
fetch inline:

    sync-tango-opportunity-notices --commit

Then dry-run the drain. It writes nothing: no insert, no lease, no status change.

    process-tango-events

Read the JSON summary. `alertsWritten` is what a `--commit` run WOULD write;
`suppressions` explains every alert that did not fire, by reason: ...
[8-row suppression-reason table — baselined_first_observation, no_change,
below_materiality, human_declined, terminal_stage, stage_not_engaged,
volume_capped, and the D-58 caveat that a nonzero volume_capped on a first
drain over existing history is expected, not a failure]

The quiet test: run the dry run twice with no sync in between. The second
run must report the same `alertsWritten` and write nothing new. If the number
grows, the fingerprint is not stable and the dedupe index will not save you —
stop and investigate before committing.

Then commit:

    process-tango-events --commit --limit=200

Re-run the dry run afterwards. `alertsWritten` must be 0 and `alertsDeduped`
should equal what the commit wrote.
```

The load-bearing difference: rollout §29 tests for **equality** between two dry-run
passes over data that a real, committed sync populated — not for a bare "no new," and
not without first guaranteeing there is something in the table to be quiet or noisy
about.

**Fix — replace canary §16 in full** with a reference plus the concrete numbers:

```
## 16. The two quiet passes

**This is the acceptance step most likely to fail, and the one worth the most.**

Follow the identical procedure documented in
`docs/runbooks/funding-opportunities-rollout.md` §29 ("Drain webhook events into
alerts"), against `process-tango-events`:

1. Run the notice sync first — the drain reads what that sync holds and does not
   fetch inline: `sync-tango-opportunity-notices --commit`
2. Dry-run the drain: `process-tango-events`. Record `alertsWritten` and read
   `suppressions` (rollout §29 has the full reason table, including why a nonzero
   `volume_capped` on a first drain is expected, not a failure — D-58).
3. Dry-run it again, no sync in between: `process-tango-events`. **The second run
   must report the exact same `alertsWritten` as the first, and write nothing
   new.** Equal, not merely "no new alerts" — if pass 1 was nonzero, pass 2 must
   match that number precisely. If it grows, the fingerprint is not stable and
   the dedupe index will not save you — stop, and do not enable any schedule.
4. Commit: `process-tango-events --commit --limit=200`.
5. Dry-run once more. `alertsWritten` must now be `0`, and `alertsDeduped` must
   equal what step 4 committed.
```

**One thing worth flagging to whoever applies this fix, beyond the literal replacement
above:** canary §16 also invokes `process-funding-opportunity-lifecycle`, which rollout
§29 does not cover at all — that processor has its **own**, separately-documented quiet-
pass check at rollout §16 ("Lifecycle pass"), which uses a different mechanism entirely
(two real `--commit` runs **on separate days**, not two dry runs, because
`process-funding-opportunity-lifecycle` only persists a baseline fingerprint inside
`if (options.commit)`). The replacement above, strictly following this ticket's
instruction to adopt rollout §29 verbatim, covers `process-tango-events` correctly but
silently drops lifecycle-pass coverage that the current (broken) §16 was at least
gesturing at. Recommend appending a short second block to the replacement above, sourced
from rollout §16, so canary coverage isn't quietly narrowed while fixing it:

```
**Separately, the lifecycle processor has its own quiet-pass check** (rollout §16):
run `process-funding-opportunity-lifecycle --commit`, expect a large `baselined=`
count and `alerts=0` on the first run (this is the intended silent-baseline
behavior, not a failure). Run it again `--commit` **on a separate day** — this
second run is the one that must be quiet. `process-funding-opportunity-lifecycle`
does not emit `alertsWritten` at all (it prints `alerts=<n> would create`
instead) — do not watch for a field name this command never produces.
```

This is flagged as a recommended addition rather than folded silently into the primary
fix, since the ticket's instruction was specifically to replace §16 with rollout §29's
procedure — the lifecycle-check gap is real but is this plan's own finding, not one of
the four confirmed defects, so it's presented as a call for whoever applies the fix to
make, not a mandate.

## B.4 Defect 4 — §14's exit-code claim is backwards; replace with rollout §28's table

**Confirmed, current `origin/main`:** canary §14 step 3 (lines 102–110):

```
3. Dry-run the reconciler. It writes nothing:

   ```bash
   reconcile-tango-webhook-alerts
   ```

   **Exit 3 means the tier refuses webhook writes** — that finally resolves
   P17's open question, and nothing was left half-configured. Take it to
   MakeGov; do not retry.
```

Reading `apps/api/scripts/reconcile-tango-webhook-alerts.ts` directly (its own header,
lines 46–53, states all six codes: `0,1,2,3,4,5`):

- A **dry run** (no `--commit`, which is exactly what step 3 invokes) can only reach
  `EXIT_TIER_DENIED` (3) from one place: `listWebhookEndpoints()` / `listWebhookAlerts()`
  throwing a tier denial (lines 190–207). That branch's own message is explicit: *"Provider
  refused the webhook **READ** APIs on this account tier... this is a change in
  entitlement, not an expected state."* — the opposite of what §14 tells the operator.
- The **write**-tier denial that would actually resolve P17's `webhook_write_apis`
  question lives inside the commit loop (lines 259–283) and is reachable only via
  `--commit --endpoint-id=<uuid> --confirm-callback=<url>` — which passes
  `args.confirmCallback !== endpoint.callbackUrl` validation first (line 247, itself
  returning `EXIT_BAD_ARGS` on a mismatch). §14 never gives this invocation at all.
- A plain dry run's two other realistic outcomes are `EXIT_DRIFT` (5) — the *expected*
  result on a fresh canary, since desired state won't match yet — or `EXIT_OK` (0). §14
  never mentions either.
- `resolveEndpoint()` (lines 137–161) returns `EXIT_ENDPOINT_UNRESOLVED` (4) when the
  account has more than one webhook endpoint and no `--endpoint-id` was given — a real,
  reachable outcome on a first dry run that §14 also never mentions.

`docs/runbooks/funding-opportunities-rollout.md` §28 already carries the correct table:

```
| Exit | Meaning |
|---:|---|
| 0 | desired state already matches, or the commit completed |
| 2 | bad arguments; nothing attempted |
| 3 | **tier or permission denied** — nothing left half-configured |
| 4 | endpoint ambiguous or missing; nothing attempted |
| 5 | drift exists, and this was a dry run |
```

(This table itself omits exit `1`, "unexpected failure," which the script's own header
comment does list. That is a rollout-runbook gap, not a canary one, and is out of scope
for this fix — Fix B only touches the canary file. Worth a one-line footnote if whoever
applies this fix wants to add the sixth row while already editing this table, but it is
not required to close the four confirmed canary defects.)

**Fix — replace canary §14 step 3 in full:**

```
3. Dry-run the reconciler. It writes nothing:

   ```bash
   reconcile-tango-webhook-alerts
   ```

   Read the exit code — rollout runbook §28 has the full contract:

   | Exit | Meaning |
   |---:|---|
   | 0 | desired state already matches, or the commit completed |
   | 2 | bad arguments; nothing attempted |
   | 3 | **tier or permission denied** — nothing left half-configured |
   | 4 | endpoint ambiguous or missing; nothing attempted |
   | 5 | drift exists, and this was a dry run |

   **On a fresh canary, exit 5 is the expected result**, not a failure — desired
   state has never been applied yet.

   **Exit 3 here means the provider refused the webhook READ APIs** (list
   endpoints / list alerts) on this account's tier — not the write APIs. That is
   still real signal (P17 recorded `webhook_event_types` and
   `webhook_endpoints_list` as supported, so a read-tier denial now is a change
   in entitlement), but it does **not** answer whether webhook **writes** are
   permitted.

   **Resolving `webhook_write_apis` — P17's actual open question — requires the
   commit path**, which this step does not run:

   ```bash
   reconcile-tango-webhook-alerts --commit \
     --endpoint-id=<uuid-from-the-dry-run> \
     --confirm-callback=<the endpoint's actual callback_url, per the dry run above>
   ```

   Exit 3 from **this** invocation is the one that settles P17's discrepancy —
   see rollout §28's own note: *"this account's tier does not permit webhook
   writes... do not retry it; take it to MakeGov."* Re-run the dry run afterward;
   it must report no work (exit 0).
```

This also fixes the secondary problem the confirmation above surfaced: §4 currently tells
the operator "step 14 is where [`webhook_write_apis`] finally gets answered," which was
never true for step 14 as originally written (a bare dry run cannot reach the write-tier
branch at all). The rewritten step 14 above now actually can answer it, via the added
commit invocation — so §4's claim becomes true rather than needing its own separate
correction. If whoever applies this fix wants to leave the commit step out of scope for
some reason (e.g., deferring real webhook writes to a separate, more deliberate change),
the minimum alternative is correcting §4 to say plainly that step 14 as currently scoped
only ever resolves the READ half of the question, and the WRITE half remains open pending
a deliberate, separately-approved commit run — but implementing the fix above (adding the
commit form) is preferable, since it's what §4 already promises and the runbook's own
step 27/28 ceremony (endpoint id + confirmed callback) already exists specifically to
make that commit safe to run.

---

# Sequencing notes

- Fix A and Fix B touch entirely disjoint files and have no dependency on each other;
  either can be done first, in parallel, by different people.
- Within Fix A, steps are strictly sequential: 1 (confirm, done) → 2 (patch) → 3 (deploy
  + run + read) → 4 (conditional permanent fix, gated on 3's actual output) → 5 (retire
  diagnostic). Do not skip from 2 to 4 without actually reading 3's output — the whole
  point of this plan is that the cause is a hypothesis, not a confirmed fact yet.
- Within Fix B, all four defects are independent doc edits to the same file and can be
  applied in one pass; B.2 is the only one that also requires a (small) source change
  ahead of the doc edit, so it may land on its own schedule if the doc-only fixes ship
  first.
- Re-run the drift check at the top of this document (the `git log ... d800dcfde5..origin/main`
  form, updated to whatever the new base is) immediately before implementing anything, in
  case `origin/main` has moved again since this plan was written.
