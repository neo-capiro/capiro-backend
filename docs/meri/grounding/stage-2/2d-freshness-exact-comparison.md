# Stage 2d: freshness and exact comparison

Stage 2d adds deterministic metadata and checks. It does not change a live answer path by itself. S2-A may use the results to identify retrieval requirements; S2-C may use them before asking Jev and route a promoted claim to bounded repair. Jev judges prose support, never exact values.

## Date semantics

| Field | Meaning | Examples |
| --- | --- | --- |
| `publishedAt` | When the source was published or observed as a publication | budget `source.observedAt`, publication/posted date |
| `effectiveAt` | When the event/status became effective | award signed/latest action, rule effective/status date |
| `retrievedAt` | When Capiro retrieved or synchronized it | citation/document `observedAt`, `lastSyncAt`, `generatedAt`, tool `asOf` |
| `asOf` | Legacy source/claim date retained for compatibility | envelope `sourceDate` fallback |

`deriveEvidenceDates` is allow-list based. It never infers a date from an unknown field: unknown values remain `null` with basis `none`. Fiscal-year semantics remain in funding-stage fields rather than being converted into an invented effective date.

## Freshness policy

The constants are provisional and centralized: status statements have a 90-day maximum age; a retrieval observation has a 7-day current-attempt window. A recent retrieval proves an attempt, not that an old statement remains true, so it cannot override a stale publication/effective date.

| Topic | Rule |
| --- | --- |
| Enactment, votes, report language, grant awards | Durable; age does not invalidate the historical event |
| Bill/regulatory/role/operational status | Stale after 90 days; retrieval-only evidence remains unknown within 7 days |
| Opportunity/deadline claims | Stale after the normalized deadline passes |
| Budget amounts/deltas | Age is reported; a later funding stage determines staleness through exact comparison |
| General dated evidence | Apply the requirement freshness class; unknown dates remain unknown |

## Exact comparison

`extractExactValues` normalizes dollar amounts and K/M/B units, ISO and month-name dates, fiscal years, shared funding-stage labels, bill identifiers, and PE identifiers. Amount evidence is rounded to the claim's stated precision before comparison. Stage labels normalize to the shared funding stage key. A House/Senate comparison is complete only when evidence contains a figure for each chamber.

`evaluateClaimDeterministically` combines exact comparison, chamber completeness, and freshness. Exact mismatch becomes a contradiction requirement, absence becomes missing evidence, and stale evidence becomes `stale_status`, whose read-only remedy is `refresh_status` with a current-status route. These deterministic outcomes precede Jev and remain claim-local.
