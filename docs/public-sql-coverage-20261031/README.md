# Public authored-SQL legislative and opportunity coverage

The existing Core curated registry now describes seven additional public relations. The existing AST compiler, dedicated `capiro_analytics_ro` executor, request limits, typed output and public/private boundary remain the owners. There is no new SQL engine, model harness, endpoint or database connection.

Source base: actual Core `main` `e023eee01783f04b59ec8ab88d86ab586ee55826`, tree `cca1e0fcf8e7baeb70b6413c2db5c839d9356913`. Registry/schema authority is `apps/api/prisma/schema.prisma`; the prior QuerySpec registry and existing Live Hearings/domain readers supply the documented semantics. This is source preparation, not evidence of grants, rows, freshness or deployed availability.

| Logical relation | Physical public table | Row identity and meaning |
| --- | --- | --- |
| state_bills | state_bill | `id`: state/session/bill canonical key, not display identifier or OpenStates ID |
| committee_hearings | committee_hearing | text `id`: canonical public event, federal or state |
| committee_hearing_bills | committee_hearing_bill | text `id`, unique `(hearing_id, bill_id)`: legacy federal agenda association |
| legislative_agenda_items | legislative_agenda_item | UUID `id`, unique `(hearing_id, item_key)`: source-backed agenda assertion |
| state_bill_calendar_events | state_bill_calendar_event | UUID `id`, unique `(bill_key, event_key)`: per-bill calendar assertion, not unique hearing |
| federal_grants | federal_grant | Grants.gov opportunity `id`, not an award |
| sam_opportunities | sam_opportunity | unique `notice_id`, not solicitation/contract/award identity |

`committee_hearings` excludes aliases and nonpublic events using a fixed server-owned predicate. Both agenda projections also require a matching public canonical parent, even when queried without a parent join. No tenant records, hearing follows/subscriptions/captures, raw JSON, arbitrary arrays, contact email, documents or private projections are added. Physical table access still cannot be selected by a model request.

Declared bill references on agendas are soft. A LEFT JOIN preserves the source key when a bill is absent locally. State keys cannot join federal bill IDs. Names, display identifiers, solicitation numbers and per-parent item/event keys are not independent join keys. Use DISTINCT on the intended identity before counting across child rows. Do not add legacy and source-backed agenda counts or combine per-bill calendar assertions with canonical hearing counts.

`starts_at` remains a nullable UTC instant. Calendar display dates/wall-clock text never become fabricated midnight instants. Event status, visibility and source/observation timestamps retain their separate meanings. Source revisions are row metadata, not a database snapshot/version guarantee.

Grants expose nullable source estimates, floors and ceilings in USD, explicitly preserving their existing Float storage limitation. Text output avoids further JavaScript-number loss but cannot restore precision absent from source storage. These are not obligations, awarded amounts or expenditures. Grant forecasts are not open application windows. Read date qualifiers and distinguish synopsis/forecast. SAM active/archive state is not response-window status; current notice type differs from original base type. No fiscal year or per-award identity is inferred. Lane 6 award correction/population and B8 forecast decisions remain outside this change.

## Database and serving dependencies

`READ-DEPENDENCIES.txt` enumerates exact physical columns and predicates generated from the added descriptors. `forward-grants.proposal.sql` is a proposal for the existing DB owner, deliberately outside Prisma migration discovery. No DDL or grants were executed and no migration history was edited.

The historical `20280210010000_meri_analytics_ro_role` migration includes conditional grants for state_bill, federal_grant and sam_opportunity. Source presence does not prove these were applied on the target database. The proposal adds SELECT for four hearing/agenda/calendar tables only. The DB owner must choose the forward migration identifier, review exact target/ACLs, snapshot before a forward migration, and preserve immutable applied migrations. Existing dedicated-role checks, no memberships/ownership/write rights, read-only transactions, timeouts and no application-credential fallback remain mandatory.

**Trust boundary:** these are table-wide SELECT grants. They permit the reader role to read every underlying column and row, including raw/source-evidence JSON, retained aliases and metadata for closed events. The reviewed compiler's fixed projections enforce the narrower field allowlists and public/canonical row predicates; the database grant itself does not enforce those filters. The schema classifies these four tables as global source-backed records and declares no tenant/private-note content in them, but opaque source JSON is not a column-level content guarantee. No live values or RLS policies were inspected. This change does not claim database-level row/column isolation for these tables. Credentials stay with Core's dedicated executor; model requests cannot supply physical names, predicates or alternate registries.

A column-level grant alternative would allow only the listed output columns plus predicate columns, but the existing executor checks table-level `has_table_privilege(..., 'SELECT')`, so it would require a coordinated availability/executor change and would still not filter rows. Reviewed database views could enforce both the exact projections and public/canonical predicates, with underlying tables granted only to a distinct restricted view owner and view SELECT granted to the reader. That alternative needs DB-owned view/ownership/grant DDL, registry table mappings, availability checks and isolated database qualification; it is not silently included in this source patch. DB/Root must assess the underlying restricted-content boundary before adopting the table-wide proposal. No role privileges were changed here.

An agenda-only query also reads `public.committee_hearing` to enforce parent policy. Availability checks must account for that dependency. A missing dependency already fails as SOURCE_UNAVAILABLE at execution; never report an empty success. Do not bypass the parent predicate to make an incomplete database appear available.

The common SQL owner owns metadata/availability and the coordinated Meri transport changes. Public describe currently has an eight-name input bound; this change makes fifteen public relations and updates the existing metadata-count assertion accordingly. Coordinate the explicit supported bound and wire/descriptor/eval fixtures rather than weakening output validation or parser limits. Default describe metadata remains below the existing 262144-byte envelope. No new scalar field type or request syntax is required.

This is an actual composition dependency: Meri `9ac1fa588c99f9362641bdf8d28319fd285d5e0a`, `packages/contracts/retrieval-0.2/capiro-data.schema.json`, caps `CapiroDataDescribeRequest.properties.relations`, `CapiroDataDescribeSuccess.properties.relations`, `CapiroDataCoverage.properties.relations` and `CapiroDataQuerySuccess.properties.relationsUsed` at eight. An unchanged gateway rejects the new default fifteen-relation describe response. The common owner must coordinate those public bounds and Core's describe input bound before this candidate serves. Keep private bounds, key lengths, parser limits and the 32-column limit independently scoped; do not globally replace every occurrence of eight. This source candidate is not a standalone release.

Release and DB owners still need current evidence for the intended clone, dedicated ANALYTICS_DB settings, exact source/schema/grants, representative population and freshness. Hearing source-worker data is not proof of clone data. Missing/stale/partial rows remain missing/stale/partial after adding SQL coverage. Natural-language path selection and grounded answer accuracy require separately allocated actual tool acceptance; compiler tests do not establish either.

## Source validation

The new `public-sql-domain-relations.spec.ts` checks every new physical field/type/nullability and declared unique row key against the checked-in Prisma schema. It exercises state/federal agenda joins, left-join missing identities, bound date/notice parameters, distinct bill counts, source/grain/precision metadata, fixed visibility/alias predicates, unsupported fields/relations/cross-namespace joins, and unavailable versus empty/truncated results. It uses synthetic parameters and mocked executor responses; no SQL is executed. Existing compiler and output tests remain applicable, including private/public exclusion, parser/parameter/output limits and PE fiscal semantics.

Exact command results and unrun or unavailable gates are in the source handback. Full application build, live queries, model/provider calls, deployment and database changes belong to their existing owners and were not run here.
