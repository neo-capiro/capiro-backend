# Dormant CBO cost-estimate result observation

`envelopeCboCostEstimatesResult` observes the existing `search_cbo_cost_estimates` result without changing active dispatch or the model-visible legacy payload. It checks tool identity, returned count, bounded filters, row shape, and syntactic HTTPS `cbo.gov` URLs before describing the local Capiro table read as available. URL validation does not establish that a linked publication exists or is current. Observation failure leaves coverage unknown; the wrapper preserves the exact legacy result or error.

The handler reads at most 25 rows from the local table and does not count all matches or expose a cursor. A short verified page therefore completes only that local query; a full page is partial with an unknown total. An empty verified result means no record **within the queried local table**, not that the Congressional Budget Office has never published an estimate. `observedAt` remains unknown, and the envelope makes no upstream freshness or ingest-completeness claim.

Focused specs were authored but not executed under the user-directed machine resource hold. This dormant observer is not wired into active Meri routing. Exact-HEAD tests, typechecks, and live QA remain acceptance gates.
