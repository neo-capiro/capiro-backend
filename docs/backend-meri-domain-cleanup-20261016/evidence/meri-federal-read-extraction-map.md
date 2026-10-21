# Pre-edit Meri federal-legislation read extraction map

Source-only preparation on 2026-10-16. Repository `neo-capiro/capiro-backend`, isolated branch `cleanup/backend-meri-domain-20261016`, sealed PR32 HEAD `0483963adc5382202408e8398d8b1601f53d8525`. Source/application files are unmodified at preparation time. This map is the only deliverable written by this preparation step; no Node, test, parser, compiler, application or helper was executed.

## Exact current owner and proposed boundary

Current canonical owner: `apps/api/src/meri/meri-tools.service.ts`, regular Git blob `32a7a744ba9ab812337baaf6093a37540864333b`, 415,221 checkout bytes. The proposed new canonical owner is `apps/api/src/meri/meri-federal-legislation-tools.ts`.

| Current method | Source lines, inclusive | Method lines | Role after extraction |
| --- | ---: | ---: | --- |
| `private resolveBillId(raw: string \| null \| undefined): string \| null` | 3636–3642 | 7 | Private domain helper |
| `private async searchCongressBills(input: Record<string, unknown>)` | 3702–3766 | 65 | Public domain handler; legacy facade remains |
| `private async readBillText(input: Record<string, unknown>)` | 3828–3954 | 127 | Public domain handler; legacy facade remains |
| `private locatedBillText(billId: string, row: FederalBillTextRow, query: string)` | 3961–4018 | 58 | Private domain helper |
| `private async getBillStatus(input: Record<string, unknown>)` | 4020–4155 | 136 | Public domain handler; legacy facade remains |
| `private async searchFloorVotes(input: Record<string, unknown>)` | 4161–4317 | 157 | Public domain handler; legacy facade remains |
| `private async searchCboCostEstimates(input: Record<string, unknown>)` | 4323–4364 | 42 | Public domain handler; legacy facade remains |

The seven methods total **592 physical method lines**, excluding comments/blanks between methods. These are noncontiguous ranges: state-bill resolution/live fallback at 3644–3700 and FedRAMP certification at 3768–3826 remain in the facade. The existing comment at 3768–3773 describes bill status although currently attached to certification; do not silently fix or move unrelated documentation as part of this extraction.

Move the local `FederalBillTextRow` interface, lines **299–314** (16 lines), into the new domain module. Earlier analysis described 299–315, which included its following blank separator; the declaration itself ends at 314. It contains only revision/source/package/bill/version/lineage/hash/locator fields, three nullable/current Date fields and extracted text. Only `readBillText` and `locatedBillText` use this type.

## Chosen design and mechanical preservation

Export an undecorated `MeriFederalLegislationTools` class with an explicit `constructor(prisma: PrismaService, ldaIntel: LdaIntelService)`. Declare the two readonly fields separately and assign them in the constructor; do not use TypeScript parameter properties, Nest decorators or new DI registration. Prefer type-only imports for these constructor dependency types. The class imports no god service, agent engine, controller, RP transport, memory or tenant authority.

Move the original method bodies **byte-for-byte with their existing class indentation**, retaining SQL template literal indentation and complete query text. Only the five handler declaration prefixes change from `private` to `public`; the two internal helpers remain private. Do not deindent/reindent bodies, normalize SQL, change query bindings, replace default expressions, add caching, combine queries or correct existing behavior. `new Date().toISOString()` remains at the same execution points.

The legacy five private facade methods keep their names, input signatures and async behavior. Each constructs `new MeriFederalLegislationTools(this.prisma, this.ldaIntel)` and delegates to the corresponding public handler. The large service's constructor parameter list/body stays unchanged. Per-call domain construction creates no I/O, captures no turn state, and introduces no application lifetime or authorization boundary.

Remove the two original internal helper implementations and the original `FederalBillTextRow` declaration only after their module owner has moved. A bounded private-name consumer search across `apps/api/src/meri/**/*.ts` found no external calls to `resolveBillId` or `locatedBillText`; direct private-method test calls target only the retained status/floor/CBO facades.

## Canonical validation leaf

New `apps/api/src/meri/meri-tool-input.helpers.ts` owns these original declarations with their original bodies; only an `export ` prefix is added:

| Declaration | Original lines |
| --- | ---: |
| `UUID_V4_RE` | 342 |
| `requiredString` | 9867–9871 |
| `optionalString` | 9873–9879 |
| `clampInt` | 9969–9974 |

The leaf imports only the existing `BadRequestException` owner needed by `requiredString`. Both the new domain and the legacy service import these same canonical exports. Remove the old declarations rather than copy them. Preserve trim/empty-string/max slicing, exact required-field error, number/string conversion, finite-number fallback, integer truncation and clamp order. The UUID regexp stays exactly version-4-specific, case-insensitive and without stateful flags. The legacy scheduler's existing uses at 8066/8083 keep importing that same regexp; its behavior does not change. Other local validators such as `optionalBoolean` and `optionalStringArray` stay in place and call the imported canonical functions where applicable.

This removes any need for callbacks, copied generic validators, or a domain-to-facade import cycle.

## Complete domain dependencies and behavior to retain

Database dependency surface: Prisma `$queryRawUnsafe`; `congressBill.findUnique`; `congressBillAction.findMany`; `rollCallVote.findMany`; `billRuleLink.findMany`; `congressMember.findUnique/findMany`; and `cboCostEstimate.findMany`. These handlers do not use tenant transactions, user membership, memory, conversation scope, features, credentials or provider calls.

The only other service dependency is `LdaIntelService.getCongressBills` at `apps/api/src/lda-intel/lda-intel.service.ts:482`: existing title/policy/congress/activity discovery, count and pagination. Reuse it unchanged. A textQuery uses the existing SQL passage-search owner; a resolvable query first tries exact bill identity, then retains the original LDA fallback.

Shared imported algorithms: `formatBillId`, `isValidCanonicalId`, `normalizeCanonicalId`, `parseBillDesignation`, `currentCongress`, `billStatusLabel` from `@capiro/shared`. Existing navigation owner `meri-bill-text-search.ts` supplies `BILL_TEXT_BILLS_PER_PAGE`, `BILL_TEXT_MAX_BILLS_PER_PAGE`, `BILL_TEXT_PAGE_CHARS`, `BILL_TEXT_PASSAGE_SEARCH_SQL`, `billTextCursor`, `billTextSearchResponse`, `locateBillTextPassages`, and `BillTextSearchRow`. Keep that owner and its algorithms unchanged. Runtime builtins are Date/Buffer; validation exceptions remain the existing Nest exception type.

Preserve exact bill/version/revision/hash cursor validation, canonical base64url admission, requested-version binding, SQL order/limits, stale-text/offset refusal, surrogate-safe page boundaries, exact provenance fields and complete/partial coverage. Preserve rule-failed/no-recorded-vote honesty, ambiguous/unresolvable member short circuits, Senate bioguide-or-LIS matching, and explicit absent-CBO results. In particular CBO currently lowercases/trims the supplied bill ID rather than using `resolveBillId`; do not unify those semantics during extraction.

## Existing dispatch, transport and authority consumers

The five existing local dispatch keys remain at `meri-tools.service.ts:2642–2647`: `search_congress_bills`, `get_bill_status`, `read_bill_text`, `search_floor_votes`, `search_cbo_cost_estimates`. Keep `executeFromAuthenticatedUser` at 2467, `execute` at 2569, `executeScoped` at 2578 and the exact registry path unchanged. Shared capability names/descriptions/read-only/surface entries remain in `packages/shared/src/index.ts:4238`, 4246, 4254, 4270 and 4278. `TOOL_DEFINITIONS` continues to reference `MERI_CORE_TOOL_DEFINITIONS`; no schema is copied into the new owner.

`meri.controller.ts` blob `598e9146e5568349f213cbd548de0213113dc924` retains class `@Controller('clio')`, RolesGuard and standard-user role at 310–312; manifest/schema GET handlers at 488/500; guarded `POST tools/:name` at 512–570. Existing attachment admission, RP admission, telemetry, request cancellation scope and canonical authenticated tool dispatch remain in place.

`meri-rp-tool-transport.ts` blob `4bca739696cbed54cda61f53173e0c6489a4a181` is active authority, not duplicate business code. Admission at 72 validates configured internal identity and current-turn envelope; AsyncLocalStorage scope at 112 reaches the current-use recheck at 124. That recheck binds tenant/user/conversation, selected client and RP grant and repeats the conversation read against drift. It applies only to canonical RP proposal names. Do not change its source, guard policy, or the RP delegation closure at `meri-tools.service.ts:2585`.

`governed-meri-tools.proxy.ts` blob `88c7c163a62959ea3b631b2116e3db3f8cca3e1b` retains execute interception at 176 and authenticated interception at 188, chart ownership checks, governed-memory presentation and federal-market dispatch. Module registration at `meri.module.ts:161–165` keeps the raw service token and proxy factory unchanged. No new module/provider/export wiring is necessary for the undecorated domain class.

Existing callers continue to resolve through the unchanged facade: read-only chat `meri.service.ts:2147`; research current-owner reauthorization `meri-research.service.ts:1462`; research dispatch at 3728; and generic approved action paths `meri-action-proposal.service.ts:747/1199`. Leave their execution loops, retries, approval, authorization and audit behavior unchanged.

Public research classification at `meri-research-producer-inputs.ts:59–93` already includes these five tool names. Durable current-owner replay at `meri-research-replay-authorization.ts:60–61` includes status/text; `meri-report-provenance.ts` and shared `meri-read-outcome.ts` retain the corresponding authoritative-owner contracts. No result-field or replay-proof changes are allocated.

## Existing tests and concrete constructor/prototype constraints

| Retained source | Git blob at sealed PR32 | Relevant coverage |
| --- | --- | --- |
| `meri-bill-status-tool.spec.ts` | `4e1ccd00c1ca42cb56283a2082f0daf27ca0fb2e` | Seven cases at 84,107,116,127,156,170,206: stalled rule/no floor vote; designation; missing bill; votes; unknown/ambiguous member; bioguide-or-LIS filter |
| `meri-cbo-tool.spec.ts` | `30a58daf21f0cc6fb90e73cd7237d7732c21d8ef` | Two cases at 20/41: published estimate and explicit no-estimate |
| `meri-bill-text-search.spec.ts` | `031ec4b8cfcf267970a19023d4519c97596fbbfe` | Eleven helper cases: query parsing, deterministic bounded passages, grouping/cursors, response budget and complete/empty paging |
| `meri-bill-text-search.pg.spec.ts` | `ee69e9939929195361ac1e84ca4f49e1e25975cb` | Six PGlite cases: migration/trigger indexing, collection/completeness exclusion, cross-window phrases, Congress filtering, bill pagination, insert-only passages; heavy queued qualification |
| `meri-remaining-source-families.spec.ts` | `73b63a7de292911903e1309a6b60525f54e3b629` | Dispatch-level exact current text (287), located partial read/cursor/stale hash (328), model budget (376), stored text search (407); replay metadata cases at 483/582 |
| `meri-tools.registration.spec.ts` | `4e79ee826a4d39d3b4e4c684a20ee29cc5ceae60` | Every advertised schema reaches an existing callable facade at 677; exact surface at 794; schema emission at 801 and required inputs at 926 |
| `meri-tool-manifest.parity.spec.ts` | `3ba4c553c04e1b2f948a931e5757d8b6493fea52` | Cross-surface manifest contract retained |
| `meri-rp-tool-transport.http.spec.ts` | `8780d7ebe4babc39be03fe677873ce079f2a73a3` | Actual repo/HTTP/controller/canonical-owner admission and drift cases retained; no RP test rewrite |

`meri-bill-status-tool.spec.ts:12–22` creates `Object.create(MeriToolsService.prototype)` and adds only fake Prisma. `meri-cbo-tool.spec.ts:10–18` directly calls the original prototype method with plain `{ prisma }`; `ldaIntel` is consequently undefined but unused by the CBO handler. Do not require eager LDA validation in the new domain constructor. The five per-call legacy facades preserve both fixtures without changing their evidence or adding constructor fallback behavior.

`meri-remaining-source-families.spec.ts:28–39` constructs the full service positionally via Reflect with a fixed argument array. The god service constructor must remain byte-for-byte unchanged. `meri-tools.registration.spec.ts:677–791` intercepts prototype methods and expects exactly one callable dispatch per schema; keep the existing facade entry names and registry expressions.

## Qualification plan and allocation limits

No application source edit is allocated by this map alone. After the map is sealed and the parent allocates source paths, the bounded implementation should include only the existing facade, the new domain and the new canonical input helper, plus specifically allocated focused controls/proof. Preserve existing native specs. A one-time source proof can reconstruct original method/helper bodies and literal SQL byte identity without turning the entire service into a permanent frozen snapshot. Permanent focused tests should exercise actual domain results and facade/prototype compatibility and allow unrelated facade changes.

Focused semantic cases should cover all five handlers, canonical input edge cases, exact SQL parameter/order/text preservation, cursor/hash/version/offset refusal, explicit no-data and ambiguous-member results. Existing native suites and typing/build checks stay in the coordinated local queue. No new Node/test/compiler process, full-suite/build/image test, install, schema/migration, route/auth/security, RP, tenant, memory or live/runtime change is authorized by preparation.

No concrete design blocker found with the parent's explicit-constructor/per-call-facade design. Source implementation is pending the parent map commit/path allocation and Core ownership coordination; execution remains pending its separate queue allocation.
