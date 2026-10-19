# Core second-package producer context source

Source prepared against Meri PR 189 at `231122607ff16c67a8fe19f8e945b2f8776431ae` and the combined Core roster/identity source at `138c04373b18bb730b1ad0f8f9338342f628b8c6`. This is a source handoff, not a runtime admission or deployment record.

## Exact private transport

The three operations below reuse the existing `x-meri-read-observation` carrier. Core checks the verified service identity, exact operation ID and version `0.2.0`, SHA-256 of the canonical original flat request body, and closed context keys. For these three operations Core additionally requires the request's already admitted Option B tool marker, current tenant and actor, and exact origin-form `POST /api/clio/tools/<operation>` target before reading the context. The signed read-token middleware validates the original raw body and run-bound grant separately. A carrier is a calculation input, never a principal, grant, selector, or policy switch.

| Operation | Closed context | Core producer consumption |
| --- | --- | --- |
| `get_certification_status` | `comparisonLocale` | One canonical, ICU-supported locale for query, product ID, CSO name and CSP name comparisons. Exact-ID priority, cap and miss provenance remain unchanged. |
| `get_state_rule_status` | `stageAsOf`, `commentAsOf` | Separate canonical millisecond UTC instants for lifecycle stage and comment-open evaluation on exact-ID and keyword paths. Generated-at behavior remains unchanged. |
| `search_sam_opportunities` | `asOf`, `sourceStatusAsOf`, `sourceHealthAsOf`, `evidenceAccuracyMode` | Separate canonical instants for response/deadline, 48-hour source-status threshold, and source-health age. Core re-reads the tenant's actual chat evidence mode before and after awaited owner reads and refuses drift. The carrier cannot select Core policy. |

The existing no-header producer paths keep their ambient clock and locale behavior. Source-health projection retains its existing distinctions among degraded, unknown and never-synced rows. In particular, a `never_synced` row with a null record count still has an unknown source status under the existing precedence; this source change does not reclassify it.

## Release gates

The three names remain absent from `MERI_DELEGATED_READ_TOOLS`. Core therefore cannot execute these as Option B reads yet. The current source proves deterministic producer calculations and private carrier validation, not client-scoped corpus authority or an admitted runtime path. Before opening that allowlist, Core and Meri owners need the exact original grant/selector qualification, same-byte carrier validation through delegated HTTP, canonical source authority and visibility checks, and deployment/readback. No roster, history-release, first-chat, memory, grant, migration, or live infrastructure change is part of this branch.

Focused tests cover carrier rejection, service identity, target binding, locale folding, both rule clocks, all three SAM clocks, policy drift and legacy behavior. See the branch commit for exact test results and source pin.
