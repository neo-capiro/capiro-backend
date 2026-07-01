# Live Hearing Intelligence (Deepgram) — Detailed Implementation Plan

Date: 2026-06-29
Owner: Neo Martinez (CTO)
Status: Proposed — MeriV2 Phase 5 (FINAL). Build AFTER the orchestrator spine, alert/KG
consolidation, and eval gates exist.
Parent plan: `docs/plans/2026-06-29-meri-consolidated-command-architecture-plan.md` (§4 + Phase 5
+ Appendix A6). This doc is the build-level expansion of that section.

---

## 0. One-paragraph summary

Live Hearing is the first capability of **`apps/intel-api`** — a new standalone intel service
(own ECR/Fargate task, modeled on `apps/workspace`) that becomes the future home for ALL
MeriV2 intelligence capabilities. It opens a WebSocket to the browser, streams audio to
**Deepgram for STT only**, commits finalized transcript segments to Postgres, and calls the **existing MeriV2
orchestrator tool registry** for all policy reasoning (entity tagging, relevance scoring, quote
flagging, action items, KG writes, alerts). Deepgram never reasons; MeriV2 never transcribes.
Client-relevant segments are encrypted at rest with the **same AES-256-GCM scheme as
`meeting_debriefs`** (no new crypto). Output feeds the same Bill-Tracker/Hearing-Watch shared
engine and the one alert taxonomy — not a new silo.

---

## 1. Service home — `apps/intel-api` (modular intel service)

Architectural decision (CTO): MeriV2 is moving to a **modular architecture**. Meri
(orchestrator) lives in its own service; **Hearing Watch / Live Hearing lands in its OWN
Fargate service named `intel-api`**, which becomes the **future home for ALL intelligence
capabilities** — votes, hearings, regulatory, fiscal, etc. will migrate into `intel-api` over
time. Live Hearing is simply the FIRST tenant of that service, so it must be built clean enough
to be the template the rest of intel follows.

A normal request/response handler in `apps/api` cannot host this workload:
- a long-lived WebSocket per session (minutes to hours),
- a second persistent WebSocket out to Deepgram per session,
- low-latency interim→final transcript handling,
- backpressure + reconnect/recovery on day-long streams,
- stateful per-session buffers.

Putting that in `apps/api` (request-scoped, autoscaled on RPS, recycled on deploy) would drop
live sessions on every scale-down or rolling deploy, force WS stickiness onto all api traffic,
and let a runaway hearing degrade the core API for every tenant. So:

**`apps/intel-api`** — its own NestJS service, own ECR repo, own Fargate service, modeled on the
`apps/workspace` template (`Dockerfile`, `nest-cli.json`, `main.ts`, `package.json`). Deps:
`@capiro/shared` + `@capiro/meriv2-core` ONLY (same constraint as workspace). It is the first
service in the repo to run a WebSocket gateway — there is no existing WS layer to copy, so this
introduces it. As more intel capabilities migrate in, they join THIS service, not `apps/api`.

---

## 2. Data model (Prisma — additive migrations only)

Two new first-class models, tenant-scoped from row one. Migration is purely additive (new
tables; no ALTER/DROP on existing tables — respects the shared-DB guardrail).

### 2.1 `LiveHearingSession`
```
id              String   @id @default(cuid())
tenantId        String   // indexed; every query filters on this
clientId        String?
matterId        String?
issueIds        String[]
hearingId       String?  // links to existing hearing record (Hearing Watch)
committeeId     String?
billIds         String[]
programElementIds String[]
agencyIds       String[]
title           String
sourceType      LiveHearingSourceType   // hearing|markup|meeting|webinar|agency_session
audioSource     LiveHearingAudioSource  // browser_mic|uploaded_audio|stream_url|conference_bridge
status          LiveHearingStatus       // scheduled|live|paused|ended|failed
startedAt       DateTime?
endedAt         DateTime?
consentStatus   ConsentStatus           // not_required|confirmed|needs_review
recordingPolicy RecordingPolicy         // transcript_only|audio_and_transcript|no_storage
claimMapId      String?
createdBy       String   // user_id — scoping
createdAt       DateTime @default(now())
updatedAt       DateTime @updatedAt
// relations: transcriptSegments[], keyQuotes[], actionItems[], entityMentions[], summaryCards[]
@@index([tenantId, status])
@@index([tenantId, clientId])
```

### 2.2 `TranscriptSegment`
```
id                  String  @id @default(cuid())
sessionId           String  // FK -> LiveHearingSession, onDelete Cascade
tenantId            String  // denormalized for scope-safe queries; indexed
startMs             Int
endMs               Int
speakerLabel        String? // Deepgram diarization label e.g. "0","1"
resolvedSpeakerId   String? // mapped to known member/witness
resolvedSpeakerName String?
isFinal             Boolean @default(false)
confidence          Float?
source              String  @default("deepgram")
// ENCRYPTED FIELDS when client-relevant (see §6):
textCiphertext      String? // base64 — null if stored plaintext (non-sensitive)
textPlain           String? // only for non-client-relevant public hearing text
iv                  String?
authTag             String?
keyVersion          String?
clientRelevanceScore Float?
issueTags           String[]
createdAt           DateTime @default(now())
@@index([sessionId, startMs])
@@index([tenantId, sessionId])
```
Supporting child tables (lighter): `KeyQuote`, `LiveActionItem`, `EntityMention`,
`LiveSummaryCard` — each `sessionId` + `tenantId` scoped, each pointing back to a
`transcriptSegmentId` + timestamp (satisfies SC5.6).

Enums added: `LiveHearingSourceType`, `LiveHearingAudioSource`, `LiveHearingStatus`,
`ConsentStatus`, `RecordingPolicy`.

---

## 3. Service architecture

```
Browser (Live Hearing Room, apps/web)
  │  WS  (audio chunks up; transcript+cards down)
  ▼
apps/intel-api  (NestJS, Fargate)
  ├── LiveHearingGateway        (WS endpoint, 1 conn per session)
  ├── DeepgramStreamManager     (1 Deepgram WS per session, reconnect/recovery)
  ├── SegmentCommitService      (interim buffer -> final -> Prisma, crypto)
  ├── ExtractionDispatcher      (final segment -> orchestrator tool calls)
  ├── ScopeGuard                (imports @capiro/shared tenant-mw; every op scoped)
  └── SessionRegistry           (in-memory live-session state, recovery cache)
        │  HTTP (tool calls)
        ▼
apps/meriv2-orchestrator  (/meri-api/*)  — registry tools do ALL reasoning
        │
        ▼
Postgres (sessions, segments)  +  KG  +  alert taxonomy (shared engine)
```

### 3.1 Connection lifecycle
1. Browser POSTs `create_live_hearing_session` (orchestrator tool) → gets `sessionId`.
2. Browser opens WS to live-hearing service with `sessionId` + Clerk JWT in the handshake.
3. `ScopeGuard` validates JWT via `@capiro/shared`, resolves `{tenant_id,user_id,roles,org}`,
   confirms the user owns/can-access that session → else close 4403.
4. `DeepgramStreamManager` opens the Deepgram live WS (model, `interim_results=true`,
   `diarize=true`, `punctuate=true`, `endpointing` configured).
5. Audio frames flow browser→service→Deepgram. Interim transcripts flow back for live captions
   (NOT persisted). Final segments → `SegmentCommitService`.

### 3.2 Backpressure + recovery (SC5.9)
- Interim results are ephemeral (UI only), so dropping them under load is safe.
- Final segments are the durable unit: committed transactionally, idempotent on
  `(sessionId,startMs,endMs)`.
- On Deepgram WS drop: `DeepgramStreamManager` reconnects with exponential backoff, resumes the
  stream; already-committed finals are untouched. On browser WS drop: session goes `paused`,
  `SessionRegistry` holds state for a reconnect window, then `ended` if no return.

---

## 4. Deepgram integration (STT only)

- Library: official `@deepgram/sdk` live transcription client (WebSocket).
- Config: streaming, `interim_results`, `diarize` (word-level speaker turns), `punctuate`,
  `endpointing` for utterance boundaries, model = Deepgram's latest streaming model.
- Key: `DEEPGRAM_API_KEY` env (per-service secret, AWS Secrets Manager — same pattern as other
  service secrets; never in code).
- Deepgram provides ONLY: streaming transcription, interim→final events, endpointing,
  diarization labels, timestamps, reconnect signaling.
- Deepgram provides NONE of: entity recognition, speaker identity resolution, relevance,
  quotes, actions, artifacts, compliance, KG. Those are MeriV2 tools (§5).

---

## 5. Reasoning via the orchestrator registry (no forked logic)

On each FINAL segment, `ExtractionDispatcher` calls these EXISTING registry tools over HTTP
(they live in `@capiro/meriv2-core`, callable by chat too — that is the orchestrator-first
payoff, SC5.7):

| Trigger | Registry tool | Output persisted to |
|---|---|---|
| final segment text | `tag_live_policy_mentions` | `EntityMention` (bills/clients/PEs/agencies/offices) |
| diarized speaker | `identify_speaker_live` | segment `resolvedSpeakerId/Name` |
| relevance | (client-relevance scorer) | segment `clientRelevanceScore` |
| important line | `flag_key_quote` | `KeyQuote` (+ segmentId + timestamp) |
| actionable line | `extract_live_action_item` | `LiveActionItem` |
| UI push | `update_live_hearing_dashboard` | `LiveSummaryCard` → WS down to browser |
| session end | `generate_post_hearing_summary` | artifact (Doc-gen A16) |
| session end | `create_hearing_claim_map` | claim store (timestamps) |
| session end | `update_issue_dashboard_from_hearing` | shared alert engine (§8 taxonomy) |
| session end | `draft_hearing_followup_email` | draft only — routes via MS Graph OAuth (guardrail) |

Extraction is **debounced/batched** (e.g. per N final segments or per utterance group) to keep
tool-call volume sane on a multi-hour hearing. Entity links write to the KG as edges keyed on
canonical IDs (Appendix B) — `bill_id`, `committee_id`, `hearing session ID`.

---

## 6. Encryption (mirror meeting_debriefs EXACTLY — SC5.4)

Reuse the proven scheme from `apps/api/src/engagement/meeting-notes-crypto.service.ts`:
- Algorithm: `aes-256-gcm`, 12-byte random IV per segment, base64 fields
  `{bodyCiphertext, iv, authTag, keyVersion}`.
- Port `LiveTranscriptCryptoService` into `apps/intel-api` (copy the pattern, same
  shape as the workspace `secret-crypto.ts` copy already in the repo). Key from env
  `NOTES_ENCRYPTION_KEY` (+ `NOTES_ENCRYPTION_KEY_VERSION`) — same key family, OR a dedicated
  `HEARING_ENCRYPTION_KEY` if security prefers isolation (decision: default to reusing the notes
  key for consistency; flag to CTO if a separate key is wanted).
- Rule: a segment with `clientRelevanceScore` above threshold OR carrying client/issue entity
  mentions → store `textCiphertext` (encrypted), `textPlain = null`. Purely public,
  non-client-relevant hearing text MAY be stored plaintext for searchability. **Never both.**

---

## 7. Recording-policy enforcement at the storage layer (SC5.3)

Enforced in `SegmentCommitService` — in CODE, not UI:
- `no_storage`: nothing persisted. Live captions stream to UI and vanish; session row keeps
  metadata only.
- `transcript_only`: transcript segments persisted (encrypted per §6); raw audio NEVER written
  to disk/object store.
- `audio_and_transcript`: transcript + audio object (S3, tenant-scoped prefix, SSE) persisted.
- `consent_status='needs_review'` blocks `start_live_transcription` until resolved.
Verification: DB + S3 inspection per policy, not a UI check.

---

## 8. Frontend — Live Hearing Room (apps/web)

Route under the Intelligence Center shell (consistent with KG relocation). Layout:
```
LEFT:   live transcript (interim greyed, finals solid, speaker chips)
CENTER: live summary cards (streamed via WS)
RIGHT:  client relevance / key quotes / action items
BOTTOM: timeline of important moments
```
Card types: Client mentioned, Bill mentioned, Program element mentioned, Potential ask,
Opposition argument, Member position signal, Follow-up opportunity, Appropriations/authorization
language, Compliance-sensitive statement, Quote worth saving.
Audio capture: `MediaRecorder`/Web Audio → PCM/opus frames over WS. Mic permission + a visible
consent banner gated on `consentStatus`.

---

## 9. Build order (sub-phases within Phase 5)

1. **5a — Data + service skeleton**: Prisma models + additive migration; scaffold
   `apps/intel-api` from the workspace template; health endpoint 200 on `capiro-dev`.
2. **5b — WS + Deepgram**: gateway, `DeepgramStreamManager`, interim captions end-to-end (no
   persistence yet). Prove <2s caption latency (SC5.2).
3. **5c — Segment commit + crypto + policy**: finals to Postgres, AES-GCM encryption,
   recording-policy enforcement (SC5.3, SC5.4).
4. **5d — Extraction via registry**: `ExtractionDispatcher` → orchestrator tools; entity/quote/
   action persistence; KG writes (SC5.5, SC5.6).
5. **5e — Live Hearing Room UI**: full 4-pane room + card streaming.
6. **5f — Post-hearing + loop**: summary, claim map, issue-dashboard update through the §8
   taxonomy (SC5.8), follow-up draft via MS Graph; chat-over-finished-session (SC5.7).
7. **5g — Recovery + hardening**: forced-drop reconnect test (SC5.9), backpressure, day-long
   soak test.

---

## 10. Success criteria (from parent plan §6 Phase 5)

- SC5.1 Own service/ECR/Fargate task; deps `@capiro/shared` + `@capiro/meriv2-core`; calls
  registry tools, reimplements NO reasoning.
- SC5.2 Browser-mic → Deepgram → interim then final segments render in the room with <2s
  perceived caption latency.
- SC5.3 `recording_policy` enforced at storage layer (no_storage/transcript_only/
  audio_and_transcript) — verified by DB + object-store inspection, not UI.
- SC5.4 Client-relevant segments AES-256-GCM encrypted using the meeting_debriefs pattern (no
  new scheme; code review sign-off).
- SC5.5 Extracted intel flows to tenant_members-only KG engine, never embedded raw; hearing-data
  leakage test = 0.
- SC5.6 Every saved key quote/claim points to a `TranscriptSegment` id + timestamp.
- SC5.7 Post-hearing, chat answers "pull every quote on <topic>" against the finished session
  using the SAME registry tools.
- SC5.8 A captured hearing quote raises an alert through the Phase-1 taxonomy (no separate
  live-hearing alert silo).
- SC5.9 Forced WebSocket drop mid-session reconnects and resumes committing finals without
  losing prior committed transcript.

---

## 11. Guardrails (hard — CTO sign-off, from parent §9)

1. **CONFIDENTIAL CONTENT**: transcripts mirror `meeting_debriefs` AES-GCM; extracted intel →
   tenant_members-only KG engine section, NEVER embedded raw. No new crypto scheme.
2. **AUTH**: WS handshake validates the SAME Clerk JWT via imported `@capiro/shared` middleware;
   tenant+user scoping inherited exactly (a user accesses only sessions they could see in Meri
   today). No auth reimplemented.
3. **EMAIL**: `draft_hearing_followup_email` produces a DRAFT only; sending routes through
   existing MS Graph OAuth, gated by compliance precheck. No bypass.
4. **CONSENT/LEGAL**: recording two-party-consent risk is real for non-public meetings.
   `consent_status` gates capture; default `needs_review` for `meeting`/`agency_session`
   source types. Public hearings = `not_required`.

---

## 12. New infra / config introduced

- New service `apps/intel-api` → new ECR repo, Fargate service, ALB route
  (`/intel-api/*` + WS upgrade path), CI workflow (mirror `workspace-image.yml`).
- ALB/target group must allow WebSocket upgrade + long idle timeout (set idle timeout high for
  multi-hour streams; enable stickiness so a session stays on one task).
- Secrets: `DEEPGRAM_API_KEY` (new), reuse `NOTES_ENCRYPTION_KEY[_VERSION]` (or new
  `HEARING_ENCRYPTION_KEY` if isolated — CTO decision).
- Rollback td slot for the new service (mirror api:30/web:6/workspace:2 convention).
- Cost note: Deepgram streaming is billed per audio-minute; multi-hour hearings add up — add a
  per-tenant usage meter and a max-session-duration guard.
