# Wire Pure Signal — Architecture Assessment & Phase 1 Plan

**Date:** 2026-09-02 · **Scope:** response to `Capiro_Wire_Pure_Signal_Claude_Code_Build_Brief.docx`
(proposed branch `feat/wire-pure-signal`). **This document is the deliverable the brief itself
asks for before any implementation** (brief §2: "Present an architecture assessment and Phase 1
plan before major implementation"; §21's full Development Process, steps 1–7). **It contains no
product code.**

**Grounding:** every claim below was verified against the code on `main` (commit `87a585513`) —
file:line anchors throughout, spot-checked directly in addition to the five research passes that
produced them. Every "does not exist" was verified by grep, not assumed. Where a doc under
`docs/` made a claim, the actual code was read to confirm it, since some earlier docs in this
repo (see §1.3) were themselves later corrected by a follow-up doc after being written from a
stale premise — this assessment does not repeat that mistake.

**Bottom line up front:** this is **not a greenfield build**. Every one of the brief's five
pipeline stages (§17 — cheap filters → embedding/candidate retrieval → graph-based candidate
matching → dedup → LLM evaluation) has a real, working precedent somewhere in this codebase, and
one existing service (`district-nexus-strategic.service.ts`, §1.5) already does a version of the
*entire* thing end-to-end for one narrow domain. The work is disciplined generalization and
integration, not invention. The two real gaps are (a) nothing persists a *scored* item today —
scoring is either ephemeral (news) or absent (RSS/X), and (b) nothing evaluates one external item
against *multiple* tenants' clients in one pass. Both are addressed in §5–§6.

---

## 1. What already exists, mapped to the brief's own investigation list (§2)

### 1.1 The Wire / Dashboard

- "The Wire" is real, not a fixture. It lives in `apps/web/src/vnext/pages/dashboard/DashboardVNext.tsx:362-390`,
  merging live X posts and live news articles into one time-sorted list
  (`DashboardVNext.tsx:78-98`), gated by `wireEnabled = model.visibility.news || model.visibility.xFeed`
  (line 67). Data comes from `useDashboardVNextModel.ts` via `@tanstack/react-query` against real
  endpoints, not test fixtures (`IMPLEMENTATION_CONTRACT.md:7-9` — "reuses the canonical endpoint
  *and* the canonical query key").
- **There are two parallel dashboards**, not one. Legacy `apps/web/src/pages/HomePage.tsx` (mounted
  at `/` in the classic app, `App.tsx:199`) has **no Wire and no X-feed concept at all** — only
  `'today' | 'work' | 'news'` modules. The Wire exists only inside `DashboardVNextView`
  (`VNextRouter.tsx:115-117`), selected at runtime by `isVNextSurface` (`env.ts:88`), which reads
  `VITE_WEB_SURFACE` from ECS runtime config — a real, environment-driven production toggle, not a
  dev-only branch. **Decision needed (§6, D-1): this build targets the vNext surface only.** The
  legacy dashboard is out of scope; stating this explicitly avoids a change that "works" but never
  renders for whichever tenants are still on the classic surface.
- `NewsWireRow` (`DashboardVNext.tsx:408-427`) already renders a `reason` pill when present — a
  live hook point for "why this is here," currently populated only by the news pipeline's own
  capability-match string. The Wire's row shape does not need to be invented; it needs a new field
  populated by a real evaluation instead of raw post/article text.
- **The card UI the brief wants already exists elsewhere and should be adapted, not designed from
  scratch**: `apps/web/src/vnext/pages/admin-misc/VNextActionCard.tsx` renders a 0–100 priority
  score, "What changed," "Why it matters," "Recommended action," per-dimension confidence chips,
  evidence citations that deep-link to source, and a reason-gated dismiss ("we never dismiss an
  action silently," `VNextActionCard.tsx:379-427`) — backed by a real, tenant-scoped, audited CRUD
  API (`apps/api/src/intelligence/action-recommendation.controller.ts`). This is the brief's §4/§12
  card, already built for a different feed. Generalize it; do not re-skin from a blank canvas.
- **Notifications**: two separate systems exist — a workspace-collaboration bell in a *separate*
  NestJS app (`apps/workspace`, own Prisma schema) scoped narrowly to draft-invite events, and a
  memory-review inbox living in the *main* `apps/api` app
  (`apps/api/src/memory/memory-review-inbox.controller.ts`) with the same tenant/RLS/RolesGuard
  machinery the Wire's own endpoints already use. The latter is the more plausible reuse target if
  a Wire signal ever needs push delivery beyond the feed itself; Phase 1 does not need either (the
  Wire is already a pull surface).
- **Feedback loop precedent, already built**: Meri chat message feedback
  (`apps/web/src/components/chat/message-feedback-shared.ts`) — thumbs up/down plus reason codes
  including `wrong_client_context`, `too_generic`, `bad_recommendation` (close cousins of the
  brief's "wrong Profile"/"wrong score") — posts to `POST /api/clio/messages/:id/feedback`
  (`meri.controller.ts:485`), which is captured as a `LearningSignal` **candidate** by
  `apps/api/src/learning/adapters/meri-feedback.adapter.ts` (explicitly "pure function — no I/O, no
  promotion, no writes"), and only becomes consequential through a human-gated review at
  `apps/api/src/memory/memory-review.controller.ts` (`approve`/`reject`/`request-changes`, all
  audit-logged). **This is exactly the brief's §13 requirement** ("do not silently retrain or
  globally change behavior from one user's feedback") — already enforced, not something to design.

### 1.2 Knowledge Plane (Phases 10–27g) — real, but solves an adjacent problem

- Vector storage (`ContextEmbedding`, `schema.prisma:1635`) and its provider
  (`apps/api/src/embeddings/embedding-provider.ts`) are real, production, source-agnostic by
  schema (`sourceType` is a free string) — but **every current writer embeds internal/government
  content** (capabilities, bills, LDA filings, client profile/person/facility/doc chunks, memory
  items — `embed-backfill.ts:242,305,370,433`; `client-kb.service.ts:137-270`). **Nothing embeds
  news or X content today.** Adding a new `sourceType` (e.g. `news_article`, `x_post`) is additive,
  not a schema change.
- The Context Resolver / Context Plane (Phases 15–19, 26) answers "what may this user see, for
  their own Meri request" — request-time retrieval scoping for chat/report/outreach surfaces
  (`context-plane-operation-registry.ts`). It is **not** built to answer "which clients does this
  external item relate to," and its own stated non-goals rule out ambient content classification.
  Registering a *new* operation here (e.g. `signal.evaluate`) is still the right integration point
  for tenant/client scoping (§5), but the resolver itself does not do candidate-matching work.
- `LearningSignal`/`LearningSignalCandidateOutcome` (Phase 27a/b, `schema.prisma:9828,9905`) feed
  governed **memory** candidates (Meri-feedback, CRM-Fill-accept/reject) — a different domain from
  item-level relevance scoring. **Do not build the Wire's signal object on this model** — it would
  conflate "a fact Meri should remember" with "an external event worth surfacing," which have
  different lifecycles, different owners, and different review queues.
- The closest existing precedent for "candidate item → score → why → feeds a real product surface"
  is **not** in the Knowledge Plane at all — it's `district-nexus-strategic.service.ts` (§1.5
  below), `news-catcher-dashboard.service.ts`'s `matchClientToArticle`, and
  `apps/intel-api/src/tracker/tracker-board.service.ts`'s bill recommendations.
- Reusable verification patterns: `GenerationVerifierService` (eleven deterministic checks against
  LLM-drafted content) and `MeriOpportunityAssessmentService`'s "deterministic packet → LLM
  narrative → every model claim checked against a citable evidence list, unsupported claims held"
  pattern are both directly applicable to "verify the LLM's why-it-matters claim" (§5).
  `generateGroundedJson()` (`packages/meriv2-core/src/grounding/grounded-json.ts`) is the newest,
  most general primitive — schema-forced completion, one bounded retry, citation/quote-grounding
  check — explicitly built for "Tier-2 workflows which have no generator yet," which describes this
  feature exactly.
- **Naming collision to avoid**: `LearningSignal`, `DefenseBudgetLifecycleSignal`, and
  `SAM_RELEVANCE_SIGNALS`/`ScoreFactors` all already use "signal" for unrelated concepts. The new
  model (§3) needs a name that does not read as one of these (proposed: `WireSignal`).

### 1.3 Meri — a family of services, not one orchestrator; one almost-exact unbuilt design precedent

- There is no single orchestrating service. `apps/api/src/meri/` is the mature chat orchestrator
  (`MeriService.streamMessage()`); `packages/meriv2-core` + `apps/meriv2-orchestrator` are an
  extracted core, deployed dark, behind its own `/meri-api/*`; `meriv3-*` is a third, OpenAI-based
  alternate chat runtime; and several **separate, non-"Meri"-named** LLM services exist entirely
  outside chat — `GenerationGatewayService` (outreach drafting), `alert-memo.service.ts` (memo
  generation), `apps/api-strategy/src/reports/` (report narratives), `apps/api/src/agentic/`
  (Tier-2 unattended workflows). *(Note: an earlier plan doc in this repo,
  `2026-06-29-meri-consolidated-command-architecture-plan.md`, was written from the stale premise
  that no orchestrator existed at all; its own successor doc,
  `2026-06-30-meriv2-technical-implementation-plan.md` §1, corrects this. This assessment relies on
  the corrected picture and the code itself, not the earlier doc.)*
- `GenerationGatewayService` (`apps/api/src/engagement/generation/generation-gateway.service.ts`,
  1066 lines) is the most mature governance pipeline in the codebase — authorize → pin model →
  compile evidence packet → persist → structured draft → deterministic verify → audit → persist
  version → meter — but its input shape (`GenerationRequest`) is narrowly built around "draft a
  message to one recipient." **Its pattern is the template to imitate; it is not a service to
  extend directly for a different-shaped job.**
- `ContextPlaneGatewayService` (`apps/api/src/context/context-plane-gateway.service.ts`, 449
  lines) is the canonical assembly point "every AI-facing product in the codebase now resolves
  through" (operation registry comment: "Phases 19-25 have now adopted every product; there are no
  reviewed legacy exceptions"). `EvidencePacketV2`
  (`apps/api/src/engagement/generation/evidence-packet.types.ts:161-193`) — trust-tagged evidence
  (`authoritative_structured | server_record | external_untrusted | user_authored |
  standing_memory`), immutable, hashed — is the right shape to model a new "signal evaluation
  packet" on: tag the external item `external_untrusted`, the client Profile/relationship data
  `server_record`/`authoritative_structured`.
- **The closest existing design precedent for this entire feature is specified but not built**:
  `docs/plans/2026-07-09-agentic-intelligence-architecture.md` §4.2 defines a "Client Impact
  Analyst" Tier-1 role whose output schema —
  `{clientId, relevance: 0–1, materiality, impactTypes[], recommendedAction, claims:[{text, kind,
  evidenceIds[], confidence}]}` — is nearly identical to what the Wire brief wants per item, per
  client. Its `/api/internal/alert-enrichment` endpoint does **not exist** (confirmed by grep — no
  matching controller/route on `main`). This is a blueprint to adapt, not code to call.
- "Never invent an action" is already a hard, deterministic gate elsewhere in the codebase, not
  just a prompt instruction: `apps/api/src/intelligence/actions/action-gating.ts`'s
  `shouldGenerate({materialityScore, relevanceScore})` requires **both** thresholds cleared before
  any action card is generated at all; `TargetingBriefService`'s `FALLBACK = {targets: [],
  recommendedSequence: []}` (`targeting-brief.service.ts:70-77`) treats an empty result as a
  legitimate output, never a forced answer. Both are direct models for the brief's §10 "no
  immediate action recommended; maintain awareness" requirement.
- **Genuinely new**: nothing today runs one external item against *multiple tenants'* Profiles in a
  single pass. The design principle ("Tier-2 iterates tenants explicitly, one un-mixed prompt per
  tenant, never a cross-tenant prompt") is already stated in the agentic-intelligence doc and
  demonstrated by `run-intel-workflows.ts`'s per-tenant loop, but no code executes that loop over a
  *shared* input today. This is real, bounded new work (§5), not a gap in existing design intent.

### 1.4 News and X ingestion — real pipelines, no persisted relevance score anywhere

- **X**: `apps/api/src/intelligence/x-feed/x-feed.service.ts` is real (hits `api.x.com/2` live), but
  is a **personal follow-list** (max 25 accounts, `XFeedSubscription`), fetched **on-demand** (no
  cron — confirmed absent from `infra/cdk/lib/ingestion-schedule.ts`'s 104 real job entries), with
  **zero relevance scoring**. This is the natural raw-input source for the brief's Jack Reed
  example, but the "Reed is associated with Jaia, so his account is monitored automatically"
  behavior does not exist — today a human must explicitly follow the account (§5 addresses this).
- **News**: two pipelines that don't overlap. NewsCatcher
  (`news-catcher-dashboard.service.ts`) has real relevance matching —
  `matchClientToArticle` scores each article against a client's capability/issue/PE-code/alias
  signals and produces a human-readable `relevanceReason` — but is **ephemeral**: results are
  cached 30 minutes and never persisted (its own README: "does not return or persist full article
  text"). RSS ingestion (`sync-rss-intel.ts` → `IntelArticle`) is real, **persisted**, and
  **scheduled every 6h**, but has **zero relevance matching** — `getSharedNewsDashboard()`
  hardcodes `clientMatches: []` (`news-catcher-dashboard.service.ts:248`). **The piece that scores
  doesn't persist; the piece that persists doesn't score.** Closing that gap is exactly Phase 1's
  job (§5).
- **No in-house cross-outlet dedup exists.** NewsCatcher delegates to the vendor's own
  `exclude_duplicates` flag; RSS dedups only on exact URL uniqueness — the same story at two URLs
  from two outlets becomes two unrelated rows. This confirms the brief's dedup requirement (§17)
  is a real, unaddressed gap, not something already solved elsewhere.
- **The scheduling/orchestration layer is real, deployed, and the correct extension point** for any
  new source adapter: EventBridge cron → shared Fargate task → `entrypoint.sh` dispatch →
  `SyncRun` watermark (`sync-run.helper.ts`), wired end-to-end in
  `infra/cdk/lib/ingestion-schedule.ts` (104 jobs) and `compute-stack.ts:1695-1764`. A new adapter
  is one new script plus one schedule-table entry — no new infrastructure primitive required.
- **Deterministic, non-LLM entity-extraction precedent is proven and running**: PE-code extraction
  from bill text (`bill-pe-extractor.service.ts`) and hearing-witness/personnel extraction scripts
  (explicitly "Deterministic — NO LLM," `extract-hearing-witnesses.ts:11`) both feed a shared
  entity-resolution subsystem with confidence scores. This is the direct model for the brief's
  "cheap deterministic/entity filters" pipeline stage (§17).
- `MemberPressItem` (`sync-member-press.ts`, scheduled every 3 days) is the closest existing analog
  to the brief's "congressional press releases" future source — already keyed by `bioguideId`,
  which *is* the "who does this matter to" association, by construction.
- `docs/architecture/legiwatch-live-hearings-v2.md` documents an accepted, directly analogous
  pattern: capture the public record **once** as a global data plane, then layer tenant-specific
  relevance **on top**, never copying tenant context into the shared record. This is strong
  internal precedent for the brief's own §11 requirement ("one source can affect multiple Profiles
  … the source should remain one underlying object while Profile-specific interpretations are
  separate") and should be cited as the design's own prior art, not reinvented.

### 1.5 The legislative/client knowledge graph — real, extensive, and one service already ties it all together

- **`Client` *is* the Profile.** There is no separate `Profile` model (`schema.prisma:710-847`);
  build against `Client`.
- **Client → Member of Congress**: `ClientTarget` (`schema.prisma:3196-3220`) is today's literal
  "Jack Reed is a relevant stakeholder for Jaia" row — `memberId`, `tier`, `source:
  'manual'|'meri'`. One wrinkle to carry into design: `ClientTarget.memberId` is a
  LegiStorm-sourced `DirectoryContact.id`, **not** `CongressMember.bioguideId` directly (comment at
  `client-targets.service.ts:40-47`: "cannot FK member_id" — the directory is an S3 snapshot, not a
  table). `DirectoryContact.bioguideId` is the crosswalk field into the real, global
  `CongressMember`/`CongressCommitteeMembership` tables.
- **Member → Committee**: `CongressCommittee` + `CongressCommitteeMembership`
  (`schema.prisma:3857-3908`) are real, global, joined by `bioguideId`+`systemCode`.
- **Client → Geography → sitting Members**: `ClientFacility` (state, congressional district,
  lat/lng) resolved via `RepresentationResolverService`
  (`apps/api/src/clients/representation-resolver.service.ts`), which is **explicitly deterministic
  by design** ("Do not ask a language model which district contains an address," line 8). For
  Jaia/Bristol, RI, this is the real, already-correct path to Reed *and* Whitehouse (Senate has no
  district filter — both come back from a state match alone).
- **Client → Programs/Program Elements**: today via `ClientCapability.peNumber`/`peNumbers[]` (a
  soft-ref string field), scored through five real evidence paths (direct / keyword-trigram /
  prior-award / facility-district / ecosystem) in `ClientPeRelevanceService`, cached in
  `ClientCapabilityFitRecommendation`.
- **Client → Strategies**: **not in this Prisma schema at all.** `sp_strategy`/`sp_node` are owned
  by a separate microservice (`api-strategy`), read only via raw SQL in three places
  (`strategy-work-retrieval.adapter.ts`, `strategy-context-plane.service.ts`,
  `district-nexus-strategic.service.ts`). This has a real, load-bearing consequence for Phase 1
  scope (§6, D-2): treating "Strategy relevance" as a normal Prisma relation is wrong; it requires
  the same raw-SQL cross-service read pattern already in use.
- **Client → Tags/Capabilities/Issues**: `ClientCapability` (tags, issueCodes, keywords) +
  `ClientWatchlist` (issueAreas, synonyms, riskTerms) + `Client.issueCodes`. The real, already-built
  query for "does this content match this client" is
  `IntelligenceService.getClientRelevanceTerms(clientId, tenantId)`
  (`apps/api/src/intelligence/intelligence.service.ts:4034-4148`), which unions LDA issue-code
  mappings with capability data into a keyword-match term set and a separate embedding-ready prose
  set. **Reuse this function directly** — it's already the correct integration point and is already
  shared by the office-recommender.
- **Naming collision to flag explicitly in any implementation plan**: `ClientCapability`
  (tenant-scoped, a client's own product) and the unrelated global `Capability`
  (`schema.prisma:10356`, a DoD taxonomy) are both called "Capability." The brief's
  "Profile→Issues/Capabilities/Tags" means `ClientCapability`.
- **The single most complete existing precedent for the brief's entire scoring model** is
  `apps/api/src/district-nexus/district-nexus-strategic.service.ts` (1223 lines). It already
  blends, into one weighted, versioned, tenant/client-scoped, compute-on-read score: committee
  jurisdiction (25), program-element budget relevance via `ClientPeRelevanceService` (20), active
  legislation via `TrackedBill` sponsor/cosponsor/committee (15), active strategy target via
  `sp_strategy`/`sp_node` (15), relationship engagement via `ClientTarget` + meetings + outreach,
  all matched by `bioguideId` (10), hearing timing (5), opportunity funding (5), and a defined-but-
  currently-unweighted member-historical-priorities slot (5). It is currently hardcoded to
  defense-budget committee codes (HASC/SASC/HAC/SAC) and scoped to committee-jurisdiction questions.
  **This is the architecture to generalize for Wire's relevance model, not a new one to invent.**

---

## 2. Reusable services and models — call into these, do not rebuild

| Brief pipeline stage (§17) | Call into (file) | Why |
|---|---|---|
| Cheap deterministic pre-filter | `IntelligenceService.getClientRelevanceTerms()` (`intelligence.service.ts:4034`); PE-code/hearing-witness extractor pattern | Already the real "does this content match this client's tags/capabilities" query; extractor scripts are the proven non-LLM cheap-filter model |
| Embedding/topic candidate retrieval | `EmbeddingProvider` (`embeddings/embedding-provider.ts`) + `ContextEmbedding` | Add a new `sourceType` (`news_article`, `x_post`); storage/provider contract is already source-agnostic |
| Graph-based candidate Profile matching | `RepresentationResolverService`, `ClientPeRelevanceService`, `district-nexus-strategic.service.ts` | Real, deterministic, already-scoped-to-client traversals of exactly the relations the brief lists |
| Deduplication | Phase 27c's embedding-cosine-threshold pattern (`LearningSignalMemoryConflictService`) | Pattern reusable; must be retargeted from memory-vs-memory to item-vs-item (see §5 — this is new work, not a call-in) |
| LLM relevance evaluation + verification | `generateGroundedJson()` (`packages/meriv2-core/src/grounding/grounded-json.ts`); `GenerationVerifierService` / `MeriOpportunityAssessmentService` claim-verification pattern | Schema-forced, citation-grounded, one bounded retry, deterministic fallback — built for exactly this kind of new Tier-1/2 workflow |
| Context/evidence assembly | `ContextPlaneGatewayService` + `EvidencePacketV2` shape | Canonical assembly point every AI-facing product already resolves through; register a new operation rather than a second context path |
| Never invent an action | `action-gating.ts`'s `shouldGenerate()`; `TargetingBriefService`'s empty-fallback convention | Already a hard deterministic gate elsewhere, not a prompt-only convention |
| Scoring without faking missing data | `alert-scorer.ts`'s null-for-unavailable-factor convention | An unscoreable dimension is excluded from the weighted mean, never defaulted to 0 |
| Signal card UI | `VNextActionCard.tsx` + `ActionRecommendationController` | Score, why-it-matters, recommended action, evidence citation, reason-gated dismiss — already built, needs generalizing not designing |
| Feedback loop | Meri message feedback → `LearningSignal` candidate → `memory-review.controller.ts` approve/reject | Already enforces "no silent global retrain from one user" |
| Tenant isolation | `PrismaService.withTenant`/`withTenantUser`/`withSystem` | Non-negotiable, used everywhere; the one pattern every new table/query must go through |
| Scheduling for new source adapters | `ingestion-schedule.ts` + `sync-run.helper.ts` | New adapter = new script + one schedule entry, no new plumbing |

## 3. Schema — what's actually new

Everything in §2 is additive. The one genuinely new table is a scored-item record — call it
**`WireSignal`** (name chosen to avoid the `LearningSignal`/`DefenseBudgetLifecycleSignal`
collisions noted in §1.2/§1.5), conceptually matching the brief's §9 object, but **mapped onto
existing naming conventions instead of invented fresh**:

- `sourceType` / `sourceId` — same free-string convention as `ContextEmbedding`, not a new enum
  keyed to whatever sources happen to exist at launch.
- `clientId` — FK to `Client` (the Profile), not a new Profile reference.
- One `WireSignal` row per **(source item, client)** pair — matching the brief's §11 requirement
  that one source can score differently per client — with the source item's own raw content
  living in the existing `IntelArticle`/`XPostCache` tables (or their successors) rather than
  duplicated per client row.
- `relevanceScore`, `scoreReason`, `matchedEntities`/`matchedTopics`/`matchedPrograms`/
  `matchedStrategies`/`matchedRelationships`/`matchedCommittees`/`matchedAgencies` as JSON, mirroring
  the brief's §9 field list but stored the way `ClientCapabilityFitRecommendation` and
  `district-nexus-strategic.service.ts`'s cached result already store their own evidence
  breakdowns.
- `confidence`, `createdAt`, `evaluatedAt` — same shape `AiRun` already uses for LLM-call
  provenance; this table should carry (or FK to) an `AiRun`-style row for auditability, consistent
  with the agentic-intelligence doc's metering requirement.
- A companion **`WireSignalFeedback`** table modeled directly on the existing Meri-feedback →
  `LearningSignal`-candidate shape (§1.1), not a new bespoke feedback model.

No other new tables are anticipated for Phase 1. Everything else (client relevance terms,
geography, committees, programs, strategies) is a **read** against tables that already exist.

## 4. Proposed Phase 1 architecture

```
        X account (existing x-feed ingestion, currently manual-subscribe only)
        News (existing NewsCatcher live-match + RSS persisted store)
                          │
              cheap pre-filter (deterministic)
   IntelligenceService.getClientRelevanceTerms() keyword/trigram match
   against every client whose Profile plausibly overlaps (narrowed by
   the client's ClientTarget/ClientFacility/ClientCapability graph —
   NOT a blind all-clients scan)
                          │
              candidate Profile matching (deterministic, real)
   RepresentationResolverService (geography → sitting Members)
   ClientPeRelevanceService (program/PE overlap)
   district-nexus-strategic.service.ts's traversal, generalized
   past its current defense-budget-only committee-code scope
                          │
              dedup (new — §5)
   same-story-different-outlet clustering, adapted from Phase 27c's
   embedding-cosine-threshold pattern, retargeted item-vs-item
                          │
              LLM relevance evaluation (new orchestration, existing primitives)
   generateGroundedJson() against an EvidencePacketV2-shaped packet
   (client Profile = server_record/authoritative_structured,
    external item = external_untrusted), through ContextPlaneGatewayService
   for tenant/client scoping; verified the way GenerationVerifierService /
   MeriOpportunityAssessmentService verify claims today
                          │
              WireSignal row (new table, §3) — one per (item, client)
                          │
              action-gating.ts-style "never invent an action" gate
                          │
              Wire (existing, real — DashboardVNext.tsx), rendered via a
              generalized VNextActionCard, not new card chrome
                          │
              WireSignalFeedback → LearningSignal candidate → memory-review
              (existing human-gated pattern, §1.1)
```

Every stage above either calls a service that exists today or generalizes one that exists in a
narrower form. The new work is the orchestration connecting them and the one new table, not new
infrastructure at any stage.

## 5. Recommended Phase 1 scope (narrow, per brief §19)

Matching the brief's own "Phase 1: X + News → Profile Matching → Meri Evaluation → Score → Why It
Matters → Wire" and its Jaia Robotics / Jack Reed proof case:

1. **Do not build a new X-monitoring product.** Extend `x-feed.service.ts` so that a
   `ClientTarget` row (Reed associated with Jaia) automatically adds that member's known X account
   to evaluation — without requiring the manual `XFeedSubscription` a user would otherwise have to
   create. This is the literal fix for the brief's core complaint ("the user should not have to
   separately add Reed's X account"). Scope this to `ClientTarget` rows only for Phase 1 (not the
   full geography/committee/program fan-out) to keep the candidate set small and provable.
2. **Reuse NewsCatcher's live matching, don't rebuild it** — `matchClientToArticle`'s
   capability/issue/PE-code scoring is the deterministic pre-filter; Phase 1's job is to persist
   its output (closing the "scores but doesn't persist" gap from §1.4) rather than replace the
   matching logic itself.
3. **One new evaluation service**, modeled on `MeriOpportunityAssessmentService`'s
   deterministic-packet-then-model-then-verify shape, producing the brief's five answers (what
   happened / which client / why / how important / what action) plus the 1–10 score, using
   `generateGroundedJson()` as the LLM-call primitive and `action-gating.ts`'s pattern for the
   "no invented action" requirement.
4. **One new table** (`WireSignal`, §3), written by that service.
5. **Wire UI**: generalize `VNextActionCard` into the Wire's right lane, on the vNext surface only
   (§6, D-1).
6. **Feedback**: reuse the existing Meri-feedback → candidate → review pipeline verbatim, adding
   the brief's specific reason vocabulary (Useful / Not useful / Wrong Profile / Wrong relevance
   score / Already knew this) alongside the existing chat reason codes.
7. **Explicitly out of scope for Phase 1** (per brief §19, "keep the initial entity set narrow"):
   committee/hearing/markup/Federal-Register/agency/grant sources, cross-outlet dedup at full
   generality (ship a narrow same-URL/near-duplicate-title version first), and the full
   geography+committee+program+strategy fan-out for candidate matching (start with `ClientTarget`
   + direct capability/PE match; add geography and strategy in a follow-up phase once the narrow
   path is proven).

## 6. Risks and decisions requiring explicit sign-off before implementation

- **D-1 — Surface scope.** Confirm this targets the vNext dashboard only. If any tenant still
  depends on the legacy `HomePage` dashboard for production use, this feature will not appear for
  them at all under the current runtime-config switch, and that's a product decision, not an
  engineering detail.
- **D-2 — Strategy relevance requires a cross-service read.** `sp_strategy`/`sp_node` live in
  `api-strategy`, not this repo's own migrations. Scoring "Strategy relevance" (brief §8) means
  either (a) the same raw-SQL read pattern three other services already use, accepting that
  coupling, or (b) deferring strategy-weighted scoring to a later phase. Recommend (b) for Phase 1
  given §5's narrowed scope, revisited once the narrow proof is live.
- **D-3 — X auto-monitoring blast radius.** Automatically adding a `ClientTarget`'s X account to
  evaluation (§5) changes `x-feed.service.ts` from strictly opt-in to partially automatic. Needs
  a decision on cost controls (X API call volume scales with number of `ClientTarget` rows across
  all tenants, not number of manual subscriptions) and on whether a client should be able to opt a
  specific stakeholder relationship out of auto-monitoring.
- **D-4 — Where the "never invent an action" and verification gates live.** Recommend building the
  new evaluation service as its own module (e.g. `apps/api/src/intelligence/wire-signal/`) that
  *calls* `ContextPlaneGatewayService`/`generateGroundedJson()`/`action-gating.ts`'s pattern, rather
  than extending `GenerationGatewayService` directly — its input/output shape does not fit
  outreach's "draft a message" contract (§1.3). Flagging this now since "do not create duplicate
  architecture" (brief §2) could be misread as "must extend the existing gateway" when the shapes
  genuinely don't match.
- **D-5 — Cost.** The brief's §17 layered-pipeline requirement is achievable (deterministic
  pre-filter and candidate matching are both cheap and already exist), but the LLM evaluation step
  itself needs an explicit per-tenant/per-day budget decision before Phase 1 runs against live
  traffic, consistent with the existing metering choke point (`ai_usage_events`/
  `recordAiUsageEvent`) — which the agentic-intelligence doc already flags as having gaps (not
  written by the scheduled-runner pattern this feature would most resemble).
- **Risk — evaluation quality cannot be measured in this sandbox.** See §7.

## 7. Sandbox and testing limitations (disclosed honestly, as with every prior PR this session)

This assessment was produced without `node_modules`, network, or database access. Everything above
was verified by reading real source files and Prisma schema definitions — not by running the code,
querying a live database, or calling a live LLM. Concretely, this means:

- Every file:line citation above was read directly; none is inferred from documentation alone.
- **What cannot be verified here, and must happen in a real environment before Phase 1 ships**:
  the brief's own §20 evaluation requirements — precision of surfaced signals, wrong-client rate,
  duplicate rate, explanation quality, action-hallucination rate, source-citation accuracy,
  latency, and per-source model cost — all require real ingested content, a real LLM call, and a
  hand-labeled test dataset (brief §20's own recommendation) run against live infrastructure. No
  amount of code review substitutes for that measurement.
- Building Phase 1 as scoped in §5 is implementable and testable with unit tests (mocked LLM
  responses, mocked Prisma) in this same sandboxed style as every prior PR this session — but the
  actual "is this pure signal or noise" judgment the brief cares about most (§14: "the product KPI
  is how much irrelevant information Capiro prevents the user from processing") can only be
  answered by the evaluation-dataset exercise in a real environment, with human review of real
  outputs.

## 8. Definition of done for this document (mapped to brief §22, adapted for an assessment-only PR)

This PR's own definition of done is narrower than the brief's full §22 list, which describes
Phase 1's done state, not this assessment's:

1. Every subsystem the brief asked to be documented (§2) is documented above with evidence. ✓
2. Reusable services/models are identified concretely, by file path. ✓
3. Schema changes are scoped to one new table plus additive fields, named to avoid the
   collisions found in §1.2/§1.5. ✓
4. A narrowed Phase 1 plan is proposed, explicitly deferring the brief's harder cross-service and
   cost-control decisions rather than hand-waving them. ✓
5. Risks and open decisions are named explicitly for user/Neo sign-off (§6), not resolved
   unilaterally. ✓
6. No implementation code is included. ✓

Brief §22's actual Definition of Done (Jaia Profile exists, Reed is associated, irrelevant posts
suppressed, a relevant post is scored and explained, etc.) is the target for the Phase 1 PR that
follows approval of this document — not this one.

## 9. Recommended next step

Review this document with Neo. The open decisions in §6 (D-1 through D-5) are the ones that
materially change Phase 1's shape — surface scope, strategy-relevance scope, X auto-monitoring
cost/opt-out, where the new evaluation service lives, and the LLM-cost budget. Once those are
resolved, Phase 1 implementation (§5) can proceed in the small, tested, reviewable commits the
brief's own §21 asks for, starting with the `WireSignal` table and the `ClientTarget`-only X
auto-monitoring fix, before adding news persistence and the Wire card generalization.
