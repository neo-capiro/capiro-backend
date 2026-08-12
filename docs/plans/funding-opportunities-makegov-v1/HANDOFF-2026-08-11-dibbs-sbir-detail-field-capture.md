# DIBBS detail-endpoint field capture — does `organization`/`awardee` carry a POC or address?

## Why this exists

A conversation about what else this data could feed (AI grounding, proposal
intelligence, DOW Directory personnel enrichment, District Nexus district-level spend
mapping) landed on one open, cheaply-answerable question: **does DIBBS actually publish
a named point of contact or an address/place-of-performance anywhere, and if so, on
which field?** This has never been checked. Answering it settles whether DOW
Directory/District Nexus integration is worth scoping at all, or a dead end as
documented.

## What's already known — from `dibbs-sbir-rest-contract.md`, transcribed from published docs, never detail-verified

| Endpoint | List-level fields | Detail-only additions |
|---|---|---|
| `dibbs/rfqs/{uuid}/` | nsn, quantity, solicitation, dates, `is_open`, … | `solicitation_formatted`, **`organization(*)`** |
| `dibbs/rfps/{uuid}/` | same shape, plus `buyer_code` (a code, not a name) | **`organization(*)`** |
| `dibbs/awards/{uuid}/` | `awardee(uei, cage_code, legal_business_name)` already on the LIST level | **`awardee(*)`**, **`organization(*)`** |
| `sbir/topics/`, `sbir/solicitations/` | title, agency (plain string), dates, status, URLs | *(no detail endpoint documented for either — confirm this too; §108–135 of the contract doc lists no `{topic_id}/` or `{solicitation_id}/` detail expansion beyond what list already returns)* |

**`organization(*)` and `awardee(*)` are the two unknowns.** The `(*)` notation in the
contract doc means "everything this object contains," transcribed from documentation
that doesn't enumerate the sub-fields. **No live call has ever been made to any DIBBS
detail endpoint** — D-71's contract-capture run (`diag-tango-contract-capture.ts`,
2026-08-09) only exercised the three LIST endpoints (`listRfqs`, `listRfps`,
`listAwards`, 5 records each), confirmed by reading the script directly (it calls
`captureOne('dibbs/rfqs', () => dibbs.listRfqs(...))` and nothing shaped like
`getRfq(uuid)`).

Why the awardee identity fields already visible matter regardless of what's in
`awardee(*)`: `uei`/`cage_code` on DIBBS awards are the SAME kind of identity key this
program already joins on elsewhere — D-34 established that `Client.uei` and a Tango
resource's `external_id` are literally the same value for the same entity, with no link
table needed. **If District Nexus (or anything else) already resolves a UEI to a
congressional district**, DIBBS award data could plug into that via `awardee.uei` alone
— no address field from DIBBS required. Confirm this by checking whatever table backs
District Nexus's district resolution today, independent of this capture work.

## How to check safely — do not burn requests carelessly

**This session found a real, external, account-wide rate limit that took most of a day
to clear once and came back bigger the second time (decision-log D-76, D-77).** A
detail capture only needs a HANDFUL of requests — do not build anything that loops over
many records "just to be thorough." Two or three real detail calls per dataset settles
the field-existence question completely; it does not need statistical coverage.

1. **Reuse real UUIDs already sitting in the database** — no new list call needed to
   get a UUID to test against:

   ```sql
   SELECT tango_dibbs_id, document_type, solicitation FROM tango_dibbs_solicitation
   WHERE document_type = 'rfq' ORDER BY created_at DESC LIMIT 2;
   -- tango_dibbs_award has 20 bounded-test rows from before this session; pull one from there too
   SELECT tango_dibbs_id, award_number FROM tango_dibbs_award LIMIT 2;
   ```

2. **Extend `diag-tango-contract-capture.ts` with detail calls, or write a small
   sibling script** — check whether `TangoDibbsGateway` (the injectable interface in
   `tango-dibbs.client.ts`) already exposes a `getRfq(uuid)`/`getAward(uuid)`-shaped
   method before assuming you need to add one; the header comment structure in
   `sync-tango-dibbs.ts` names `TangoDibbsPage`/`TangoDibbsGateway` as the types to
   check. If a detail method doesn't exist on the client yet, adding one needs the same
   discipline as everything else in `external/tango/` — real fixture-driven tests, no
   live call inside a `.spec.ts` (see D-28: a script's own test suite calling `main()`
   on import triggered a real, unrequested Tango call once already in this program;
   don't repeat it).

3. **Run it once, save the real response as a fixture**, same pattern as
   `apps/api/src/external/tango/__fixtures__/real-captures/` — a subdirectory,
   deliberately, because the sibling test in `tango.client.spec.ts` ("the fixtures are
   synthetic") requires every DIRECT child of `__fixtures__/` to be marked synthetic,
   and this public federal-procurement data has no tenant/secret reason to be marked
   that way. Put new detail captures in that same subdirectory, not at the top level.

4. **Read the raw JSON yourself before writing any mapper code.** The question this
   capture answers is binary — does `organization`/`awardee` contain a name, an
   address, a POC, or none of those — and the raw response answers it directly. Do not
   infer field semantics from field NAMES alone; this program has been burned twice
   already by trusting a plausible-sounding field name over an actual captured value
   (D-20's SDK field-name mismatches, D-35's `entity_structure`/`state_of_incorporation`
   naming-convention crash).

## What to do with the answer, either way

- **If a real POC name or address turns up:** write it into
  `dibbs-sbir-rest-contract.md`'s field tables (the doc's own convention already
  distinguishes "documented, never verified" from "confirmed against a real response" —
  follow that, don't just add the field silently). Then this becomes its own scoped
  follow-up for DOW Directory or District Nexus, NOT something to build as a side
  effect of this capture. Get an explicit decision on which one (or both) is worth the
  work before writing any integration code.
- **If nothing useful turns up (most likely for a named POC, given SBIR has no
  organization object of any kind and DIBBS's own list-level fields already lean
  code/identifier-based rather than name-based):** update the contract doc to say so
  explicitly, so a future reader doesn't re-ask this same question. The absence itself
  is worth recording — this doc's own existence is proof that "nobody checked" is a
  real, recurring cost in this program.

## Acceptance

- At least one real detail-endpoint response captured and saved as a fixture for
  `dibbs/rfqs/{uuid}/`, `dibbs/awards/{uuid}/`, and confirmation (or denial) that SBIR
  has any detail endpoint at all.
- `dibbs-sbir-rest-contract.md` updated with what `organization`/`awardee`'s expanded
  fields actually contain, moved from "undocumented `(*)`" to a real field list.
- A plain yes/no answer, in writing, on whether DOW Directory or District Nexus
  integration is worth scoping — not a maybe, and not silently built without that
  decision being made first.
