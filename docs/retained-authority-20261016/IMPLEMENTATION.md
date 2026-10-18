# Retained authority source handoff

This separate source increment implements current native/resource corroboration, all three fixed retained-read issuer/data paths, and private Core/Intel authority plumbing. It remains unmounted and unconfigured: no live issuer, key, audience, workload trust, provider connection or route activation follows from these files.

The baseline is independently accepted membership [PR33](https://github.com/neo-capiro/capiro-backend/pull/33), commit `68da33ac6ad9264c60d867dbaed41c1b8fdcf08f`, tree `a5f2993e92c4573692ca3c4fa3f948452f70e3ec`. Its 71/71 synthetic proof covers membership only. It does not qualify the new retained authority source. Frozen shipping `cd3c51e940f14e1b2a1040b0ffa445e85d68b332` is unchanged.

## Source connections

| Boundary | Actual source and behavior |
| --- | --- |
| Fresh Core native authority | [tenant-context.middleware.ts](../../apps/api/src/tenant/tenant-context.middleware.ts) captures genuine request-local provenance and rechecks a fresh online Clerk session plus the existing current user/member/impersonation owner. [retained-native-authority.ts](../../apps/api/src/auth/retained-native-authority.ts) admits rechecks only through the receiving codec's private runtime brand. A copied body or asserted actor is insufficient. Existing native identity/context receipts are unchanged. |
| Core current resource | [retained-read-authority.service.ts](../../apps/api/src/auth/retained-read-authority.service.ts) brackets resource observations with native identity and actual selected-tenant membership checks; [retained-read-authority.ts](../../apps/api/src/auth/retained-read-authority.ts) owns closed selectors/receipts. `actorId` is Core `users.id`; verified `clerkUserId` remains a separate namespace. |
| Portfolio resource vector | [research-portfolio-current-authority.ts](../../apps/api/src/research-portfolios/research-portfolio-current-authority.ts) reuses canonical grant access and wall decisions. Detail observes currently linked clients; Changes observes the sorted tenant denied-client set, including historical/unlinked IDs. False linked walls filter visibility rather than denying the whole readable portfolio. The new bounded observations refuse overflow; existing public reads retain their behavior. |
| Florida resource vector | [florida-current-authority.service.ts](../../apps/intel-api/src/tracker/editorial/florida-current-authority.service.ts) uses the existing Phase8 feature/member/folder/client owners and current wall facts. It preserves empty session keys and exact supplied bytes. Non-UUID client names currently return 503 pending the genuine canonical resolver seam. |
| Core issuer/current/data | [retained-principal.service.ts](../../apps/api/src/auth/retained-principal.service.ts) signs actual parsed request/normalized/context digests and current native/resource facts; fresh verification is mandatory after signature verification. Portfolio data reuses `ResearchPortfoliosService.detail` and `ResearchPortfolioChangesService.listChanges`, with current checks before and after the canonical DTO read. [retained-principal.controller.ts](../../apps/api/src/auth/retained-principal.controller.ts) owns fixed issuer/data siblings. |
| Intel probe/data | [retained-florida-read.service.ts](../../apps/intel-api/src/tracker/editorial/retained-florida-read.service.ts) verifies distinct purposes, brackets current facts with fresh Core corroboration, and reuses `Phase8EvidenceService.budget` for the unchanged Florida DTO. [retained-florida-read.controller.ts](../../apps/intel-api/src/tracker/editorial/retained-florida-read.controller.ts) owns the two fixed Intel siblings. |
| Private Core corroboration | [retained-florida-current.controller.ts](../../apps/api/src/auth/retained-florida-current.controller.ts) checks the authority-only probe without a resource read, avoiding recursion. The data-current sibling checks the original signed data envelope and the same current producer vector. |
| Closed wire and transport | Server-only [principal codec](../../packages/shared/src/core-retained-principal.ts), [probe codec](../../packages/shared/src/core-retained-authority-probe.ts), [request parser](../../packages/shared/src/core-retained-read-request.ts), and [HTTP adapters](../../packages/shared/src/core-retained-authority-http.ts) use required injected real JCS, fixed recipients/purposes, Ed25519 pins, and bounded bodies/receipts. They are separate package subpaths rather than exports from the browser-facing shared barrel. |

Resource revisions are deterministic producer-specific resource/grant/wall vectors. They exclude observation clocks, expiry and identityRevision. Changed observations withhold results; they are not database locks or a history of changes that reverted between observations. Meri run/conversation/worker/fence context remains CONTROL-owned correlation, never a new Core authority source. No Meri conversation ID is assumed to be a legacy Core conversation ID.

## Fixed routes

All entries are POST. Exact closed bodies and receipt/envelope schemas remain in the accepted [WIRE.md](WIRE.md) and backend-only [PRIVATE-PROBE.md](PRIVATE-PROBE.md).

| Operation | Native CONTROL current facts | Native CONTROL issuer | Signed data |
| --- | --- | --- | --- |
| Portfolio Detail | `/api/clio/application-authority/retained-research-portfolio` | `/api/clio/application-authority/retained-research-portfolio-principal` | `/api/clio/retained-reads/research-portfolio` |
| Portfolio Changes | `/api/clio/application-authority/retained-research-portfolio-changes` | `/api/clio/application-authority/retained-research-portfolio-changes-principal` | `/api/clio/retained-reads/research-portfolio-changes` |
| Florida Budget | `/api/clio/application-authority/retained-florida-budget` | `/api/clio/application-authority/retained-florida-principal` | `/intel-api/internal/legiwatch/retained-florida-budget` |

Private plumbing is fixed to Core-to-Intel `/intel-api/internal/legiwatch/retained-florida-authority`, Intel-to-Core `/api/clio/application-authority/retained-florida-native-current`, and Intel-to-Core `/api/clio/application-authority/retained-florida-current`. Authority-only calls use `CapiroRetainedAuthority`; data uses `CapiroRetained`. Native Bearer remains solely on the original CONTROL-to-Core native boundaries. There is no service-secret, actor-plus-secret or native-user fallback in delegated mode.

## Composition and remaining work

[RetainedReadAuthorityModule](../../apps/api/src/auth/retained-read-authority.module.ts) has source-enabled `false` and an unavailable Florida port. [RetainedPrincipalModule](../../apps/api/src/auth/retained-principal.module.ts) has null principal/probe ports. [RetainedFloridaReadModule](../../apps/intel-api/src/tracker/editorial/retained-florida-read.module.ts) has null ports and returns an unavailable service unless its genuine Phase8 provider is imported. None is imported by the current application modules.

The remaining source integration inputs are concrete: constructor-pinned Ed25519 key/keyId, issuer and exact Core/Intel HTTPS origins; the existing canonical Phase8 provider export/import composition; and the existing canonical client-name resolver seam. Missing owners continue to return 503. There is no undeclared scheduling, stale-plan, administrator-wall or new business-policy decision in this increment. No new Objective effect, product grant, migration or Meri/Fable implementation is authorized by the retained-read principal.

An integration owner must explicitly compose these fixed routes with existing Core tenant and Intel global guards. That activation remains unallocated; no broad middleware/guard bypass has been added. Genuine trust/material allocation and integrated qualification precede any live adoption.

The outer request and HTTP lifetimes are bounded to 30 seconds and the original signed/caller cutoff. `x-meri-deadline-at` only shortens. Checks before/after awaits stop new owner calls and withhold late results. They cannot physically cancel already-running owner I/O: the existing canonical Florida DTO owner retains its internal 45-second transaction timeout. This limitation remains an integration qualification item, not a claim of rollback or cancellation.

See [VALIDATION.md](VALIDATION.md) for exact completed checks and remaining qualification. The source owner supplies the final source manifest, focused-batch result and commit pin at sealing; this handoff does not invent those pending records.
