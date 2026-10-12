# Core Tango REST parsing seam audit

This is a read-only audit of published rebuild PR 2412 at `6a4b48e6286a270ab18c033eb4ccaf6f72f42c70`, tree `f14d6fa3f191645839414972063e1057fce557bf`. No production files changed. Parent retirement coordination is still required before source implementation. The excluded unpublished EngagementService reporting owner was not assessed.

The next bounded extraction can move count, next-page, and response-rate parsing into **one local pure owner**, `apps/api/src/external/tango/tango-rest-page.ts`, with one new `tango-rest-page.spec.ts`. It cannot safely unify these clients' envelopes, error classes, request setup, deadlines, credential handling, or caller retries. It is partial progress toward CleanUp4's HTTP seam, not completion of Wave 1, T6, or a shared transport.

## Exact duplication and proposed interface

Source identities and AST-derived line spans are in [leaf-source-inventory.json](evidence/leaf-source-inventory.json). These are declaration spans, including their internal blank lines; they are not a predicted net diff.

| Leaf | DIBBS | SBIR | Subaward | Equality and preservation |
|---|---|---|---|---|
| `asCount` | client:135–138, 4 lines | client:168–171, 4 lines | client:53–56, 4 lines | Byte-identical across all three. Preserve Number coercion, truncation, null/empty/boolean behavior, and thrown coercion errors. |
| `nextPageOf` | client:148–157, 10 lines | client:181–190, 10 lines | client:58–67, 10 lines | Byte-identical across all three. Extract the positive integer page only; never fetch or follow the supplied URL. |
| `rateOf` | client:159–179, 21 lines | client:192–212, 21 lines | client:69–93, 25 lines | DIBBS/SBIR are byte-identical. Subaward captures four raw numeric values before coercing them; DIBBS/SBIR interleave each read and coercion. Preserve both profiles. |

The three source files are 297, 329, and 178 lines. The candidate declarations total **109 lines: 35 + 35 + 39**. An earlier preliminary message estimated 123; the AST inventory corrects that estimate. Strict repeated declaration spans total 84 lines: 42 for count/next across all three plus 42 for rate across DIBBS/SBIR. Subaward's 25 rate lines are a behavior-profile variant. Removing all 109 local declaration lines will require a profile-preserving canonical implementation; its net line reduction is not yet known.

Proposed internal exports, using the existing `TangoRateMetadata` owner in `tango.errors.ts:55`:

```ts
export function asCount(value: unknown): number | null;
export function nextPageOf(next: unknown, baseUrl: string): number | null;
export type RateReadProfile = 'interleaved' | 'captured';
export function rateOf(headers: Headers, profile: RateReadProfile): TangoRateMetadata | null;
```

Require an explicit literal profile at every call: DIBBS/SBIR use `interleaved`, Subaward uses `captured`. Keep one numeric conversion kernel and the common all-null/result construction, with a branch that preserves the exact per-profile evaluation sequence. Root-owned guard data should declare the three consumers and their exact profile; no new service, store, dependency, external configuration, or general policy engine is needed. Existing exported classes, interfaces, methods, page DTOs, and error identities remain unchanged.

The original leaf differential runs 68 cases against each actual source declaration, 204 executions total. Outputs and throws agree in those cases, including real Headers, inherited methods, getter receivers, missing/throwing get, counts with inherited/valueOf properties, URL/prototype-looking strings, and invalid bases. Three supplemental malformed object-valued header probes add nine executions: stable-number coercion, throwing coercion, and coercion that changes later header reads. They prove the original profiles differ: Subaward performs four gets before any numeric coercion, including when the first coercion throws; mutation can also change the final rate values. Equal final numbers in the stable probe do not prove equal effects. The canonical implementation must preserve each profile, rather than silently reduce its compatibility claim to valid Headers.

## Request, authorization, deadline, and error profiles to preserve

Evidence anchors refer to the frozen source file and symbol, not a future line number. DIBBS means `tango-dibbs.client.ts`, SBIR means `tango-sbir.client.ts`, Subaward means `tango-subaward.client.ts` under `apps/api/src/external/tango`.

| Behavior | DIBBS | SBIR | Subaward |
|---|---|---|---|
| Config/public construction | Config:48; constructor:187 | Config:77; constructor:220 | Config:30; constructor:101 |
| Key/default host/deadline/fetch capture | Trim key or null; `https://tango.makegov.com`; remove trailing slashes; `timeoutMs ?? 30_000`; `fetchImpl ?? fetch` | Same expressions | Same expressions |
| Configured check | Getter:194; missing key throws `TangoNotConfiguredError(label)` before URL/fetch at:222 | Getter:227; preflight:254 | Getter:108; preflight:113 |
| URL/query setup outside try | Private list:224–229 | Private list:256–261 | listSubawards:115–124 |
| Request/auth headers | GET, exact `Accept: application/json` and `X-API-KEY`, signal at:234–238 | Exact request at:266–270 | Exact request at:128–132 |
| Deadline lifetime | Per-call AbortController + timeout:231–232; finally clear:293–294 | Setup:263–264; finally:325–326 | Setup:125–126; finally:174–175 |
| Non-OK status policy | Every status becomes `TangoDibbsHttpError(status, message, rate)` at:240–248 | `TangoSbirHttpError(status, message, rate)` at:272–280 | `TangoSubawardHttpError(status, message)` at:135–140, no failure rate |
| HTTP error identity/retry marker | Class:55; rate defaults null; `isRateLimited` is status === 429 | Class:84; same marker/rate shape | Class:37; status/message/name only, no retry marker/rate |
| Non-OK body redaction | All exact key occurrences using split/join, then slice 500 at:243 | Same at:275 | First exact occurrence using replace, then slice 500 at:136 |
| Invalid JSON on an OK response | Own EnvelopeError at:251–255 | Own EnvelopeError at:283–287 | Own HttpError with response status, even 200, at:142–149 |
| Success envelope | Reject null/scalar/array root; require results array at:257–269 | Same structural checks at:289–302 | No root validation; missing/nonarray results means empty items at:151–156; null becomes caught status-0 failure |
| Successful row filtering | Keep non-null non-array objects at:271–274 | Same at:303–306 | Same predicate at:153–155 |
| Abort error | Error instance named AbortError → status 0, exact DIBBS timeout message at:289–290 | Exact SBIR timeout message at:321–322 | Exact subaward message at:167–172 |
| Other failures | Preserve typed own errors; otherwise status 0 with Error.message/String at:281–292 | Same own identities at:313–324 | Same conversion at:163–173 |
| Client retries | None; one fetch per call | None | None |

The timer surrounds fetch, response.text, and decoding until finally. It is an abort notification, not Promise.race; a transport ignoring abort may still succeed. URL/option conversion exceptions happen before this try/catch. Preserve those boundaries, exact capture timing, and no caller-signal fusion. Raw constructor timeout values are not newly clamped. Limit normalization leaves NaN as NaN; do not fix that under extraction.

The raw clients have no HTTPS/host allowlist enforcement. Core's existing config schema separately validates HTTPS and a positive integer timeout at `apps/api/src/config/config.schema.ts:987` and `:995`; sync CLIs construct clients directly from environment-derived values. Do not add, remove, or unify host/auth/deadline rules. `nextPageOf` currently accepts page numbers from relative, absolute, other-host, HTTP, and opaque/prototype-looking URLs; only the page is returned, and requests still use each client's original base/path.

Existing Subaward first-occurrence redaction and unredacted arbitrary transport-error messages are preserved source behavior, not security acceptance. Switching to `redactWithKnownSecret` would change marker, matching, and minimum-length behavior. Security corrections require their own coordinated scope.

## Endpoints and consumers

| Owner | Exact retained request contract |
|---|---|
| DIBBS listRfqs:198, listRfps:204, listAwards:210 | `/api/dibbs/rfqs/` + `issue_date_after`; `/api/dibbs/rfps/` + `issued_date_after`; `/api/dibbs/awards/` + `posted_date_after`. No ordering. |
| SBIR listTopics:231, listSolicitations:240 | `/api/sbir/topics/` + open/close/release date after and solicitation_number; `/api/sbir/solicitations/` + start/end date after and program. No ordering. |
| Subaward listSubawards:112 | `/api/subawards/`, ordering `-last_modified_date`, byte-exact SUBAWARD_SHAPE:12, fiscal_year when non-null, prime_uei/sub_uei when truthy. No modified_after or provider-rejected extra shape fields. |

Production symbol searches across `apps`, `packages`, and root `scripts` identify these direct constructor consumers and the interface consumer below. Spec files were inventoried separately. No unpublished branch was searched. These are preservation dependencies, not retirement recommendations.

| Consumer | Source identity | Semantics held outside the extraction |
|---|---|---|
| DIBBS scheduled/CLI sync | `apps/api/scripts/sync-tango-dibbs.ts:new TangoDibbsClient` at:668; gateway:205; fetchWithRateLimitRetry:321 | Default five retries after the initial attempt, only typed own 429; retryAfter ?? resetIn ?? 35 seconds, cap 120000 ms. Zero stays zero. requestAttempts counts every try; default 20-request per-endpoint budget:136/365. Exhausted 429 marks one endpoint partial, continues other endpoints:433. |
| SBIR scheduled/CLI sync | `apps/api/scripts/sync-tango-sbir.ts:new TangoSbirClient` at:661; gateway:212; fetchWithRateLimitRetry:313 | Same five/35/120000 typed-429 policy, without DIBBS requestAttempts/budget. Exhaustion is endpoint-local:408. |
| Subaward scheduled/CLI sync | `apps/api/scripts/sync-tango-subawards.ts:new TangoSubawardClient` at:555; gateway:144; page call:319 | No retry wrapper; existing sync ledger/error handling retained. |
| Capability diagnostic | `apps/api/scripts/diag-tango-capabilities.ts` constructors:164/174; `tango-capability-probe.service.ts` type imports:3/4, gateways:128/129, options:409/410 | Injects REST gateways; deliberate diagnostic no-retry at:558. CLI supplies its own parsed timeout. |
| Contract-capture diagnostic | `apps/api/scripts/diag-tango-contract-capture.ts` constructors:274/275; error identities:230–235 | Supplies key/base, inherits 30-second deadline; preserves own-error instance checks and fixture/result labeling. Not executed. |
| Subaward gateway DTO owner | `tango-subaward.types.ts:TangoSubawardGateway` at:64 | Retain page/list interface; no additional API exposure. |

The dispatcher registers the three sync commands in `apps/api/scripts/entrypoint-dispatcher.inc:723`, `:736`, and `:756`; `apps/api/package.json:73` also exposes the Subaward sync alias. Registration is evidence of live source wiring, not proof that any schedule should be retained or retired. No dispatcher, schedule, infrastructure, or package alias changes belong to the proposed application extraction.

Do not substitute the SDK path. `tango.module.ts:56` registers TangoGatewayService and TangoResilienceService, not these REST classes. `tango.client.ts:613` uses SDK nextCursor presence and SDK rateLimitInfo:619; `tango-resilience.service.ts:51` uses classified TangoError retryability plus breaker, request ceiling, usage persistence, and a positive retryAfter policy:425. Those semantics differ from the REST sync callers. Their existing owner is useful evidence against a new generic service, not a compatible replacement for these leaves.

## Existing tests and finite characterization plan

Existing test cases must remain. They were read, not executed during this audit. Preserve `tango-sbir.client.spec.ts` request/envelope/error describes at:52/177/232, its dynamic invalid-envelope cases, its repeated-secret test:233, rate tests:242/262/272, transport test:280, abort test:288, and custom-base test:304. Preserve all three `tango-subaward.client.spec.ts` cases at:9/16/60. DIBBS client characterization is embedded in `apps/api/scripts/sync-tango-dibbs.spec.ts:822`, with request/rate and retry cases earlier, and sync ledger cases later. SBIR sync's typed-429, retry exhaustion, pacing/cap, and nonretry auth cases likewise remain in `sync-tango-sbir.spec.ts`. Capability-probe and contract-capture diagnostic specs remain dependencies.

New pure-helper spec should compare the candidate functions to preserved original source fixtures, not duplicate candidate code. Reuse the recorded count, URL, inherited/prototype/getter, missing/nonarray/wrong-count, header receiver, missing/throwing get, and arbitrary coercion cases. Add effectful header-return objects whose Number coercion throws or changes the next read, asserting each declared profile's exact get/coerce sequence and throw identity. Assert header get lookup occurs on every call with its original receiver, no module-time sampling, no retained state between calls, and original HTTP-date Retry-After remains null. Preserve original success-envelope fragments byte-exact and rerun their 18-case differential against composed clients.

Once authorized, run the existing relevant client/sync/probe/diagnostic specs only with inert fake transports and guarded synthetic fixtures. Do not import or execute live sync/diagnostic entrypoints for characterization, do not run providers, and do not widen this slice to native acceptance. A focused strict compiler check and source hashes should confirm the clients change only imports, the selected helper declarations, and explicit rate profile operands.

## Exact future scope and same-change root dependencies

| Ownership | Proposed files |
|---|---|
| Bounded application source | The three audited client files; new `apps/api/src/external/tango/tango-rest-page.ts`; new `apps/api/src/external/tango/tango-rest-page.spec.ts`. No envelope/filter/error/constructor/transport body extraction. |
| Root integration/ratchet | Root owns proposed `scripts/check-duplicate-helpers.mjs` and/or `scripts/check-http-client-bypasses.mjs`, their data/tests, root package alias, and CI wiring. Both proposed guard filenames are absent at this base; no existing implementation is claimed. |
| Existing CI precedent | `package.json:115` exposes the Strategy time guard; `.github/workflows/ci-pr.yml:216` invokes it. A new Tango leaf guard must likewise run in the same source change, including draft PRs, with its own inert tests. |

CleanUp2 §4.4 (`docs/plans/CleanUp2.md:227`) requires data-driven migrated-helper names and same-change CI. CleanUp4 §8 (`docs/plans/CleanUp4.md:256`) requires guards with each seam. A finite Tango guard should declare this local canonical owner, all three required imports/calls, and their rate profiles. Refuse reintroduced local declarations, renamed/aliased helper copies, namespace/destructuring aliases, quoted/computed member definitions, forwarding fallbacks, and missing/wrong-profile adoption within its expressly supported static grammar. Add inert negative and benign shadow/comment/type controls. Do not claim arbitrary JavaScript/runtime containment. Since this proposal does not adopt a shared transport, it cannot waive or declare all direct fetch sites converted; the three exact existing fetch sites remain profile-owned. Any new HTTP bypass scan must keep a precise original inventory and refuse additions rather than blanket-allow the app/folder.

## Evidence and remaining gates

`original-leaf-differential.mjs` extracts and transpiles only the actual three pure declarations using cached installed TypeScript. `original-envelope-profiles.mjs` extracts only each original successful parsing fragment and its existing catch/error conversion, using synthetic decoded objects. Neither executes a client constructor, fetch, response.text, timer, provider, database, or native engine. Passed receipts: 68 main leaf cases / 204 original executions plus three profile probes / nine executions, and 18 envelope cases / 54 original parser executions. That is 267 recorded original fragment executions. These are original-source characterization, not candidate implementation acceptance. The prior passing leaf packet before the last two profile probes is retained with the `before-profile-probes` suffix.

The envelope harness first failed because strict equality compared a VM-realm empty array with a host-realm empty array. The failed source and raw log are retained; the corrected assertion checks its length. No production change fixed that harness failure. The initial independent-review child ended with a selected-model capacity error; it produced no review acceptance, and no model override or retry bypass was used. Parent may arrange independent review after this packet is frozen.

Remaining gates: parent retirement-map/source coordination, profile-preserving implementation, same-change data/ratchet/CI, independent adversarial candidate review, and applicable existing synthetic tests/type checks. Full CleanUp1/native/RLS/provider/security acceptance is outside this packet and remains unclaimed.
