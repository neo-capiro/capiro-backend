# Meri local dispatch extraction audit, 2026-10-12

The next coherent slice is a finite, service-owned local dispatch seam for the
existing `executeScoped` cases. The audit identifies 134 unique literal cases,
exactly matching the shared capability registry's `backend: 'meri'` projection.
Five `federal_market` capabilities remain owned by the governed proxy. No tool,
schema, classification, handler, owner, capability or side effect is added or
retired. Implementation remains blocked on parent retirement/path coordination.

The isolated audit worktree is based on published PR2412
`6a4b48e6286a270ab18c033eb4ccaf6f72f42c70`, tree
`f14d6fa3f191645839414972063e1057fce557bf`. All audit changes are confined to this
packet. The canonical source, separate reporting work, other candidates and
original failure artifacts are preserved.

## Bounded proposal

Replace only the switch's dispatch machinery with a closed local handler table
and a tiny typed invocation helper. The class continues to supply closures over
its existing private handlers and owner ports. Callbacks receive this call's
exact `ctx`, `input` and optional `execution`; they never obtain authority from
the table. The helper has no Nest dependency, persistence, provider, transport,
rollout logic, capability descriptions or read/write policy. It must not become
a second capability catalog or the separate shared read-capability registry.

The handler table must be exhaustive against the canonical core name type and
immutable for invocation. Lookup must reject inherited names (`__proto__`,
`constructor`, `toString`) with the existing raw unknown behavior. Plain
`table[name]` without an own-key check is unsafe. There is no generic fallback,
dynamic handler registration, provider-selected backend or registry-owned
authorization. Keep grouped delegates as exact closures, including the Research
Portfolio current-use wrapper. Do not bind private methods without the owning
receiver. The exact method/argument bodies in `evidence/dispatch-map.json` are the
review oracle, not a new runtime catalog.

Prefer construction at the call boundary or a stateless factory, with no
constructor-created cache prerequisite: existing tests use
`Object.create(MeriToolsService.prototype)` and fake ports, and optional owners
must remain lazy. A field initializer containing bound methods would silently
change that behavior. Do not capture per-call actor/input/proposal state in a
service-wide cached closure or capture a replaced fake/optional owner eagerly.
The final implementation shape needs separate review; this packet does not
claim that a table already exists or passes equivalence.

## Behavior that the seam must preserve

| Boundary | Frozen behavior |
| --- | --- |
| Public raw authenticated wrapper | Non-async `executeFromAuthenticatedUser` checks request activity, trims canonical core names, validates writes or applies `objectInput`, then calls `execute`. Activity/normalization/parser failures are synchronous here. |
| Raw execute | Async `execute` delegates to async `executeScoped`. The latter checks activity before name dispatch and starts a synchronous owner callback before its first await. Rejections and result/promise adoption keep their identity. |
| Unknown name | Raw typed execute at runtime rejects with `Error('Unhandled Meri tool: ...')`; authenticated unknown names throw `NotFoundException('Meri tool not found')`. Neither path offers an alias/fallback. |
| Names/aliases | `normalizeToolName` trims canonical names only. No tool-name alias map exists in this owner; similarly described legacy capabilities remain their own names. Input/output compatibility stays in existing handlers. |
| Receipt argument | Only `send_email`, `create_word` and `schedule_task` pass `execution?.actionProposalId`. Reply, Excel, PowerPoint and other cases must not gain it. |
| Argument differences | Many handlers receive `input` only; `list_global_datasets` receives none; `list_scheduled_tasks` receives `ctx`; `get_pe_budget_timeline` receives `(input, ctx)`. External helper/owner arguments are recorded verbatim. |
| Word and optional districts | Word validates `docx/pdf/txt` before its owner, with absent format selecting `docx`. Optional district calls preserve nullish fallback `{available:false,reason:'feature_disabled'}`. |
| Funding adapters | Existing dispatch performs exact `String`, optional casts and bounded array shaping; `toolActor` narrows identity to tenant/user/role. Flag, role, wall decisions remain in the adapter, in that order. |
| Research Portfolio | All 19 cases use `executeMeriResearchPortfolioToolAtCurrentUse` and its lazy `execute` closure. Current conversation/grant checks and final scope re-read remain owned there before the optional owner is required. |
| LegiWatch and business development | Twelve names retain existing LegiWatch owner delegation. Six names retain lazy business-development owner delegation. No duplicate scope gate or provider path is introduced. |
| Governed proxy | DI exposes the proxy, which keeps federal-market routing, chart tenant+current-user preflight and governed-memory presentation. Arguments including optional execution are forwarded to raw methods. Ordinary failures propagate. |
| Request control | Existing AsyncLocalStorage scope is cooperative dispatch cancellation; it does not roll back already-started work. No guard relocation, extra await, retries or transaction claims enter the seam. |

## Evidence and limits

`evidence/audit-dispatch.cjs` parses source with cached TypeScript, loads no
production module, proves case/owner equality and records exact arguments,
groups, source lines and SHA-256/Git blobs for 23 source/evidence inputs. Its
inventory passes with 134 core cases, five proxy-owned entries and no duplicates,
missing or extra cases. All 23 audited blobs equal the frozen base.

`evidence/characterize-baseline.cjs` transpiles only the exact frozen dispatch
body and pure `toolActor`/`assertNever` helpers into an inert VM with fake ports.
293 baseline characterizations pass: every case with active/inactive fake
request control, and 25 special argument/format/unknown/error/timing checks.
This executes no actual owner, service graph, DB, provider or model. A fake
current-use wrapper proves placement/laziness only, not current authorization
acceptance. The first harness lacked expected `name` argument qualification for
LegiWatch; its exact initial script and failure JSON remain. The corrected
harness adds that expectation without modifying source. The initial exploratory
read of an incorrect transport filename also remains recorded.

The inherited catalog count failure is genuine and unchanged: expected 138,
actual 139, reproduced in the retained main baseline receipt. Its original
classification and raw command/test result hashes are linked in this packet.
No count assertion, catalog or test is fixed, weakened or removed here. Do not
count these new oracle checks as a repair of that failure or as existing test
suite acceptance.

Independent inspection found that the registration test's advertised-name loop
uses a catch-all Proxy which replaces `executeScoped` itself
(`meri-tools.registration.spec.ts:770–790`). It can pass without entering the
switch. Retain that existing test, but require the frozen actual switch and leaf
port stubs for the proposed extraction's differential proof. The independent
consumer/authority findings are in `INDEPENDENT-AUDIT.md`.

No application extraction, production test import/evaluation, provider call,
message/upload/model execution, customer mutation, credentials/permissions,
AWS/security/network operation, DB/migration/native Prisma execution or download,
main merge, deployment, frontend or retirement change occurred. Configured
Node22/pnpm9.12 generation, real PostgreSQL/RLS/MVCC/concurrency and full
Cleanup/Wave gates remain open. This cached Node24/TypeScript source-only audit
cannot qualify them.
