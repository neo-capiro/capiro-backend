# District Nexus R4 closeout — September 18, 2026

Status: map repair ready for review; R4 production closeout remains incomplete.
This packet does not authorize merge, deployment, ingestion, schedule changes,
feature-flag changes, or tenant activation.

## Code and baseline

- Base: `ac5acadb78e23782823d02f667f63ccc1e3cfa28` on `main`.
- Supersedes the map repair proposed in #1610, which was still open and
  conflicting when inspected. Its branch and PR are preserved.
- National placeholder rows (`clientCount: 0`, `score: null`) now use the
  no-footprint fill for every metric and do not expand the footprint camera fit.
- Fill, feature metadata, hover text, and camera fit use the existing footprint
  semantics: positive client count or a known score. Known zero scores and
  unscored real-client rows remain distinct from placeholders.
- Preserves #1649's district feature identity and saved-location coordinates.
- No API, schema, migration, ingestion, or runtime configuration changes.

## Local verification

| Check | Result |
| --- | --- |
| New regressions against unchanged main map implementation | 8 failures / 13 passes: six metric-color cases and two camera cases reproduce the defects |
| District Nexus tests, including shared map and legacy consumers | PASS: 14 files / 140 tests |
| Map implementation and test TypeScript check, including imported dependencies | PASS |
| TypeScript check across every web source fetched into the District Nexus snapshot | PASS |
| Scoped Vite production map library bundle | PASS: 15 modules transformed |
| Full web typecheck, application production build, and Docker build | NOT RUN in this session |
| Hosted CI on candidate `271ef6a5f73bdd95fe5e577dc415a740a7f39e13` | BLOCKED: all ten returned workflows failed before executing a reported step |

Test command, from `apps/web`:

```sh
node ../../node_modules/vitest/vitest.mjs run src/vnext/pages/district-nexus src/vnext/components/district-map src/pages/intelligence/district-nexus --poolOptions.threads.singleThread
```

The local environment was a scoped source snapshot fetched through GitHub,
using available local dependencies, not a clean lockfile installation. The
first TypeScript check included the two changed files and `src/vite-env.d.ts`.
A subsequent `tsc -p tsconfig.json --noEmit` passed across every web source fetched
into the snapshot and its resolved imports; files not present in the snapshot
were outside that check. The map bundle externalized React, Clerk, React Query,
MapLibre's React wrapper, and Axios. These scoped checks do not prove the full
web/Docker build. Complete those repository gates from a clean checkout before
release, including the shared market-title package resolved by #1599. No
web-to-API relative import was added.

The snapshot began at `72ef12f24fd2222e83d9351635f700154a2374d1`.
The ten commits to the base above changed no District Nexus test-scope files or
loaded web dependencies. The published change must contain only the map,
its test, and this packet, with the real main commit as parent.

All ten GitHub Actions workflows returned for the proposed head failed within
three seconds. `ci-pr` run `35312962690` reported jobs `verify` and
`engagement-phase-2`; `web-vnext-foundation` run `35312962672` reported job
`foundation`. All three jobs returned zero steps, and log retrieval for
`verify` and `foundation` returned `BlobNotFound`. Recent unrelated PR runs show
the same three-to-five-second failure pattern. This establishes a repository
Actions startup problem during the observation window, but does not establish
its cause or count hosted checks as passing. Re-run and inspect required checks
once Actions can start jobs.

## Live acceptance matrix

`https://os.capiro.ai/intelligence/district-nexus` reached sign-in. Authentication
was cancelled; no authenticated page or API result was obtained. Running source
versions, tenant scope, runtime configuration, and live data were not recaptured.
Earlier service-method canaries and local tests are not browser acceptance.

| Live scenario | Status | Remaining evidence |
| --- | --- | --- |
| Firm nexus / All U.S. districts; metrics; placeholder drawer | BLOCKED | Authenticated colors, null semantics, selection, and public-context drawer |
| Client/state filters, URL/reload/back, sorting/reset; narrow view and keyboard | BLOCKED | Navigation and usability on the release candidate |
| L3Harris / FL-08 contract reconciliation | BLOCKED | Same identity scope, date/source filters, and totals in District Nexus and Federal Market |
| Anduril / CA-47; FL-08 forecasts where selectable | BLOCKED | Eligibility, unknown-date labels, readable titles, and source evidence |
| Supplier matches present; partial/empty/unavailable states | BLOCKED | Existing real match plus correctly distinguished coverage states |
| CPF/CDS | BLOCKED | Requested versus enacted amounts; House versus statewide Senate attribution; FL-08 omission investigation |
| GSA/economic/sector context | BLOCKED | Current totals, units, source year, boundary vintage, links, and missing-data display |
| Change feed | BLOCKED | Current source provenance, timing, and baseline-import treatment |
| Federal Spending navigation and Ask Meri | BLOCKED | Correct district/client context without cross-client leakage |
| Flag-off and tenant isolation | BLOCKED | Existing authorized control context; do not toggle flags to create one |
| Client-location regression | BLOCKED | Actual saved coordinates, district selection, and representation on Client Record |

Use `docs/plans/district-nexus-r4-tango-coverage-canary.md` for the existing
read-only canary. Reconfirm that its historical client selections still exist.

## Source and refresh matrix

No live database, source-run, checkpoint, scheduler, or provider-quota audit was
available in this session. All historical observations below need revalidation.
For each source capture dataset year, geographic/boundary scope, last attempt,
last committed success, counts/rejections, completeness/failure, schedule state,
target image, and freshness shown to users. Mark unavailable fields explicitly.

| Source | Historical evidence or code finding | Next read-only check |
| --- | --- | --- |
| Tango subawards | Earlier evidence: 50 stored rows of 2,743,636; next page 3, page size 25, partial corpus. Code overwrites `rows_processed` with this invocation's processed count, so a value of 25 can coexist with 50 stored rows. | Current distinct count, checkpoint and provenance, run history, provider quota, active runs, stable resume, unfiltered completeness, and schedule/image |
| ACS | Earlier refresh schedule disabled; current freshness unverified | Dataset vintage, geographic coverage, committed metrics/run, and schedule/target |
| CBP | Earlier refresh schedule disabled; current freshness unverified | Source year, measurement/units, geographic scope, committed metrics/run, and schedule/target |
| LODES | Earlier refresh schedule disabled; current freshness unverified | Source year, geography, committed metrics/run, and schedule/target |
| GSA FRPP | Earlier FL-08 and CA-47 results existed; source boundary could be unknown | Latest source-year aggregate and contributing boundary metadata, ingest status, and refresh mechanism |
| CPF/CDS | Earlier FL-08 district requests were zero, unexplained. `loadCpfCds` takes 400 statewide requests before district filtering; this is a possible omission mechanism, not a proven cause. | Count/filter raw current records using actual schema columns (`state`, `requester_district`); compare the district result with records outside the statewide limit; verify dedupe and House/Senate attribution |
| Forecasts / SAM | No current source-run/freshness observation | Latest committed runs, eligibility/date semantics, titles, source coverage, quota/failure state, and refresh mechanism |

If the CPF/CDS omission is confirmed, implement a separately verified query
repair with a disposable-database regression that includes more than 400
statewide rows. Do not reinterpret requested amounts as awarded amounts or
statewide requests as district-specific to force a match.

Do not reset Tango's checkpoint or repeat historical `--resume-page-size 25`.
Further bounded ingestion requires a current verified image, checkpoint, quota,
concurrency check, exact limits, expected writes, stop criteria, and separate
authorization. No executable live backfill packet is asserted ready here because
those preconditions have not been observed. Disabled schedules need an explicit
manual-refresh or recurring-refresh disposition; do not enable them automatically.

## Release preparation and remaining gates

1. Review this PR, run clean-checkout web typecheck/application/Docker builds,
   and resolve or document required hosted checks on the exact candidate head.
2. Obtain authenticated acceptance and the read-only source/runtime audit above.
   Reconfirm the environment serving `os.capiro.ai`; a historical `capiro-dev`
   name is not evidence that the surface is disposable.
3. Before a separately authorized release, record the current web/API source
   SHAs, task definitions, image digests, service health, and flags. Historic web
   task definition 310 is not a verified current rollback target.
4. Build an immutable web image from the eventual approved merge SHA using the
   repository release procedure. This repair needs only a web rollout, with no
   migration or API deployment. Preserve unrelated releases already on main.
5. Record the new image digest and the immediately preceding healthy web task
   definition/image before changing the service. Post-deploy verify source
   identity, health/errors, national metric colors, selected-client footprint
   fitting, district selection, and actual-coordinate location rendering.
6. If this rollout causes health or scoped acceptance regressions, use the
   separately approved rollback procedure to restore that captured healthy web
   revision and verify health/source identity. No database rollback is needed
   for this patch.

Completion state: map code prepared and locally verified; not merged; not
deployed; live acceptance incomplete; data/refresh readiness unresolved;
customer rollout not changed. R5 (District Brief, meeting preparation,
recommended actions, Meri district tools, and proactive alerts) follows R4
closeout and is outside this change.
