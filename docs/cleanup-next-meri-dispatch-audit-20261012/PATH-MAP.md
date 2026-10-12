# Proposed path and dependency ownership

This is a read-only audit proposal. Parent retirement coordination has not yet
returned, so no carrier/application edits are authorized by this packet.

| Path | Owner / permitted action after coordination | Dependency / preservation requirement |
| --- | --- | --- |
| `docs/cleanup-next-meri-dispatch-audit-20261012/**` | This worker's audit packet only | Disjoint from all other packets; append raw failures and curated evidence. |
| `apps/api/src/meri/meri-tools.service.ts` | Proposed Meri local dispatch owner | Change only the dispatch seam; preserve constructor positions, every handler, wrapper, schema, classification and exported tool projection. |
| NEW `apps/api/src/meri/meri-local-dispatch.ts` | Proposed stateless typed helper/facade | Local finite core dispatch only; no catalog, authority, provider, persistence, policy or new Nest service. Final basename may be coordinated before edits. |
| NEW `apps/api/src/meri/meri-local-dispatch.equivalence.spec.ts` | Proposed dispatch equivalence tests | Independent baseline/candidate traces, fake terminal ports, no network/DB/service graph. Original regression names and bodies stay intact. |
| `apps/api/src/meri/governed-meri-tools.proxy.ts` and `.spec.ts`, chart scope spec | Existing governed owner; read-only dependency | Chart ownership, memory signals, federal routing and full argument forwarding unchanged. |
| `apps/api/src/meri/meri.module.ts` | Existing DI owner; read-only dependency | RAW token stays private to provider wiring; consumers continue to inject governed `MeriToolsService`. No module/provider edit needed. |
| `packages/shared/src/index.ts` registry and projections | Existing capability owner; read-only dependency | Canonical names/backends/readOnly/surfaces/schema projection authority remains here; 134 core plus five federal entries. No duplicate catalog. |
| `apps/api/src/meri/meri-rp-tool-transport.ts` | Existing current-use owner; read-only dependency | Lazy callback after fresh conversation and grant authority; final scope reread remains. |
| `apps/api/src/meri/meri-tool-request-control.ts`, core execution control | Root guard ownership; read-only dependency | Keep AsyncLocalStorage and activity boundary; no new guard/data/CI/package edits from this worker. |
| `meri.service.ts`, `meri-research.service.ts`, `meri.controller.ts` | Existing execution consumers; read-only dependency | Read-only filters, context pinning and execution-control scopes remain before governed dispatch. |
| `meri-action-proposal.service.ts`, `meri-research-replay-authorization.ts` | Existing approval/replay owners; read-only dependency | Current approval/scope/replay checks and original proposal ID forwarded before canonical owner execution. |
| `meri-v3-visual-analysis.service.ts` | Existing analysis consumer; read-only dependency | Its authenticated `run_analysis` execution and client constraints remain. |
| `apps/api/src/capabilities/**` | Separate read-capability registry; read-only comparison | It rejects writes and normalizes errors/timeouts. Do not transplant its protocol into Meri local dispatch. |
| Existing Meri/federal/opportunity/prospect/portfolio tests | Existing regression owners; read-only dependency | Retain test names, bodies, expected failures and schema/authority coverage; separate permission needed for any equivalent structural assertion update. |
| `apps/meriv2-orchestrator/src/meri/full-chat-read-tools.catalog*` | Existing catalog owner; read-only dependency | Preserve genuine expected138/actual139 baseline failure and original receipts. No drift/count repair in this slice. |
| Frontend, docs retirement, dead-code retirement, Engagement reporting branch/task | Excluded work | No inspection of reporting work or changes/retirement; canonical imports/stubs are sufficient for this audit. |

The finite case-to-call source map is `evidence/DISPATCH-MAP.md`; exact raw
arguments and grouped bodies are `evidence/dispatch-map.json`. Source provenance
is `evidence/source-manifest.json`. There are no route/DTO/schema/migration,
frontend contract or deployment dependencies added by the proposed extraction.
