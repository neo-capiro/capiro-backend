# Defense-budget completion plan — Package 1 annual operations

Package 1 extends the existing `budget-lifecycle` implementation. It does not introduce a second annual importer and it does not treat Package 0's 82 logical source requirements as 82 physical PDFs.

## Delivered scope

- One versioned coverage inventory keeps logical requirements separate from physical documents, volumes, sections and exhibits. Missing knowledge remains `unknown`; missing data is never converted to zero.
- The first authoritative discovery for an unseen fiscal year bootstraps that exact year through the frozen templates, then resolves the exact expected-source identity before writing.
- Two prior fiscal years can be replayed concurrently, unchanged bytes remain a no-op, and superseded observations remain immutable history.
- Every registered source adapter declares an operational owner and runtime owner.
- One bounded hourly lifecycle coordinator is defined as a short-lived ARM64 Fargate task. It is digest pinned, uses the defense-job database identity, limits each scheduled discovery to 25 requests, uses a 4,500-second lease, has no EventBridge retry, and alarms both task failures and delivery failures.
- Package E manifests are constrained to one to five immutable, reviewed members. A database trigger rejects out-of-manifest rows, over-cap rows and member-identity drift while a manifest is running.
- A SELECT-only Package 1 queue inventory reports exact immutable identities and live approval/correction/reservation gates without exposing parser errors or source bytes.

## Completed release gates

Package 1 merged through PR #1767 at `a31e0dc0a4bc5b673725ed346554d631340b68f6`. The coordinator was deployed dark, qualified manually, and then made the exclusive schedule owner. All release gates are captured in [the release evidence](./release-evidence-2026-09-24.json):

1. the additive database migration completes before either updated API runtime is deployed;
2. the exact merged GitHub `main` SHA is used for both digest-pinned images;
3. the read-only queue inventory establishes current eligibility without changing the queue;
4. one manual dry tick and one manual committed tick exit zero;
5. the legacy `capiro-dev-watch-budget-docs` rule is disabled before the new rule is enabled;
6. the new rule has exactly one target bound to the qualified task definition and image digest.

GitHub and local `main` were both fast-forwarded to the merge commit before the images were built. The legacy watcher is disabled, the Package 1 hourly rule is enabled, both alarms are `OK`, and the delivery DLQ is empty. See [the operator runbook](./OPERATOR-RUNBOOK.md), [validation evidence](./validation-evidence-2026-09-24.md), and [the live queue decision](./queue-recovery-summary-2026-09-24.json).

## Coverage interpretation

Package 1 can report discovered physical units and their current/superseded classifications without inflating them into logical requirements. The current schema does not establish authoritative aggregate `parsed`, `reviewed` or `published` physical-unit counts for every family, so those values remain unknown until their family-specific evidence is joined. Package 1 does not fabricate a coverage percentage.

## Cost and quality limits

- Annual AWS ceiling: USD 1,000.
- Provider ceiling: USD 500; Package 1 adds no paid-provider dependency.
- Total annual ceiling: USD 1,500.
- One hourly short-lived task, maximum 25 discovery requests per scheduled adapter run and a hard runtime request-budget ceiling of 250.
- Manifest limit: one active worker, one to five documents, three attempts per document, 24 hours per operation, six hours per document and USD 25 per manifest.
- Queue recovery is exact-manifest only. A row with a candidate, active approval, correction, active reservation, superseded source, incomplete archive pin or non-qualified dead-letter disposition is excluded.

## Remaining gaps and next bounded manifest

- Non-RDT&E durable extraction and publication remain Package 3 work; Package 1 does not claim those families are published.
- Alternative-funding and execution certification remain Package 6 work.
- Canonical publication remains empty at the Package 0 baseline and is not implied by lifecycle discovery.
- The next governed manifest, if any, is selected only from the live Package 1 inventory after exact source-format qualification. It is limited to one row for the first canary. An empty eligible set is a valid and safer result.
- The 2026-09-24 read-only inventory found no manifest-eligible row. One verification-rejected dead letter met the disposition-only replay predicate but was not qualified on the exact parked drain digest, so Package 1 performed no replay, drain or manifest write.
