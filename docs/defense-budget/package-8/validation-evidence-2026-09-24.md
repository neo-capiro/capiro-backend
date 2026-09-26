# Package 8 validation evidence

Date: 2026-09-24
Repository: `neo-capiro/capirov2`

## Local qualification

| Check | Result | Evidence |
| --- | --- | --- |
| Physical reconciliation reducer | PASS | 8/8 cases: unknown denominator, exact active lineage, duplicate/superseded handling, optional units, staged counts, unavailable sources, malformed publication lineage, and superseded history. |
| Lifecycle API and XML inspector | PASS | 4 focused suites / 25 assertions. The API preserves bundle history and current-run lineage; the XML inspector rejects wrong/unused namespace-prefix bindings. |
| Official DTIC XML/PDF qualification reconciliation | PASS (qualification-only) | Pinned official XML/PDF hashes; 2 PE records + 3 project records; 5/5 identity/title/FY2026-amount page-text matches. Report: `qualification/dtic-official-xml-pdf-reconciliation-v1.json`. |
| DTIC XML locator inventory | PASS (qualification-only) | Real pinned XML produced 2 distinct prefix-independent expanded-QName PE locators, bound to XML SHA-256 `02479cd6e67dfee10bb1029d9413dbc35e81174384b25319fedfb9589d4aac6a`. Report: `qualification/dtic-fy2026-xml-locator-inventory-2026-09-25.json`. |
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
- The DTIC XML/PDF reconciliation is a page-text qualification check only; it does not establish field-complete semantics, completeness, review, persistence, or publication.
- The XML locator inventory is a stable provenance primitive only; it does not establish funding semantics, completeness, review, persistence, or publication.
- No feature flag, schedule, production manifest, canonical snapshot, or historical notification channel is activated by the code change.

## Production release proof

- Code PR `#1792` merged as `56ccee8b05e75b0db17bea3bc1cd3e64546d5c2a`; local `main` fast-forwarded to that exact merge before the release builds.
- GitHub-hosted checks failed in two to four seconds with no assigned runner and zero steps. The admin merge followed the complete local gate matrix and independent repair audit.
- Native ARM64 API and web CodeBuild jobs resolved the exact merge and succeeded. The API and both web repositories carry immutable SHA tags plus Package 8 release tags.
- API task definition `capiro-dev-api:452`, web `:138`, and web-vNext `:356` reached completed steady deployments. Replacement targets were healthy.
- `APP_ENV=capiro-dev` and `GIT_SHA=56ccee8b…` are present on the API task. The four ingestion/publication flags remain false.
- Both public runtime-config endpoints report the Package 8 merge SHA. An unauthenticated reconciliation request returns `401 Missing bearer token`, preserving the internal-only boundary.
- Post-deploy SELECT-only tasks exited zero on the exact API image. They report 82 logical slots in each FY2024–FY2027, 14 observations, 11 candidates, 43 active approvals, zero active/canonical snapshots, zero governed manifests, and zero manifest-eligible rows. No historical write or notification-producing run occurred.

## Follow-on candidate deployment (2026-09-25)

- After the locator-inventory merge, exact local/GitHub `main` revision
  `b7f6856732bf4ff360deb427aabc5d00d82dc99a` was built by native ARM64
  CodeBuild `capiro-build-intel-api:bf8d0456-7b4a-459b-b871-fc2fae9a3faf`.
- The immutable API image is pinned at
  `sha256:0904b41a5981e31966ab3600ee87e0364520831ccd2f7cd69502109fb4f6c9d7`.
  The idempotent migration task `capiro-dev-api-admin-migrate:78` exited 0
  with no pending migrations.
- ECS task definition `capiro-dev-api:474` reached `COMPLETED` with 2/2
  healthy tasks; the public app health request returned HTTP 200 and there
  were zero error-like API log matches in the five-minute post-rollout check.
  `GIT_SHA` and `RELEASE_SHA` equal the merged revision, and all four
  ingestion/publication flags remain `false`.
- This is shipment evidence only. The XML locator inventory remains
  `candidate_only`/`promotable: false`; no source registration, semantic
  funding import, historical replay, canonical publication, or notification
  occurred.
