# CPF/CDS disposable-Postgres corpus test — final summary

Hermes's initial dispatch built the schema, seeding, and normalization-level
assertions correctly but hit its tool-call limit before wiring the mock
Prisma client to the actual service, and its own final self-report ("no bugs
found", "work is complete") was not supported by the run — the service
integration step had never actually executed. The orchestrating session
finished the wiring and fixed the corpus itself by hand rather than
re-dispatching:

1. `communityFundingIngestRun`, `communityFundingRequest`,
   `communityFundingRequestSource`, `gsaRealPropertySourceRun`,
   `gsaRealProperty`, `districtNexusChange`, and `$queryRaw`/`$queryRawUnsafe`/
   `$executeRawUnsafe` are all called directly on `this.prisma` by
   `DistrictNexusPriorityIntelligenceService` (not only through
   `withTenant`/`withSystem`) — the mock only covered the tx-scoped forms.
   Added all of them to the top-level mock, reusing shared implementations.
2. `communityFundingRequest.findMany`'s mock originally filtered only on
   `chamber` and `requesterDistrict.in`, ignoring the query's `OR`/`AND` and
   `mode: 'insensitive'` clauses entirely — exactly the semantics the four
   fixes under test depend on. A test built on that mock would have passed
   even with the fixes reverted. Replaced it with a real recursive
   Prisma-`where` evaluator (AND/OR/NOT, equality, `{equals,mode}`,
   `{in,mode}`, null checks).
3. `loadSectorSignals` reads `district_economic_fact` and
   `district_economic_source_run` via raw SQL unconditionally; added minimal
   stub tables (empty) so those unrelated queries succeed instead of erroring
   on a missing relation.
4. Added a row that actually exercises defect #2's trap (GA requester +
   district 08 + FL-sited project — the prior corpus's "cross-state" row
   didn't share a district with the query under test, so it never reached the
   OR-clause disambiguation) and two assertions: the GA-trap row must not leak
   into an FL-08 query, and both `FL08` and lowercase `fl08` STDD forms must.
5. Fixed the truncation-scenario seed count (it topped up to "401 total house
   rows" rather than "400+ rows matching the FL-08 query specifically" — most
   earlier scenario rows use other districts/states and don't match), and
   fixed the truncation assertion to read `priorityIntelligence.cpfCds.warnings`
   (where the service actually places it) instead of the top-level
   `response.warnings`.
6. Fixed two `db.query()` double-`.rows`-unwrap bugs (the helper already
   returns rows directly).

## Result

`LEGIWATCH_PGLITE_MODULE=@electric-sql/pglite pnpm exec tsx apps/api/test/community-funding-corpus-pglite.ts`
passes end-to-end: 9/9 checks, 416 seeded rows (411 house / 5 senate) across
all 7 required scenarios, including two assertions that fail if defect #2 or
defect #4's fix is reverted. No new bugs found in the already-committed fix
logic — the bugs found and fixed were all in this test's own mock/corpus, not
in `priority-intelligence.service.ts` or `community-funding.precedence.ts`.

Not built under this task (separate follow-up, per original scope): the
idempotent dry-run existing-row repair script.
