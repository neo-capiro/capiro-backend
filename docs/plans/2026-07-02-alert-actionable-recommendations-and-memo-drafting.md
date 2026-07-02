# Actionable Recommendations & One-Click Memo Drafting from Alerts

**Status:** DRAFT plan v2 (2026-07-02) — enriched with logic + success criteria per Ninja review. Not yet implemented.
**Surface:** Capiro Intelligence (intel-api unified Feed + live hearing room) → client-profile Tracker → Feed
**Goal:** After a *meaningful* alert, offer the analyst concrete next actions — chiefly **Draft a client memo** — and generate a memo grounded in (a) the alert's evidence, (b) rich client/bill/hearing context, and (c) **the client's own knowledge files (Settings → Memory)**. The finished memo **auto-saves into the client's profile Documents**, is editable, and is exportable.

## Resolved decisions (Ninja, 2026-07-02)
1. **Generation runs in intel-api** (it owns the alert + Feed; already calls LLMs for hearing briefs). Reuses per-tenant AI keys via the existing orchestrator path.
2. **Deliverable = Client memo only** for v1 (talking points / committee-staff memo / outreach are deferred, not built now).
3. **On completion the memo automatically saves to the client profile → Documents** (`EngagementAttachment`), rendered as a Word doc. ⭐ New hard requirement — see §5.
4. **This is a plan, not a build** — proceed only after Ninja approves this enriched version.

---

## 1. The customer experience

1. A meaningful alert lands in the client's **Feed** (or as a live **intelligence card** during a hearing) — e.g. *"H.R. 8800: Rule granted (floor scheduled)"* or *"Stem-cell hearing — 7 watchlist mentions."*
2. Under the "why it matters" line, a compact **Recommended actions** row appears: **Draft client memo** (primary) · Add talking point · Add to weekly report · Open bill/hearing.
3. Clicking **Draft client memo** opens a **composer drawer**. It shows a generating state, then fills with a structured, source-grounded draft:
   > **Bottom line · What happened · Why it matters to [Client] · Recommended actions · Talking points · Sources**
   Tone/priorities/red-lines come from the client's Memory files; facts come from the alert + bill/hearing detail; every paragraph is source-tagged.
4. **The memo auto-saves to the client's Documents** as a `.docx` (analyst sees a "Saved to [Client] › Documents ✓" confirmation).
5. Analyst can **edit inline, Regenerate, Copy, Export**, and re-save (updates the same Document). The alert shows a **"memo drafted"** badge and a "View memo" link.

**Why this CX wins:** it happens where the intelligence already is (no context switch), reads in the client's own voice (Memory files), is trustworthy (source-grounded, analyst-reviewed before anything sends), and the deliverable lands in the client's file automatically.

---

## 2. Recommended actions — logic

Alerts already carry `evidence.recommendedAction` (one italic string today). Evolve into a typed list computed **deterministically on read** in the Feed service.

```ts
type RecommendedAction = {
  kind: 'draft_memo' | 'add_talking_point' | 'add_to_report' | 'open_bill' | 'open_hearing';
  label: string;
  primary?: boolean;
  target?: { billId?: string; sessionId?: string };
};

function recommendedActions(alert): RecommendedAction[] {
  if (bandRank(alert.band) < bandRank('notable')) return [];      // gate: notable+ only
  const a: RecommendedAction[] = [{ kind: 'draft_memo', label: 'Draft client memo', primary: true }];
  if (alert.sourceType === 'bill' || alert.sourceType === 'combined')
    a.push({ kind: 'open_bill', label: 'Open bill', target: { billId: alert.sourceRef } });
  if (alert.sourceType === 'hearing' || alert.sourceType === 'combined')
    a.push({ kind: 'open_hearing', label: 'Open hearing', target: { sessionId: alert.evidence.sessionId } });
  a.push({ kind: 'add_talking_point', label: 'Add talking point' });
  a.push({ kind: 'add_to_report', label: 'Add to weekly report' });
  return a;
}
```

- **"Meaningful" gate:** severity band ≥ `notable` (reuse the AlertScorer band already on `intel_alert`). Info-level alerts get no action row (noise control).
- Pure function → unit-testable; no schema column (derived per response). `draft_memo` is always primary when shown.

---

## 3. The memo context bundle (the heart — includes the client's Memory files)

`MemoContextService.assemble(tenantId, clientId, alertId)` builds a **budgeted, priority-ordered** bundle. Target ≈ 6k tokens; if over, drop from the bottom of the priority list.

| Priority | Layer | Source (all read-only to intel-api) | Contributes |
|---|---|---|---|
| 1 | **Alert evidence** | `intel_alert.evidence` | title, whyItMatters, band, triggering bill action **or** hearing quotes (speaker+ts), source URL |
| 2 | **Client voice & guardrails** ⭐ | **Memory files** `memory_items`: `client-soul` | priorities, decision-makers, **red lines / risk tolerance**, strategic read |
| 3 | **Bill/hearing facts** | GLOBAL `congress_bill` / `committee_hearing` via `SourceDataRepository`; hearing quotes from intel `transcript_segment`/`key_quote` | sponsor+party, stage, passage probability, committee, witnesses, quotes |
| 4 | **Client objectives** ⭐ | `memory_items`: `client-compass` | North-star outcomes, active objectives, success metrics → framing of "recommended actions" |
| 5 | **Tracked interest** | intel `tracked_bill` + `watchlist` | which tracked bills / issue areas this touches |
| 6 | **People/offices** ⭐ | `memory_items`: `client-people` + `congressional_directory` | their team, relevant members/committees for background & talking points |
| 7 | **Firm house-style** ⭐ | `memory_items`: `playbook` / `firm-soul` | firm-wide tone & strategic defaults |
| 8 | (v2) **Recent correspondence** | apps/api `mail_thread`/`outreach_record` | "what we last said to this office about this bill" |

**Memory-file read (the ⭐ requirement):** new `MemoryReadRepository.getClientMemory(tenantId, clientId)` and `getFirmMemory(tenantId)`, reading `memory_items` **read-only** via the ported `withTenant`, `slug = clientId` for client files (`visibility='tenant'` → no per-user gate). Sections concatenated to markdown via the same section model the Settings editor uses. This mirrors exactly how intel-api already reads `congress_bill`, so the read-only invariant holds.

**Fact vs. steering split:** layers 1/3/5/6-directory are **citable facts** (each gets a `claimId`); layers 2/4/6-memory/7 are **steering** ("about this client — write in this voice, prioritize these outcomes, respect these red lines"), never treated as citable facts. This split is what makes the memo bespoke without hallucinating.

---

## 4. Generation — logic

`DraftService.generate(tenantId, clientId, alertId, userId)`:

```
1. bundle = MemoContextService.assemble(...)             // §3
2. facts  = bundle.factLayers.flatMap(toClaims)          // [{claimId, label, value, url?}]
3. steering = bundle.steeringLayers                      // client-soul/compass/people/playbook markdown
4. prompt = MEMO_TEMPLATE(facts, steering)               // §8
5. resp = orchestrator.generate({ tenantId, userToken, prompt, responseFormat: MEMO_JSON })  // meriv2-core, per-tenant key
6. memo = verifyGrounded(resp)   // drop any paragraph whose claimIds ⊄ facts (borrowed from artifact generator)
7. draft = upsert intel_draft   (unique (alertId,'memo'); regenerate overwrites, bumps version)
8. return draft
```

- **Claim-grounding** (from apps/api artifact generator): model must return `{sections:[{heading, paragraphs:[{text, claimIds[]}]}]}` and use only supplied facts; ungrounded paragraphs are dropped, not shipped.
- **Idempotent** per `(alertId, kind='memo')`: first call creates, Regenerate overwrites `bodyMarkdown`/`sections` and increments `version`.
- **Per-tenant key + BYO** already handled by the orchestrator credential resolver. Generation only on explicit click → cost is attributable and bounded.
- **Failure modes:** LLM error → return 502 with a retry affordance, no partial `intel_draft`; empty-after-grounding → fall back to the deterministic scaffold (§ Phase 1) + flag `lowConfidence`.

---

## 5. Auto-save to client Documents ⭐ (new requirement)

Client **Documents** = `EngagementAttachment` (apps/api, S3-backed), created via `POST /api/engagement/attachments/upload-url` → S3 PUT → `POST /api/engagement/attachments/confirm`. **intel-api must not write apps/api tables**, so saving goes through apps/api's own authenticated API.

**New apps/api endpoint** (apps/api owns Documents + docx rendering via `meri-docgen`):
```
POST /api/engagement/attachments/from-memo
  body: { clientId, title, sections|bodyMarkdown, sourceAlertId, sourceService:'intel' }
  → render docx (meri-docgen: sections → WordSpec, Capiro formatting)
  → presign + PUT to S3
  → create EngagementAttachment { clientId, fileName, contentType, s3Key, source:'intel_memo' }
  → (existing) fire-and-forget KB indexing → context_embeddings 'client_doc_chunk'
  → return { attachmentId, fileName }
```

**Who calls it & when — "automatically when done":**
- **v1 (recommended): frontend auto-orchestration.** The web app holds the Clerk token and already calls both services. On generation success, it immediately (no click) calls `from-memo`; composer shows "Saving to Documents…" → "Saved ✓". On edit+Save, it re-calls to update (overwrite same `s3Key`/attachment). If the save call fails, a **Save to Documents** button appears (retry). This satisfies "automatic" from the user's view without a new service-to-service auth path.
- **v2 (hardening): server-side.** intel-api calls `from-memo` directly (forwarding the user token, same pattern as its orchestrator call) so the save survives a closed tab. Gated behind confirming intel-api→apps/api token forwarding.

**Side benefit:** because `attachments/confirm` (and `from-memo`) trigger KB indexing, the saved memo becomes part of the client's searchable knowledge base — future memos/Meri answers can reference prior memos.

**Format:** `.docx` (client-facing), filename `Memo — {billNum|hearing title} — {YYYY-MM-DD}.docx`. PDF export is a separate on-demand action (§ Phase 3).

**Update vs. version:** on edit-save, **overwrite the same attachment** (re-render, replace S3 object, touch `updatedAt`) to avoid Documents clutter; keep the prior `intel_draft.version` history in intel-api for audit. (Decision D-vers below.)

---

## 6. Data model

**intel-api (new, additive migration):**
```prisma
model IntelDraft {
  id             String   @id @default(cuid())
  tenantId       String   @map("tenant_id")
  clientId       String   @map("client_id")
  alertId        String   @map("alert_id")
  kind           String   @default("memo")               // v1: memo only
  status         String   @default("draft")              // draft | saved | edited | discarded
  title          String
  bodyMarkdown   String   @map("body_markdown") @db.Text
  sections       Json?                                    // [{heading, paragraphs:[{text, claimIds}]}]
  sources        Json?                                    // [{claimId, label, url}]
  contextMeta    Json?    @map("context_meta")            // which memory files + fact layers used (audit/"context used" UI)
  version        Int      @default(1)
  lowConfidence  Boolean  @default(false) @map("low_confidence")
  documentId     String?  @map("document_id")             // EngagementAttachment id once saved to Documents
  model          String?
  createdBy      String   @map("created_by")
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")
  @@unique([alertId, kind])
  @@index([tenantId, clientId])
  @@map("intel_draft")
}
```
- `intel_alert` Feed response gains derived `recommendedActions[]` + `hasDraft`/`draftId` (join to `intel_draft`).
- **apps/api:** `EngagementAttachment` gets `source` value `'intel_memo'` (no schema change if `source` is a free string; else add enum value). Optional `sourceAlertId` column for back-reference (nullable, additive).

---

## 7. Components

**intel-api**
- `recommended-actions.util.ts` (pure) — §2.
- `MemoryReadRepository` — read-only `memory_items` reads (client + firm). **Read-only invariant preserved.**
- `MemoContextService` — §3 bundle assembly + budgeting.
- `DraftService` — §4 generation + `intel_draft` persistence + idempotency.
- `DraftController` — `POST /clients/:c/alerts/:a/draft` · `GET /clients/:c/drafts/:id` · `PATCH .../drafts/:id` · `POST .../drafts/:id/regenerate` · `GET .../drafts/:id/export?format=pdf`. Guarded `TenantGuard` + `TrackerV2Guard` (internal-only).
- Feed service: attach `recommendedActions` + `hasDraft`.

**apps/api**
- `POST /api/engagement/attachments/from-memo` — render docx (meri-docgen) + upload + create `EngagementAttachment(source='intel_memo')`. §5.

**apps/web**
- Feed card (`TrackerFeedPanel.tsx`) + live room card (`LiveHearingRoomPage.tsx`): render `recommendedActions`; primary → composer.
- `MemoComposerDrawer.tsx` (new): generating state → structured draft w/ source chips → editable body → toolbar (Regenerate · Copy · Export PDF) + auto "Saved to Documents ✓" status + "Context used" disclosure (lists Memory files + sources).
- `intel-draft-api.ts` hooks; on generate-success auto-call `from-memo`.

---

## 8. Prompt design
- **Template** (adapt apps/api `POST_MEETING_MEMO_GUIDANCE`): sections Bottom line / What happened / Why it matters to {client} / Recommended actions / Talking points / Sources.
- **Facts** supplied as an id'd list; model must tag each paragraph with `claimIds`; verifier drops ungrounded ones.
- **Memory = steering** ("write in this voice, prioritize these outcomes, respect these red lines"), never citable facts.
- **Length:** 1 page (≈350–500 words); "Recommended actions" = 2–4 concrete, client-specific bullets derived from client-compass objectives + alert.

---

## 9. Edge cases & guardrails
- No client Memory files yet → memo still generates (facts only) + composer nudge: "Add {client}'s soul/compass in Settings → Memory for sharper, on-voice memos." (Turns the feature into a reason to fill Memory.)
- Alert with thin evidence → memo is short; never invents; `lowConfidence` shown.
- Client not resolvable / archived → 404; no draft.
- Regenerate/edit races → `intel_draft` unique key + last-write-wins with version bump.
- **Read-only invariant** intact (Memory files read-only; Documents write via apps/api API only). **Single-sender alert-delivery invariant untouched** (drafting ≠ sending; "Send as outreach" is deferred and would land in the existing Outreach composer which requires explicit send).
- **Gating** `tracker_v2` (internal tenant) until broader cutover.

---

## 10. Phasing & success criteria

Each phase is independently shippable and `tracker_v2`-gated (internal-only).

### Phase 1 — Recommended actions + deterministic scaffold (no LLM)
Derive/render action chips on Feed + room cards; wire `add_talking_point`/`add_to_report`/`open_*`; "Draft memo" opens the composer with a **deterministic** scaffold (alert + fetched context, no AI) that **auto-saves to Documents**.
**Success criteria (all must hold):**
- SC1.1 Every `notable`+ alert in the Feed/room renders the action row; `info` alerts render none. (browser QA on ≥3 alert types: bill, hearing, combined)
- SC1.2 "Draft memo" produces a scaffold containing the alert title, why-it-matters, the triggering action/quotes, and links — in <1s, no LLM call.
- SC1.3 The scaffold auto-saves as a `.docx` in the client's Documents tab; opening it shows the content; a second click updates (not duplicates) it.
- SC1.4 `tsc` clean (intel-api + web); read-only invariant verified (no intel-api write to apps/api tables — grep + review).

### Phase 2 — LLM memo with Memory-file injection ⭐
`MemoContextService` + `DraftService` (claim-grounded) + `intel_draft`; composer edit/regenerate/copy; **client Memory files injected as steering**.
**Success criteria:**
- SC2.1 Generated memo has all 6 sections; **every fact paragraph carries ≥1 valid `claimId`**; no paragraph cites a claim absent from the bundle (automated grounding check in the verifier + a spot audit).
- SC2.2 **Memory influence is demonstrable:** with a client-soul "red line" set (e.g. "never advocate for X"), the memo respects it; changing client-compass objectives changes the "Recommended actions" — shown via an A/B on the same alert with/without Memory. (This is the headline acceptance test for the Ninja requirement.)
- SC2.3 `contextMeta` records exactly which Memory files + fact layers were used; the composer "Context used" disclosure matches.
- SC2.4 Generation uses the tenant's AI key (BYO honored); a forced LLM error degrades to the Phase-1 scaffold with `lowConfidence`, never a broken drawer.
- SC2.5 Live end-to-end verified in the browser on a real internal client + a real alert (like the OVERLAND AI hearing alert already in the Feed).

### Phase 3 — Export & (optional) handoffs
On-demand PDF export; polish the Documents docx (Capiro letterhead + alert metadata header). (Outreach/Workspace handoffs remain deferred.)
**Success criteria:**
- SC3.1 PDF export downloads a well-formed, branded 1-page memo matching the on-screen draft.
- SC3.2 The Documents `.docx` opens cleanly in Word with headings + sources intact.

### Overall acceptance (feature "done" for internal)
- A-1 From a real Feed alert, an analyst produces a client-voiced, source-grounded memo and finds it in that client's Documents — in one click, <10s to first draft.
- A-2 Memory files provably shape voice + recommendations (SC2.2).
- A-3 Zero regressions to alert delivery / single-sender; read-only invariant intact; internal-tenant-gated.
- A-4 Deployed to prod (intel-api + api + web) and browser-verified.

---

## 11. Remaining decisions for Ninja
- **D-vers (§5):** on edit, overwrite the same client Document *(recommended)* vs. save a new versioned Document each time.
- **D-save (§5):** v1 frontend auto-save *(recommended, simplest)* vs. server-side intel-api→apps/api save (needs token-forwarding confirmation).
- **D-actions:** ship `add_talking_point` / `add_to_report` as real writes in Phase 1, or render them as "coming soon" and focus Phase 1 purely on the memo path.

---

*Grounded in a 5-way codebase map (2026-07-02): alerts/Feed (`intel_alert`, `feed.service`, `TrackerFeedPanel`); drafting infra (apps/api artifact generator — claim-grounded memos; Workspace doc-gen; engagement memo templates; `meri-docgen` docx); client Memory files (`memory_items`, Settings→Memory: client-soul/compass/people + firm playbook); context assembly (`intelligence.service`, ClientKb RAG); client Documents (`EngagementAttachment` via `/api/engagement/attachments/*`); per-tenant AI keys; intel-api reads apps/api read-only.*
