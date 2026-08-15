# Portfolio module — API inventory

Milestone 0 deliverable for `PORTFOLIO-HANDOFF.md` §3. One row per endpoint the
Portfolio module (index + client CRM) reads or writes. Every path below was
followed to its server controller; the DTO/controller is the contract, not the
front-end's local type.

**Architecture note (verified, not assumed):** the vNext surface ships inside
`apps/web` (`apps/web/src/vnext/`). The runtime selects it with
`webSurface === 'vnext'` (see `apps/web/src/env.ts` → `isVNextSurface`,
`apps/web/src/vnext/app/presentation.ts`). The separate deployable is the
Fargate service `capiro-dev-web-vnext` (cluster `capiro-dev`, target group
`Capiro-WebVN-NF4THUBAPLB6`, port 8080, health `/healthz`) serving
`os.capiro.ai`. There is no `apps/web-next` package; the "parallel service" the
foundation document describes is the deployment target, not a code package.
`apps/web` builds and ships both surfaces from one bundle.

## Endpoint inventory

| Screen · element | Method | Path | Params | Response type | Client file | Server controller | Query key | Auth | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Index · client list | GET | `/api/clients` | — | `Client[]` | `lib/use-api.ts` | `clients.controller.ts` | `['clients']` | member | shared key with canonical workspace |
| Index · pulse band | GET | `/api/intelligence/portfolio-summary` | — | `{ activeClients, needAttention, ldaSpendQtd, billsTracked, activeRegulations }` | — | `intelligence.controller.ts:362` | — | member | closest existing aggregate; lacks meetings-this-week + active-strategies → GAP |
| Index · pulse · coming up | GET | `/api/intelligence/coming-up` | — | coming-up feed | — | `intelligence.controller.ts:356` | — | member | |
| Index · needs attention feed | GET | `/api/intelligence/portfolio-alerts` | `limit` | alerts[] | — | `intelligence.controller.ts:366` | — | member | |
| Index · program elements | GET | `/api/programs` (watched) | `watched, q, page, limit` | `{ data, total }` | `pages/clients/PortfolioProgramElementsSection.tsx` | `program-element/programs/programs.controller.ts:175` | `['program-element-finder','portfolio-watch']` | member | per-PE; **cross-client aggregation + net portfolio delta → GAP** |
| Index · Import with LDA · lookup | GET | `/api/firm/lda-registrants` | `q` | registrants[] | — | `intelligence/firm-onboarding.controller.ts:43` | — | member | |
| Index · Import with LDA · review | GET | `/api/firm/import-candidates` | — | candidates[] | — | `firm-onboarding.controller.ts:59` | — | member | propose→review step |
| Index · Import with LDA · apply | POST | `/api/firm/import` | `{ ldaClientIds: number[] }` (≤100) | import result | — | `firm-onboarding.controller.ts:64` | — | **user_admin** | explicit apply; backend exists (§7.1.1 not a gap) |
| Client shell · identity | GET | `/api/clients/:id` | — | `Client` | `vnext/pages/client-crm/VNextClientCrmRoute.tsx` | `clients.controller.ts` | `['client', id]` | member | |
| Client shell · health entry | GET | `/api/intelligence/clients/:id/setup-completeness` | — | completeness | — | `intelligence.controller.ts:337` | — | member | profile-gap count |
| Overview · health score | GET | `/api/intelligence/clients/:id/health-score` | — | health | — | `intelligence.controller.ts:331` | — | member | |
| Overview · opportunities summary | GET | `/api/funding-opportunities/clients/:id/opportunities/summary` | — | summary | — | `funding-opportunities.controller.ts:874` | — | member | |
| Relationships/Org · people | GET/POST/PATCH | `/api/clients/:id/people` `…/people/:pid` `…/people/:pid/hierarchy` | — | people[] | — | `clients.controller.ts` | — | member | hierarchy override persistence verified |
| Relationships/Gov · directory | GET | `/api/directory/contacts` `/api/directory/staffers` | — | directory | — | directory controller | — | member | |
| Relationships/History · activity | GET/POST/PATCH | `/api/clients/:id/activity` `…/activity/:aid` | — | activity[] | — | `clients/client-activity.controller.ts` | — | member | normalised feed |
| Work · strategies | GET | `/strategy-api/strategies` `…/strategies/:id` | — | `StrategyListItem[]` / `StrategyDetail` | `vnext/pages/client-crm/ClientCrmWork.tsx` | `api-strategy/src/strategy/strategy.controller.ts:38,48` | `['strategy','strategies']` | member | Work is a projection; no CRM task store |
| Work · node write | PATCH | `/strategy-api/strategies/:id/nodes/:nodeId` | — | node | — | `strategy.controller.ts:72` | — | member | bidirectional write path exists |
| Intelligence · changes | GET/PATCH | `/api/intelligence/changes` `…/changes/:id` | `since` | changes[] | — | `intelligence.controller.ts:284` | — | member | |
| Intelligence · meetings (next touch) | GET/POST | `/api/engagement/meetings` | — | meetings[] | — | `engagement/engagement.controller.ts:1684` | — | member | next scheduled client-facing event |
| Files · attachments | GET/POST | `/api/engagement/attachments` `…/upload-url` `…/confirm` `…/:id` | — | attachments[] | — | `engagement.controller.ts:2379` | — | member | smart refs, no byte duplication |
| Files · move | PATCH | `/api/clients/:id/files/:fid/folder` | — | — | — | `clients.controller.ts` | — | member | re-parents reference only |
| Capabilities (preserved) | GET/POST/PATCH | `/api/clients/:id/capabilities` `…/capabilities/:cid` | — | capabilities[] | `pages/clients/ClientProfilePage.tsx` | `clients.controller.ts` | — | member | legacy entry point kept reachable (§9.3) |
| Fill with Meri · latest | GET | `/api/clients/:id/fill-with-meri/latest` | — | run | `vnext/pages/client-crm/ClientFillWithMeriDrawer.tsx` | clients fill-with-meri controller | — | member | propose |
| Fill with Meri · runs | GET/POST | `/api/clients/:id/fill-with-meri/runs` `…/runs/:runId` | — | runs | — | — | — | member | diff |
| Fill with Meri · apply | POST | `/api/clients/:id/fill-with-meri/runs/:runId/apply` | — | — | — | — | — | member | **explicit apply only** (§10) |
| Fill with Meri · findings | POST | `/api/clients/:id/fill-with-meri/findings/:fid/reject` `…/restore` | — | — | — | — | — | member | |
| Session | GET | `/api/me` | — | me | `lib/use-api.ts` | users controller | `['me']` | member | surface gate + tenant |

## Functional inventory (router → vNext status)

| Existing route | Purpose | vNext status | Module doc |
| --- | --- | --- | --- |
| `/` | Command dashboard | rebuilt (`DashboardVNext`) | HANDOFF.md §6 |
| `/clients` (no `clientId`) | client list | **rebuilt as Portfolio index** (this task) | PORTFOLIO §7.1 |
| `/clients?clientId=:id` | client CRM | rebuilt (`ClientCrmPage`, 5 tabs) | PORTFOLIO §7.2–7.9 |
| `/strategies` | strategies | rebuilt (`VNextStrategiesRoutes`) | — |
| `/legiwatch` | LegiWatch | rebuilt (`VNextLegiWatchPage`) | — |
| `/directory` | congressional staff | rebuilt | — |
| everything else | settings, explorer, reviews, etc. | not in scope (canonical surface) | FOUNDATION §6 |

## Gaps confirmed during inventory (see `GAPS.md`)

- **G1** — Pulse band needs `meetingsThisWeek` + `activeStrategies`; `portfolio-summary` lacks both. Non-blocking (compose from `coming-up` + `strategies`).
- **G2** — Program elements cross-client aggregation + net portfolio delta not present (per-PE watch list only). §7.1.2.
- **G3** — Per-client attention/readiness/next-touch columns on the index risk N+1; needs a portfolio-scoped aggregate or shipped without those columns. §7.1.
