# Business Development Phase 5 — Alert Language and Evidence Rules

Status: implementation-aligned copy contract for deterministic alerts and the Meri read tool.

## Universal rules

1. Alert facts come only from an already-ingested canonical projection row. The evaluator never refreshes a provider.
2. Event, effective, publication, and first-observed timestamps are separate fields. “First observed” is Capiro arrival, not proof that the event just occurred.
3. Every amount is labeled by its actual source meaning. An obligated amount is not a ceiling, outlay, company revenue, or cumulative contract value.
4. `implication` is deterministic interpretation and is always presented as inference. It must preserve conditional/thematic wording.
5. A source record ID and exact public/provider URL are evidence. Tenant notes, conflict reasons, baseline JSON, raw provider payloads, dedupe keys, and internal row IDs are not user copy.
6. Backfill is older information newly found by the projection, not breaking news, and is not delivered by default.
7. An unavailable or incomplete source never becomes “no activity” or “no lobbying.”

## Federal award / assistance

Safe facts include the exact recipient UEI match, source record identity, agency, source-defined amount, and labeled dates. A safe material update says that the stored source record now shows a value and identifies the prior value. It does not call the row a published contract modification unless the existing projection proves that meaning.

Unsafe claims include:

- “just won” when the action/publication date may be old;
- “worth X to the company” when X is an action obligation or assistance obligated amount;
- treating a deobligation, outlay, ceiling, and obligation as interchangeable;
- attributing a parent/subsidiary record without a confirmed identity anchor.

Example safe implication: “The existing USAspending record for the exact UEI changed in material fields. Review the linked source to determine whether this affects the firm’s opportunity hypothesis.”

## SAM opportunity

The MVP relationship is an agency exposure inferred from exact-UEI award history. Alert facts may state the notice title/type, agency/office, set-aside, NAICS/PSC, posted date, response deadline, archive date, and exact SAM link.

The implication must state that the notice is thematically related and does not indicate that the prospect plans to bid or will win. It must not call Sources Sought or Presolicitation an RFP, and it must not describe an opportunity as open solely because `active` is true when its response deadline has passed.

## Tango entity snapshot

The link is exact because the active entity snapshot’s external ID is the confirmed UEI. Copy may report a change to allowlisted normalized entity facts and must link to the existing provider/source URL. A content-hash or mapper/version refresh with identical material meaning produces no alert.

## LDA filing

LDA does not supply the company UEI. A candidate is retained only after exact normalized comparison to a confirmed canonical name or alias, and the implication says that the filing matched by exact confirmed organization name but should be reviewed as a name-based link.

Copy keeps `dtPosted` (publication) separate from filing year/period. A safe summary may say that a filing covering a prior period was published on the recorded date. It must not say that the company “just registered to lobby,” claim absence from a bounded miss, or present period income/expenses as current-week activity.

## Correction and backfill

A meaningful correction is a new append-only alert describing the source’s new facts; the prior alert is not edited. Backfill uses the source’s actual dates and is suppressed from delivery by default. Neither case may say “we fixed an error” unless Capiro itself—not the source—actually corrected product data.

## Ambiguity and source health

An ambiguous identity produces review/partial with no confident alert and no baseline advance. A partial page, malformed observation, or missing exact locator likewise produces no delivery.

Safe health copy: “This source check is incomplete. The last complete comparison remains <time>. Existing alerts remain available.”

Unsafe health copy: “No new activity” when the source is stale, incomplete, unavailable, or outside its normal ingestion cadence.

## Notification and Meri presentation

The prospect alert panel and existing bell show the company, title/summary, materiality text, labeled dates, and an explicit external source link. The bell orders Business Development items by first-observed time so an old event discovered today is not silently buried, while the event/publication labels still disclose its age.

`get_business_development_recent_changes` repeats the stored facts and changed fields and wraps implication as `{ text, inference: true, note }`. It never marks an alert read, writes a brief, sends outreach, or treats a thematic opportunity as proof of bid/win intent.

Acquisition revision copy is intentionally absent from the MVP because exact prospect linkage is not yet proven from the existing ledger.
