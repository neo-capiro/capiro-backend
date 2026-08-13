# Outreach V3 Revised Phase 6 — Final Mockup and Design-to-State Manifest

**Program:** Capiro Engagement API + Outreach V3
**Execution branch:** `agent/outreach-v3-p6-conversational-ui`
**Required base:** Phase 5 head `835cdef35cd8ecb23faf1b100ecfc743bcd31128`
**Figma file:** `2aa9ipR2qOfumaixZErCfU`
**Figma page:** `28 · Hi-Fi Prototype · Outreach V3` (`618:1391`)
**Design accepted by product owner:** 2026-08-09
**AWS mutation:** prohibited until separate authorization
**Merge:** prohibited until combined Phase 4–6 validation is green

## 1. Authority order

1. The accepted Figma page is the visual, responsive, and interaction-layout source of truth.
2. The revised thin-reasoning master plan is the security, state, and action source of truth.
3. The canonical Campaign Spec and deterministic command engine are the business-state source of truth.
4. Reasoning conversation state is nonauthoritative and may only create visible pending proposals.
5. Existing Outreach v2 remains Classic Outreach and must remain available during preview and rollback.

A mockup control that implies later-phase authority must be rendered as unavailable or preview-only until the owning backend exists. Phase 6 does not invent generation, approval, preflight, send, retry, provider-delivery, or memory-commit authority.

## 2. Archived design inputs

The Figma document itself is the immutable collaborative source. This manifest freezes the exact accepted nodes used for implementation review.

| Surface | Figma node | Phase 6 authority |
|---|---:|---|
| Goal-first campaign setup | `634:2703` | Implemented through canonical commands |
| Sponsor scope | `638:2906` | Implemented through `SET_SPONSOR_SCOPE` |
| Target discovery | `640:3097` | Implemented through target read APIs and target commands |
| Selected target profile and coverage | `643:3350` | Implemented through profile, relationship, and coverage reads |
| Delivery and personalization | `645:3555` | Implemented through delivery commands |
| Governed context and strategy | `646:3746` | Implemented through context reads, context commands, and deterministic strategy |
| Model proposal review | `648:3987` | Implemented through pending proposal Apply / reject |
| Representative samples | `649:4168` | Visual contract for next phase; generation unavailable in Phase 6 |
| Exception-first draft review | `650:4380` | Visual contract for next phase; draft authority unavailable in Phase 6 |
| Deterministic preflight | `651:4576` | Visual contract for next phase; send authority unavailable in Phase 6 |
| Delivery results | `652:4774` | Visual contract for next phase; provider outcomes unavailable in Phase 6 |
| Mobile goal | `654:4967` | Implemented responsive state |
| Mobile target profile | `655:5028` | Implemented responsive state |
| Mobile proposal review | `656:5099` | Implemented responsive proposal state |
| Recovery-state board | `661:5304` | Implemented loading, empty, unavailable, stale-proposal states |
| Deliverables index | `664:5290` | Review-only implementation inventory |

Final Figma mechanical QA reported zero out-of-frame descendants and zero missing fonts across the fourteen complete desktop/mobile screens.

## 3. Production component map

| Component | Responsibility | Canonical owner |
|---|---|---|
| `OutreachWizardRouter` | Explicit preview activation and Classic fallback | Web routing only |
| `OutreachV3Route` | Session bootstrap, error boundary, responsive shell | Session API |
| `useOutreachV3Session` | One canonical query/mutation bridge; no duplicate browser Campaign Spec | State/reasoning/target/context APIs |
| `OutreachConversation` | Transcript, bounded free text, proposal visibility | Reasoning API |
| `CampaignBrief` | Read-only projection of canonical Campaign Spec | State API |
| `CurrentDecisionSurface` | Current model-independent stage controls | Command engine |
| `TargetWorkspace` | Search, add/remove, profile, coverage | Target APIs + command engine |
| `ContextReview` | Source class/scope review; include/exclude | Context APIs + command engine |
| `StrategyReview` | Deterministic recommendation and editable strategy | Strategy read + command engine |
| `ProposalReview` | Apply, reject, stale conflict handling | Proposal API |
| `FuturePhaseBoundary` | Samples/drafts/preflight/results unavailable copy | No Phase 6 mutation authority |

## 4. Stage derivation

The active required stage is derived from canonical state and readiness. It is never persisted as authoritative UI state.

1. `goal` — required goal/read-back fields are incomplete.
2. `sponsor` — sponsor scope remains `undecided`.
3. `targets` — no selected target reference exists or target readiness has a blocking condition.
4. `delivery` — delivery pattern or personalization remains `undecided`.
5. `context` — required context review is incomplete or context has blockers.
6. `strategy` — campaign angle, tone, or length is incomplete.
7. `ready_for_generation` — planning is complete; Phase 6 stops at a disabled generation boundary.

Completed stages may be opened in review mode. Merely opening a prior stage does not mutate state. A committed command may invalidate downstream readiness according to the backend contract.

## 5. Visible-control contract

### 5.1 Global and session controls

| Control | Outcome | Loading/error/accessibility |
|---|---|---|
| Open V3 preview | Requires explicit session-scoped activation and Engagement API preview mode | Fail closed to Classic; query parameter consumed with history replace |
| Open Classic Outreach | Clears only V3 UI preview state and remounts v2 | Never converts or deletes a V3 session |
| Finish later | Leaves the route after current mutation settles | Session is already durable; display save state |
| Start new | Creates a new canonical V3 session after confirmation | Does not archive the existing session unless separately requested |
| Stage item | Opens completed stage in review mode | Current/future stages are not false mutation shortcuts; keyboard focus visible |

### 5.2 Conversation

| Control | Outcome | Guard |
|---|---|---|
| Send turn | POST bounded text to the reasoning conversation | Blank and duplicate submissions disabled |
| Suggested action | Uses the same deterministic command handler as the matching work-surface control | Cannot bypass validation or disabled state |
| Apply proposal | Calls proposal Apply against its expected canonical state version | Stale proposal surfaces conflict; never auto-rebases |
| Discard proposal | Rejects the pending proposal | No Campaign Spec mutation |
| Retry reasoning | Retries only the reasoning turn | Canonical selections and fields remain usable |

Typing `send it` has no Phase 6 send authority. It may only explain that generation/preflight is a later phase.

### 5.3 Goal/read-back

| Control | Canonical command |
|---|---|
| Goal | `SET_GOAL` |
| Objective | `SET_OBJECTIVE` |
| Topic | `SET_TOPIC` |
| Desired outcome | `SET_DESIRED_OUTCOME` |
| Explicit ask | `SET_ASK` |
| No formal ask | `SET_ASK { mode: none }` |
| Clear ask | `CLEAR_ASK` |
| Why now | `SET_WHY_NOW` |

Save/Continue batches only the edited fields, uses a UUID batch id, and sends the current server state version.

### 5.4 Sponsor

Supported scopes are firm, one client, several clients, coalition, internal team, and none. Selection does not add targets.

| Control | Canonical command / read |
|---|---|
| Sponsor scope | `SET_SPONSOR_SCOPE` |
| Client search/select | Existing authorized `clients` input supplied by the parent route |
| Remove selected client | Local draft until scope is committed |
| Coalition label | Local draft until scope is committed |
| Confirm sponsor | One `SET_SPONSOR_SCOPE` command after scope-specific validation |

### 5.5 Targets and profile

| Control | API or command |
|---|---|
| Recommended / Directory / client contacts / recent / manual source | Target search API source filters |
| Search | `POST .../targets/search` |
| Add | `ADD_TARGET_REFS` with server-resolved locator |
| Added | Disabled status plus separate Remove |
| Remove | `REMOVE_TARGET_REFS` |
| Not relevant | `REJECT_TARGET_RECOMMENDATION` |
| Open profile | `POST .../targets/profile` |
| Relationship details | `POST .../targets/relationships` when a single authorized sponsor client exists |
| Coverage | `GET .../targets/coverage` |

No recommendation is auto-added. Manual targets may be selected only if represented by an implemented server-resolvable locator; Phase 6 must not invent a client-side-only target identity.

### 5.6 Delivery

| Control | Canonical command |
|---|---|
| Personalized separate | `SET_DELIVERY_PATTERN personalized_separate` |
| Uniform separate | `SET_DELIVERY_PATTERN uniform_separate` |
| Shared thread | `SET_DELIVERY_PATTERN shared_thread` |
| Personalization level | `SET_PERSONALIZATION` |
| Continue | Commits the selected pattern and personalization in one batch |

Shared thread must visibly state recipient visibility. Phase 6 does not generate or send.

### 5.7 Context and strategy

| Control | API or command |
|---|---|
| Review accepted/excluded context | `GET .../context/review` |
| Search memory | `POST .../context/memory/search` |
| Research government | `POST .../context/government/search` |
| Open document | `POST .../context/document` |
| Accept selected source | `ACCEPT_CONTEXT_REFS` |
| Exclude source | `EXCLUDE_CONTEXT_REFS` |
| Review deterministic strategy | `GET .../context/strategy` |
| Campaign angle | `SET_CAMPAIGN_ANGLE` |
| Tone | `SET_TONE` |
| Length | `SET_LENGTH` |

Writing guidance must remain visually distinct from factual evidence. Target-specific context must show its named target scope. Multi-client/coalition context follows backend sponsor-isolation policy.

## 6. Later-phase visual boundaries

The accepted Figma page includes samples, drafts, preflight, send confirmation, and delivery outcomes so the customer journey is visually coherent. In Phase 6:

- no generation request command is emitted;
- no draft is created or approved;
- no send intent is created;
- no provider sender is called;
- no test send is called;
- no delivery retry exists;
- unknown delivery is never represented as failed;
- controls link to a clear “available after governed generation is enabled” boundary, not a fake success path.

## 7. Preview and rollback contract

V3 UI requires both:

1. Engagement API preview mode is active for this browser session; and
2. Outreach V3 UI preview mode is explicitly active for this browser session.

The activation URL consumes `outreach-v3-preview=v3`; `outreach-v3-preview=off` clears it. Unknown values are ignored. The mode is stored in session storage, never local storage. Opening an existing v2 draft always uses Classic Outreach because semantic conversion is not implemented.

## 8. Required Phase 6 validation

- Web typecheck and focused Vitest suites.
- Route-pattern generator includes state, reasoning, target, and context V3 manifests.
- UI preview is default-off and fails closed.
- Existing Outreach v2 renders unchanged when V3 preview is off.
- No Phase 6 web file names the preview header directly.
- No generation/send endpoint is imported or called by V3.
- Every enabled control has a command/read outcome.
- Reasoning outage leaves deterministic stages usable.
- Stale proposal cannot Apply and offers refresh/discard behavior.
- Keyboard, screen-reader labeling, focus return, touch targets, mobile, and no-horizontal-overflow checks.
- Combined Phase 4–6 verification remains required before merge or deployment.
