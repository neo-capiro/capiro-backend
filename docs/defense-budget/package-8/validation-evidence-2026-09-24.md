# Package 8 validation evidence

Date: 2026-09-24
Repository: `neo-capiro/capirov2`

## Local qualification

| Check | Result | Evidence |
| --- | --- | --- |
| Physical reconciliation reducer | PASS | 8/8 cases: unknown denominator, exact active lineage, duplicate/superseded handling, optional units, staged counts, unavailable sources, malformed publication lineage, and superseded history. |
| Lifecycle API and XML inspector | PASS | 4 focused suites / 25 assertions. The API preserves bundle history and current-run lineage; the XML inspector rejects wrong/unused namespace-prefix bindings. |
| Historical notification qualification | PASS | Fresh PostgreSQL database after all 428 migrations. Historical baseline and removal drains each inserted zero alerts and incremented `suppressedHistorical`; complete scenario result `PASS`. |
| Internal web surface | PASS | 6/6 focused Vitest assertions. Null denominator, active snapshot, source document/SHA, exception codes, and historical FY options are visible. |
| CDK environment identity | PASS | 12/12 focused synth assertions; the serve task carries `APP_ENV=capiro-dev`, matching the active-snapshot environment key. |
| Prisma | PASS | Schema validation and client generation completed against a disposable local PostgreSQL URL. No Package 8 migration exists or is required. |
| TypeScript | PASS | Full API, full web, defense-domain, and CDK typechecks completed without errors after prerequisite workspace builds. |
| Production builds | PASS | Nest API and Vite web builds completed. Existing Vite chunk-size warnings remain non-blocking. |
| Independent safety audit | PASS after repair | Hermes found hidden bundle history, declaration-only XML namespace checks, publication-lineage ambiguity, and missing UI attribution. All four findings were repaired and regression-tested before merge. |
| Diff hygiene | PASS | Working tree clean and `git diff --check` clean after the final focused web test. |

## Safety conclusions

- A logical-slot count is never presented as a physical-document denominator.
- `null` denominator renders as `unknown`, not zero.
- A stale `PASS`, different candidate/run, different SHA, missing accepted review, or inactive snapshot cannot count as published.
- Superseded and unavailable sources remain visible but do not count toward current publication coverage.
- A first full federal evidence reconciliation fails before provider calls or writes unless `--historical` is explicit.
- Historical additions and removals remain queryable while their outbox rows are consumed without client notifications.
- The DTIC mirror candidate cannot be promoted or imported by the inspector.
- No feature flag, schedule, production manifest, canonical snapshot, or historical notification channel is activated by the code change.

## Production release gates

The code PR must merge to GitHub `main`, local `main` must fast-forward to the exact merge, and the API/web images must be built from that merge. Deployment must preserve the existing ingestion/publication flags. Post-deploy evidence must record ECS stability, exact image digests, runtime SHA, `APP_ENV`, the current coverage report, the exact manifest-eligibility decision, and notification counts before/after any permitted read-only qualification.
