# Knowledge CI prerequisite repairs

Fresh hosted runs on `c3b1d6af726def1c4ebf0a5de265c901445fc396` failed before or during the existing Knowledge checks:

- Phase 11 used `git diff --check HEAD^` after a shallow one-commit checkout. Checkout now fetches two commits.
- Phase 12 and 14 Prisma schema validation lacked `DATABASE_URL`. Only their validate/generate step receives a dummy loopback URL; those commands do not connect to a database.
- Phase 15 exhausted its observed 2 GB Node heap. Its verification job now uses 6 GB without changing test selection or gates.

The local Phase 15 run then exposed one stale mock assertion: the adapter passes an explicit undefined third transaction-options argument on ordinary reads. The assertion now matches that signature and retains the tenant and ethical-wall checks. The rest of the test-file diff is formatter output.

## PASS

Prisma schema validation and the exact Phase 15 selection (41 tests across four suites) exited 0. Hermes/Kimi independent static review passed the scoped changes. Evidence: `C:/dev/cap-meri-foundation-evidence/ci-c3-prisma-schema.log`, `ci-c3-phase15-local.log`, the preserved hosted/setup failure logs, and `review-ci-knowledge-repairs-report.md`.

## NOT RUN / unresolved

Fresh hosted runs must verify the published commit. Broader CI still reports shared-package formatting debt and an Outreach Phase 1 scope check against a historical fixed base; neither is waived. No live resources, main branch, routing, model policy, or deployment changed.
