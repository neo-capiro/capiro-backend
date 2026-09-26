# `search_crs_reports` result envelope (dormant)

`envelopeCrsReportsResult` and `observeCrsReportsCall` are opt-in only. The
registered tool, authenticated handler, dispatch, and model-facing legacy
response remain unchanged. The observer runs after a successful legacy call,
returns the exact same payload object, and cannot replace a thrown error or
turn its own synchronous or asynchronous failure into a tool failure. A pending
observer also cannot delay that legacy response.

The handler searches Capiro's global `crs_report` table using `active: true`.
Its optional query is applied across title, summary, topics, and authors; the
page limit is clamped to 1–50 (default 20). The table has no tenant or client
fields, so this read has no client-wall filter to infer or report. The normal
delegated route still requires authenticated standard-user context and retains
its existing service-secret guard behavior. A malformed query type leaves the
requested filter unverified in this observation.

The handler reads its page and `total` count in separate system transactions.
The envelope identifies only well-formed, distinct returned local report IDs.
It keeps result-set completeness and matched count unknown, even when both
page and count are zero; an empty local query does not establish that no CRS
report exists or matches upstream. A full page or a separately reported larger
count is a possible local cap, not a proven continuation. A count below the
returned page is marked inconsistent; simultaneous URL and count faults retain
both error codes. The handler also shortens display title
and summary, so a string ending in `...` at the display limit signals possible
text truncation rather than evidence that the source text was fully returned.

The only URL promoted into provenance is an HTTPS URL whose parsed origin is
exactly `https://crsreports.congress.gov`, with no credentials or non-default
port. This checks syntax and origin, not current availability or document
authenticity. Other URLs remain in the unchanged legacy payload but are not
provenance. The schema has `syncedAt`, but the handler does not return it;
publication `date` and response `generatedAt` do not establish source freshness.
The envelope therefore leaves `observedAt` null and supplies no source version.

The focused adversarial spec is authored but unrun under the current resource
hold. It covers scope and limit parsing, empty and capped pages, count/page
disagreement, malformed or duplicate rows, hostile URLs, summarized text,
sync/async observer failure, a never-settling observer, and exact legacy
result/error identity. This package does
not qualify a model-visible envelope, upstream CRS coverage, source-sync
freshness, or deployed authorization behavior.
