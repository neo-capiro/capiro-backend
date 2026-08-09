# DIBBS and SBIR/STTR — the REST contract P40–P43 were said to be blocked on, now CONTRACT-VALIDATED

**Status: P40–P43 are NOT blocked on the provider.** This document exists because
this program recorded the opposite, in three places, for a day.

## The correction

Every prior record — the completion matrix, decision log, P17's capability
report, and two handoffs — said DIBBS and SBIR/STTR had "no API surface" and
that P40/P42 were blocked pending MakeGov shipping one.

What was actually verified was narrower: **`@makegov/tango-node@1.1.0` has no
DIBBS or SBIR method.** That is true, and re-confirmed 2026-08-08 by a full-text
scan of the installed package (zero occurrences of dibbs/sbir/sttr across its
whole surface).

"Not wrapped by the SDK" was then written down as "does not exist." Those are
different claims, and the second one is false. Both datasets have a fully
documented REST API:

- <https://docs.makegov.com/api-reference/dibbs/>
- <https://docs.makegov.com/api-reference/sbir/>

The lesson is narrower than "verify things" — it is that a negative finding
carries the scope of the tool that produced it. An SDK scan can only ever
establish an SDK fact. Generalising it to a provider fact required an assumption
nobody wrote down or checked, and it survived four review rounds because every
one of those reviews was scoped to the event-drain code, not to this claim.

## What still genuinely needs a live key

The plan's "API key: Required; P17 must show access" gate is **unchanged**. The
endpoints existing does not establish that Capiro's account plan is entitled to
them — that is exactly what P17's probe was for, and it can only be answered by a
real call with a real key. So:

- **Buildable now, no key:** schema, migration, mappers, sync scripts, fixtures,
  unit tests, dispatcher verbs, disabled schedules.
- **Still needs a key:** the entitlement probe, and any live sync run.

Build against the contract; do not assume access.

## Auth and pagination (both APIs)

- Auth: API key or OAuth2, **required** — HTTP 401 without it. The Tango REST
  API authenticates on `X-API-KEY` (confirmed live during P44's probe), *not*
  the `X-Tango-API-Key` header the plan specifies for MCP. The two surfaces do
  not share a convention; do not infer one from the other.
- Pagination: `page` (default 1), `limit` (default 25, **max 100**).
- Both expose `ordering`, `search`, and `shape` (field selection).

Note the pagination scheme differs from the SDK's `PaginatedResponse<T>`
`results` envelope this codebase already models. Confirm the actual envelope
against a live response before reusing the existing pagination helpers.

## DIBBS — `/api/dibbs/`

### `GET /api/dibbs/rfqs/` and `GET /api/dibbs/rfqs/{uuid}/`

List fields: `uuid`, `solicitation`, `purchase_request`, `nsn`, `part_number`,
`nomenclature`, `quantity`, `unit_of_issue`, `set_aside`, `status_code`,
`return_by_date`, `issue_date`, `is_open`, `document_url`.
Detail adds: `solicitation_formatted`, `organization(*)`.

Filters: `nsn`, `part_number`, `solicitation`, `organization`, `search`, `open`,
`purchase_request`, `set_aside`, `status_code`, `quantity_min`, `quantity_max`,
`return_by_date_after/before`, `issue_date_after/before`.

### `GET /api/dibbs/rfps/` and `GET /api/dibbs/rfps/{uuid}/`

List fields: `uuid`, `solicitation`, `nsn`, `part_number`, `nomenclature`,
`buyer_code`, `issued_date`, `closes_date`, `is_open`, `document_url`,
`tech_docs_url`. Detail adds: `organization(*)`.

Filters: `nsn`, `part_number`, `solicitation`, `organization`, `search`, `open`,
`buyer_code`, `issued_date_after/before`, `closes_date_after/before`.

### `GET /api/dibbs/awards/` and `GET /api/dibbs/awards/{uuid}/`

List fields: `uuid`, `award_number`, `delivery_order_number`,
`delivery_order_counter`, `nsn`, `part_number`, `purchase_request`,
`nomenclature`, `awardee_cage`, `total_contract_price`,
`total_contract_price_text`, `award_date`, `posted_date`,
`last_mod_posting_date`, `solicitation`,
`awardee(uei,cage_code,legal_business_name)`.
Detail adds: `awardee(*)`, `organization(*)`.

Filters: `nsn`, `part_number`, `solicitation`, `organization`, `search`,
`award_number`, `delivery_order_number`, `purchase_request`, `awardee_cage`,
`entity`, `award_date_after/before`, `posted_date_after/before`,
`total_contract_price_min/max`.

**P40 acceptance calls out two hazards that these fields make concrete:**

1. **Never sum `total_contract_price` across DIBBS rows.** Both a
   `total_contract_price` and a `total_contract_price_text` exist, and awards
   carry `delivery_order_number` + `delivery_order_counter` — line-item grain,
   not contract grain. Summing them double-counts by construction. The plan
   prohibits aggregation "unless the source defines a safe aggregation"; the
   documentation defines none.
2. **Award rows are informational and cannot be pursued.** They must not enter
   any pursuable-opportunity surface.

Line-item grain also drives the natural key: duplicate line items must stay
distinct. `uuid` is the obvious per-row identity; `(solicitation, nsn,
part_number, purchase_request)` is the business grain to preserve.

## SBIR/STTR — `/api/sbir/`

### `GET /api/sbir/topics/` and `GET /api/sbir/topics/{topic_id}/`

Fields: `topic_id`, `title`, `agency`, `year`, `topic_number`,
`solicitation_number`, `release_date`, `open_date`, `close_date`, `activity`,
`solicitation_status`, `topic_url`, `official_solicitation_url`.

Filters: `activity`, `agency`, `topic_number`, `solicitation_number`, `year`,
`doc_source`, `open_date_after/before`, `close_date_after/before`,
`release_date_after/before`, `search`.

### `GET /api/sbir/solicitations/` and `GET /api/sbir/solicitations/{solicitation_id}/`

Fields: `solicitation_id`, `solicitation_number`, `title`, `program`,
`cycle_name`, `year`, `start_date`, `end_date`, `out_of_cycle`, `activity`,
`solicitation_status`, `sol_download_url`.

Filters: `activity`, `program`, `solicitation_number`, `cycle_name`,
`solicitation_status`, `out_of_cycle`, `year`, `start_date_after/before`,
`end_date_after/before`.

Note `topics` and `solicitations` use **different identifier fields**
(`topic_id` vs `solicitation_id`), neither of which is `uuid` — unlike DIBBS.
Do not assume a shared identity column across these three APIs.

`program` on solicitations is what distinguishes SBIR from STTR; P42/P43 cover
both, so treat it as a discriminator rather than a filter to hardcode.

## Fixtures

Everything above is transcribed from the published documentation. Field *names*
are documented; field *types*, null semantics and date formats are **not**, and
P40's acceptance explicitly requires "quantity/unit/money null semantics pass."
Capture a real response into fixtures before trusting any inferred type, and
treat every mapper written against this document as provisional until one live
response has confirmed the shape.

**How much has actually been observed differs by dataset, and the difference
matters.** An earlier version of this section said flatly that no call had been
made; that stopped being true for DIBBS on 2026-08-08.

| Dataset | Live calls | What that established |
|---|---|---|
| `/api/dibbs/` | Entitlement probe (2026-08-08, D-65) **+ a 5-record-per-endpoint content capture (2026-08-09, D-71)** | Entitlement, envelope, **and now real field types, null semantics and date formats** — see Findings below. |
| `/api/sbir/` | Entitlement probe (2026-08-09) **+ a 5-record-per-endpoint content capture (2026-08-09, D-71)**, both first-ever | Same as DIBBS. This dataset had **never been called at all** before 2026-08-09. |

Both rows moved the same way: an entitlement probe answered "can we reach it,"
then a separate **contract-capture** run (`scripts/diag-tango-contract-capture.ts`,
operator-only per plan §4.6) fetched five real records per endpoint and recorded
their actual shape. See decision-log D-71 for the full account, and
`apps/api/src/external/tango/__fixtures__/real-captures/*-contract-capture-2026-08-09.json`
for the verbatim captures — both mapper spec files now run every record in
those fixtures through the real mappers.

**What this validation does NOT claim.** Five records is not exhaustive: no
observed value approached DIBBS's NUMERIC(18,4)/(18,2) ceiling, no RFQ detail
endpoint was called (only list), and a five-record sample cannot rule out a
rare field combination. Treat this as "the common shape is confirmed," not "every
edge case is covered."

## Findings from the 2026-08-09 capture

Two of the automated capture's five flags were **false positives in the capture
tool itself**, not contract gaps — recorded here so the correction is not lost:
`solicitation_formatted` reported "missing" because the tool's field list
incorrectly included a field this very document already marks
"Detail adds" (i.e. list-endpoint absence is the CORRECT behaviour), and
`total_contract_price_text` reported "undocumented" because the tool's list
omitted a field this document already lists on line 82-83. Both fixed in the
capture script.

The findings that are real, none of which required a code change — every one
was already handled correctly by existing coercions:

1. **`delivery_order_counter` arrives as a STRING** (`"53883"`), not a JSON
   number, despite backing an `INTEGER` column. `int()` already coerces a
   numeric string via `Number()`, so this was a confirmation, not a bug — but
   it is now pinned as a fixture-based regression test specifically so nobody
   "simplifies" `int()` into a bare type check and silently starts dropping
   every real delivery-order counter this provider sends.
2. **`total_contract_price` and RFQ `quantity` arrive as native JSON numbers**,
   never as the exact-digit strings `decimalString()`'s own doc comment is
   written to protect. That protection is real for a string input; nothing in
   this capture exercised it, because the provider's own JSON encoder had
   already round-tripped the value through a float before this code saw it.
   Nothing downstream of a JSON parse can recover a digit the provider's own
   encoder already lost — recorded, not fixed.
3. **`sol_download_url` (SBIR cycles) arrives as an empty string `""`**, never
   null, when the provider has none. `str()` already collapses `''` to `null`;
   without that, a card would render `<a href="">Download</a>` — a link to
   nowhere that still looks like a working one.
4. **`solicitation_status` is NOT one vocabulary shared between the two SBIR
   endpoints.** Topics report `"Open"` (title case, `26.BZ`'s five topics all
   agreed); solicitations/cycles report `"active"` / `"archived"` (lower case).
   `isTopicClosed()` in `sbir-relevance.ts` already lowercases before
   comparing against `{closed, archived, expired}`, so it is robust to either
   spelling, and `"archived"` being a real value in the wild confirms that word
   belonged in the closed-set rather than being a guess. But the two fields
   sharing a name across endpoints does **not** mean they share a value set —
   a future comparison against a cycle's own status must not assume "Open"/
   "Closed" casing.
5. **Neither `topic_id` nor `solicitation_id` is a uuid** — confirmed, not
   assumed (`sbir-topic-f98a90b4...`, `dsip-solicitation-7c695157...`). This
   is exactly what every "never reach for `uuid`" comment in the SBIR mapper
   and client was written to anticipate.
6. **`document_url` was null on all 5 captured RFPs, populated on all 5
   captured RFQs.** Consistent with RFPs carrying their document under
   `tech_docs_url` instead — five records cannot prove this is never
   populated, so the mapper still reads it unconditionally for both.
7. **No envelope mismatch on any of the five endpoints.** Every response was
   `count`/`next`/`results`-shaped. First confirmation of the SBIR envelope
   against a real response; the DIBBS envelope had already been confirmed by
   P17's probe.
8. **Every date field observed was a bare `YYYY-MM-DD` string**, on both
   datasets, across all five endpoints — the exact branch `dateOnly()`'s
   date-only regex was written for.
