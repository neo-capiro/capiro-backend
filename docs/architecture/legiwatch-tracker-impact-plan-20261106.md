# LegiWatch tracker and client impact implementation

## Authorized outcome

Neo requested a complete, simple LegiWatch bill tracker in Modules across all
authorized clients, the same tracker inside each Client Profile, and a separate
section retaining existing live hearings. Legislative and customer-impact detail
must use the connected source services; all model extraction uses the Claude
Agent SDK. Provider credentials are held in AWS Secrets Manager.

## Canonical owners and integration

- `capiro-frontend` (`main`): one Portfolio-owned tracker exposed through an
  explicit public composition boundary. Modules defaults to all authorized
  clients; Client Profile binds its client. Existing live-hearing workflows stay
  independently accessible. Reuse current 3.4 tokens and components.
- `capiro-backend` (`backend-import`): Core owns authenticated tenant, actor,
  client and wall authorization. New LegiWatch read/context/analysis handlers
  select the existing active tracker owner; retained tracking and watchlist
  writes continue to use that owner.
- `packages/shared`: deliberate typed tracker/impact public contract. Frontend
  consumes a frozen built artifact and validates HTTP responses.
- Existing FederalEvidenceRevision, state document revisions, structured bill
  documents and BillTextExtraction/Passage records remain the source owners.
  Do not introduce another legislative text extraction pipeline.
- Existing approved profile facts, capabilities and facilities supply client
  evidence. Each analysis is bound to current bill and client evidence hashes.
- PortfolioAgentService retains the native SDK harness. A trusted explicit
  provider option supports injected Anthropic credentials while preserving the
  existing Bedrock default for current callers. Bill 360 impact generation is
  migrated from direct model completion to the same SDK boundary.

## Interfaces and behavior

Core exposes a paged cross-client tracker, scoped bill detail/impact, a scoped
analysis action and scoped analyst context updates. Client access filtering
precedes counts and pagination. The all-client view is not tenant-wide authority.

Impact findings contain provision citations, client-fact citations, mechanism,
conditions, missing facts, confidence and a proposed next action. Model output
never sets an analyst's position or performs an external action. Missing source
text or facts is an explicit evidence gap. Stale evidence is visibly stale;
source changes cannot silently preserve a current assessment.

Analysis reads current authorized inputs before inference and rechecks access and
input identity before persistence. Failed, incomplete or ungrounded output does
not overwrite a valid result as if successful. Routine refresh must use existing
job infrastructure with bounded work and explicit provider configuration.

## Implementation lanes

1. Frontend: shared presentation, routes, typed operations and interaction tests.
2. Core: contracts, authorization, tracker/detail/context reads and writes,
   persistence, additive migration and service tests.
3. SDK: native extraction/analysis, exact evidence validation, existing Bill 360
   transport migration and offline SDK tests.
4. Evidence: current structured federal/state text and client evidence adapter,
   comprehensive input fingerprints and source coverage.
5. Infrastructure: existing-secret injection, validated explicit missing secret
   bindings, provider runtime settings, bounded schedule wiring and runbook.
6. Root: integration, dependency artifacts, review, gates and publication.

One writer owns each file. No repository history, other worktrees or applied
migrations are rewritten. No source or customer secret values enter evidence.

## Completion evidence

- Module defaults to Bill tracker; Live hearings remains separate and usable.
- Profile and module use the same tracker and details, with correct client scope.
- Pagination, filters, tracked-bill writes and analyst context persist correctly.
- Negative tenant/client/wall and revoked-access tests pass.
- Grounding tests reject invented source IDs, quotes and cross-client facts.
- New bill/profile versions mark previous results stale and refresh safely.
- Current contracts, type checks, focused backend/frontend tests and applicable
  browser, keyboard, responsive and accessibility checks pass.
- Independent review is performed against exact integrated source heads.
- AWS bindings, real provider/model calls, migration, image and deployed UI gates
  are reported separately from local source validation.

## Environment constraint

At task start the Work runtime has GitHub access and Node 24.22.1, but no AWS
credentials, AWS CLI or authenticated AWS plugin. Existing source credentials
can be wired without reading their values. Live API/model, database migration
and deployment completion require an authenticated execution environment; no
live qualification is inferred from source or synthetic tests.
