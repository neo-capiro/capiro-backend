# Public authored-SQL legislative and opportunity coverage

The existing Core curated registry adds seven public relations. The existing AST compiler, dedicated `capiro_analytics_ro` executor, request limits, typed output and public/private boundary remain the owners. There is no second SQL engine, model harness, endpoint or database connection.

Source base: actual Core main `e023eee01783f04b59ec8ab88d86ab586ee55826`, tree `cca1e0fcf8e7baeb70b6413c2db5c839d9356913`. The checked-in Prisma schema, existing QuerySpec registry and Live Hearings/domain readers establish field types, keys and semantics. Source presence does not prove serving grants, rows, freshness or availability.

| Logical relation | Storage projection | Row identity and meaning |
| --- | --- | --- |
| state_bills | public.state_bill (existing table permission) | `id`: state/session/bill canonical key, not display identifier or OpenStates ID |
| committee_hearings | public.meri_public_committee_hearings (new restricted view) | text `id`: canonical public federal/state event |
| committee_hearing_bills | public.meri_public_committee_hearing_bills (new restricted view) | text `id`, unique `(hearing_id, bill_id)`: legacy federal association |
| legislative_agenda_items | public.meri_public_legislative_agenda_items (new restricted view) | UUID `id`, unique `(hearing_id, item_key)`: source-backed agenda assertion |
| state_bill_calendar_events | public.meri_public_state_bill_calendar_events (new restricted view) | UUID `id`, unique `(bill_key, event_key)`: per-bill assertion, not unique hearing |
| federal_grants | public.federal_grant (existing table permission) | Grants.gov opportunity `id`, not an award |
| sam_opportunities | public.sam_opportunity (existing table permission) | unique `notice_id`, not solicitation/contract/award identity |

The original eight public relations and their permissions/behavior are unchanged. Private records and the private SQL registry are unchanged.

## Fixed public semantics

The hearing view excludes aliases and nonpublic events. Both agenda views require the same matching public canonical parent, including when queried alone. The calendar-assertion view exposes only its exact published scalar fields. No raw/evidence JSON, tenant-owned recordings, private playback locators, capture data, private notes, enrichment internals, follows/subscriptions, documents or contact emails enter these views. The compiler still admits only logical relation names and exact fields; it cannot select the physical view or base table directly. It has no raw-table fallback or predicate referencing hidden base columns. DB views own row filtering, so even a reader query outside the compiler is constrained by the new projections and DB privilege prerequisites.

Declared agenda bill references are soft. LEFT JOIN preserves a source key when its bill is absent locally. State and federal IDs remain separate namespaces. Names, display identifiers, solicitation numbers and per-parent item/event keys are not independent join keys. Deduplicate the intended identity before counting across children. Do not add legacy/source-backed agenda counts or combine per-bill calendar assertions with canonical hearing counts.

`starts_at` remains a nullable UTC instant. Display dates and wall-clock text never become fabricated midnight instants. Event status, source update, observation and ingestion times remain distinct. Row revisions are not a database snapshot/version guarantee.

Grants expose nullable source estimates/floors/ceilings in USD with their existing Float storage limitation explicitly documented. Text output avoids further JavaScript-number loss but cannot restore absent source precision. These are not obligations, awarded amounts or expenditures. Distinguish synopsis/forecast and read deadline qualifiers. SAM active/archive state is not response-window status; current notice type differs from original base type. No fiscal year or per-award identity is inferred. Lane 6 award correction/population and B8 forecast decisions remain outside this change.

## Database design and custody

`VIEW-MATRIX.json` is the fixed four-view contract: exact names, source columns/types/nullability/UUID storage, primary keys and source predicates. SHA256 `a9fefe48b79cc55d3c49f636e4cb459fac49639c12255a23c5a4b223b697a00d`. `READ-DEPENDENCIES.txt` covers all seven additions and reader-facing dependencies. DB owner chat `01a189d5-5626-7a33-8f04-23459494107a` owns the separate forward-only SQL package and local synthetic DB qualification. No migration identifier, DDL, role change or grant is allocated/executed by this source patch. Bind the exact DB package/source pins before integration.

The agreed proposed view owner is a separate `capiro_public_query_owner` with NOLOGIN, NOINHERIT, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS and only required underlying column SELECT. Do not reuse the private projection owner, whose tenant/private authority is broader. Grant the runtime reader SELECT only on these four views. For these four raw tables, DB preflight must fail closed if the reader already has effective table/any-column SELECT or write rights through direct, PUBLIC or membership paths. Preserve unrelated existing grants; do not silently revoke them. Any conflict returns to DB/Root for an explicit decision.

Child view availability depends on the granted view; its owner needs the raw parent columns to enforce the fixed predicate. The reader does not need raw parent access. The existing executor's table-level SELECT privilege check works for views. DB qualification must verify exact view definitions/ownership, read-only role attributes and effective grants, public/canonical row enforcement, field exclusions and missing-dependency failure. A missing view/privilege remains SOURCE_UNAVAILABLE, never an empty result.

The historical role migration includes conditional state_bill/federal_grant/sam_opportunity permissions. Those existing permissions are preserved and actual-target status remains unknown. This patch does not claim database-level column isolation for those preexisting table grants. New hearing views provide the narrower DB boundary required by Root; they do not retroactively change all legacy QuerySpec permissions.

The earlier table-wide hearing grant proposal is removed in the successor change. Table-wide grants expose all raw fields/rows and rely on compiler restrictions alone. Column grants would narrow fields but would not filter rows and are incompatible with the current table-level reader preflight. Restricted views provide the needed row/column boundary without relaxing that executor or the compiler.

## Coordinated wire and serving gate

The common SQL owner, chat `01a19189-8fb4-7eb1-8317-ae47b1620547`, owns metadata/availability and compatible Meri transport changes. Core currently bounds explicit describe input to eight relation names; default describe now returns fifteen. The existing metadata-count test is updated to fifteen.

This is an actual composition dependency: Meri `9ac1fa588c99f9362641bdf8d28319fd285d5e0a`, `packages/contracts/retrieval-0.2/capiro-data.schema.json`, caps `CapiroDataDescribeRequest.properties.relations`, `CapiroDataDescribeSuccess.properties.relations`, `CapiroDataCoverage.properties.relations` and `CapiroDataQuerySuccess.properties.relationsUsed` at eight. That unchanged gateway rejects a fifteen-relation default response. The common owner must provide a compatible versioned wire/cap transition, preserving immutable retrieval/skill assets. Do not globally replace every occurrence of eight: private bounds, key lengths, parser limits and 32-column bounds are separate.

Do not merge/serve this candidate before exact DB view-package pins and compatible runtime schema are coordinated and qualified. No new scalar type or query syntax is introduced. Default metadata remains below the existing 262144-byte envelope. Release/DB still need intended-clone identity, dedicated ANALYTICS_DB settings, current schema/grants, representative population and freshness evidence. Source-worker data is not clone acceptance; absent/stale/partial data remains so. Native natural-language path selection and answer accuracy require separately allocated actual tool acceptance.

## Source verification

The new domain suite checks the added physical fields/types/nullability and row keys against the checked-in Prisma schema, and checks the registry against the fixed view matrix. It exercises state/federal agenda joins, missing identities, canonical-key refusals, bound date/notice parameters, distinct bill counts, provenance/precision limitations, view-only storage selection, unsupported fields/domains, and unavailable versus empty/truncated results. Compiler tests retain existing parser, key, parameter, PE fiscal and public/private coverage. All use synthetic values and mocked executor responses; no SQL is executed here. DB behavior belongs to the separate synthetic qualification package.

Exact source checks, retained failures and unrun gates are in the handback. No build, live query, provider/model call, deployment or database change occurred in this source chat.
