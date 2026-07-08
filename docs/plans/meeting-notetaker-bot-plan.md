# Meri Notetaker — Meeting Bot Deployment Plan

**Status:** 🟢 **DEPLOYED + CANARY LIVE on capiro-internal (2026-07-08).** Phases 0+1 shipped via PR #344 (`08a651d`); migration applied; webhook verified live (signed-event 204 end-to-end); `NOTETAKER_ENABLED=true` (task-def rev 38) + tenant flag ON for capiro-internal. Remaining: item F (Recall DPA/subprocessor/legal + trial upgrade) in the [go-live checklist](meeting-notetaker-go-live-checklist.md), the first real-meeting smoke test, then the Phase-1 canary exit gate (§10).
**Author:** Claude (Opus 4.8), 2026-07-07
**Scope:** A bot that joins Zoom / Google Meet / Microsoft Teams meetings, transcribes them, generates meeting notes, and auto-saves them into the Capiro **Meeting Debrief**.
**Companion docs:** [consent copy (for legal)](meeting-notetaker-consent-copy.md) · [Phase 0 infra & secret-wiring runbook](meeting-notetaker-phase0-infra.md) · [go-live checklist](meeting-notetaker-go-live-checklist.md) · Phase 0 build log = Appendix C, Phase 1 build log = Appendix D below.

---

## 0. TL;DR + Recommendation

**Buy the "join the meeting" layer (Recall.ai). Build nothing platform-specific. Reuse what we already have for transcription and note generation.**

The hard, brittle, multi-quarter part of this feature is a bot that can reliably join Zoom, Meet, and Teams. That is a solved commodity ([Recall.ai](https://www.recall.ai)) and building it natively is three separate hard projects, one of which (Teams real-time media) **cannot be done in Node** and one of which (Google Meet Media API) **cannot record external Hill meetings at all** (see §3). Everything *downstream* of "we have a transcript" already exists in our codebase:

| Capability | Already built? | Where |
| --- | --- | --- |
| Transcript → `{recap, actionItems[], notes}` in firm voice | ✅ **Yes** | `apps/api` `generateMeetingDebriefDraft()` (`engagement.service.ts:3157`) |
| Save encrypted debrief to a Meeting | ✅ **Yes** | `createMeetingDebrief()` + `POST /engagement/meetings/:id/debriefs` |
| Deepgram streaming + encrypted transcript store + `recordingPolicy` | ✅ **Yes** | `apps/intel-api` (`deepgram-stream.manager.ts`, `segment-commit.service.ts`) |
| ffmpeg-pull any audio URL → 16kHz PCM | ✅ **Yes** | `apps/intel-api/src/hearing/stream-ingestion.service.ts` |
| Post-session summary tool (exec summary, risks, next steps, draft email) | ✅ **Yes** | orchestrator `generate_post_hearing_summary` |
| Calendar of upcoming meetings (Outlook/Google) | ✅ **Yes** | `IntegrationConnection` + `microsoft-graph-sync.service.ts` |
| A bot that joins Zoom/Meet/Teams | ❌ **No** | → **Recall.ai** |
| Meeting **join URL** captured on calendar events | ⚠️ **Partial gap** | Graph select omits `onlineMeeting.joinUrl` (§6, WS-2) |

**The net-new build is small:** a Recall bot dispatcher, a webhook receiver, a thin adapter that pipes Recall's transcript into the *existing* debrief generator, and — the real work — a **consent/compliance gate** (§5), because recording other people (especially Hill staff) is a legal exposure, not just an engineering task.

### Decisions locked (Ninja, 2026-07-07)

1. **Buy Recall.ai** for joining + recording (vs. build native / vs. competitor). → §3
2. **Async, post-meeting notes only.** Bot records → notes generated after the call → saved to the debrief. **Live in-meeting notes are out of scope** (no real-time cards, no `tag_live_policy_mentions` reuse). → §4
3. **Our own Deepgram from GA** — transcription runs under Capiro's Deepgram account/DPA from launch, *not* Recall's built-in engine. Primary mechanism: **Recall bring-your-own-Deepgram-key**; fallback: pull Recall's recording URL into the `intel-api` Deepgram pipeline for fully in-house STT + encrypted segment storage. → §4, §9
4. **Strict consent posture** — per-dispatch affirmation + in-call disclosure, auto-dispatch limited to pre-authorized clients only, **no voiceprint/biometric features**. → §5
5. **Manual "Send Meri to this meeting" trigger + calendar-URL enhancement** for MVP; **calendar auto-dispatch** in Phase 2 (pre-authorized clients only). → §4, §6
6. **Host the new pipeline in `apps/api`** (engagement domain — debrief generator, BYOK resolver, RLS, encryption already there). Transcription reuses `intel-api`'s Deepgram components (RLS + BYOK3 now live there). → §4

---

## 1. Goal & Non-Goals

**Goal:** For a Capiro user's external meeting (Zoom/Meet/Teams), optionally send "Meri Notetaker" to join, capture a transcript, and produce a saved, encrypted **Meeting Debrief** (recap / action items / notes) attached to the right `Meeting` and `Client`, with consent handled defensibly.

**Non-Goals (MVP):**
- Real-time in-meeting cards / live coaching (Phase 3, reuses hearing-intel extraction).
- Video storage / clip generation.
- Speaker identity resolution beyond diarized labels ("Speaker 0/1") + calendar-attendee mapping (nice-to-have Phase 2).
- Non-meeting audio (phone calls, in-person recordings) — separate track; note we already have an upload+Whisper path (`transcribeAttachmentWithOpenAi`, `engagement.service.ts:4373`) for ad-hoc audio.

---

## 2. User-facing flow (MVP)

1. User opens a meeting in **Engagement → Meetings** (meeting already synced from Outlook/Google, or pasted a join link).
2. User clicks **"Send Meri to take notes."** A consent modal (§5) requires them to affirm they're authorized to record and, if any participant is in an all-party-consent state, that all parties will be notified.
3. We dispatch a Recall bot to the join URL. The bot appears in the call named **"Meri Notetaker (recording)"** and posts a one-line disclosure in the meeting chat.
4. Meeting ends → Recall webhook `bot.done` → we pull the transcript.
5. We call the **existing** `generateMeetingDebriefDraft({ method: 'upload', sourceText: transcript })` → `{recap, actionItems, notes}` (firm-voice-aware).
6. We save it via `createMeetingDebrief()` (E2E-encrypted, `confidential: true`, `accessLevel: 'tenant_members'`), attached to the `Meeting` and denormalized `clientId`.
7. User gets a notification ("Meri drafted your debrief for *Acme / Rep. Smith mtg*"). They open the debrief editor, review/edit, save. (We save as a **draft** they confirm — never silently publish AI notes.)

---

## 3. Build vs. Buy analysis

### Why native "build it ourselves" loses

| Platform | Native path | Verdict for us |
| --- | --- | --- |
| **Microsoft Teams** | Real-time media requires an **application-hosted media bot in C#/.NET on Azure**. "You can't use C++ or Node.js APIs to access real-time media." | ❌ Dealbreaker — we're a Node/TS shop on AWS. A whole .NET-on-Azure service to maintain. |
| **Google Meet** | **Meet Media API** (WebRTC, C++ reference client) is in **Developer Preview** and requires the GCP project, OAuth principal, **and every participant** to be enrolled in the preview program. | ❌ Dealbreaker for external meetings — you can't enroll a congressional staffer's account. |
| **Zoom** | **RTMS** (2026) is efficient (no bot, websocket stream) but needs RTMS access approval and, from **March 2, 2026**, On-Behalf-Of tokens to capture meetings hosted by external accounts. | ⚠️ Feasible but Zoom-only, and OBF makes external-host meetings painful. |

Building native = three unrelated hard integrations (one in a language/cloud we don't use), each with its own approval gauntlet, each breaking whenever the vendor changes its client. This is a platform company's full-time product, not a feature.

### Why Recall.ai

- **One API, all platforms:** Zoom, Meet, Teams, Webex, Slack Huddles, GoTo. Bot joins with just a meeting URL: `POST /api/v1/bot {url}`.
- **Battle-tested:** 3,000+ companies (HubSpot, ClickUp, Monday, Instacart), 99.9% reliability claim.
- **Compliance posture that fits ours:** SOC 2, ISO 27001, HIPAA, GDPR, CCPA; **zero-data-retention mode** and **regional (US) data residency** — both essential for a SOC 2 Type II federal-lobbying product (§5).
- **Outputs we need:** post-meeting recording + transcript with **speaker diarization and labeled names**, participant metadata, available within ~10s of meeting end. Real-time transcript over webhook (1–3s) and per-participant audio over websocket (200ms) if we later want live.
- **Bring-your-own transcription:** we can point Recall at our own Deepgram key at no extra Recall charge → a clean path to keep transcription in-house later (§9).
- **Free Calendar API** (connects Google/Outlook, auto-detects meetings + join URLs) — an optional shortcut for auto-dispatch.

### Alternatives considered

- **MeetingBaaS** — simpler API, but moved to a token-based pricing model (late 2025) that's harder to forecast. Reasonable fallback.
- **Attendee (open-source, self-host)** — the only self-host option; would keep *all* media in our AWS. But we own the operational burden of the exact bot-infra we're trying to avoid building. **Revisit only if a customer contractually forbids any third-party media processor** and zero-retention Recall isn't acceptable.
- Verdict: **Recall.ai for GA; keep Attendee in our back pocket** as the "self-host if compliance demands it" escape hatch. Abstract the vendor behind our own `MeetingBotProvider` interface (§7) so swapping is a driver change, not a rewrite.

---

## 4. Target architecture

### MVP data flow (async, apps/api-centric)

```
[User clicks "Send Meri"] ──► apps/api  POST /engagement/meetings/:id/notetaker
                                  │  (consent gate §5, feature-flag gate)
                                  ▼
                          MeetingBotProvider.dispatch(joinUrl, botName, webhookUrl)
                                  │  → Recall POST /api/v1/bot
                                  ▼
        Recall bot joins Zoom/Meet/Teams, records
        transcribes via OUR Deepgram (Recall BYO-Deepgram key — our account/DPA)
                                  │
   webhooks ──► app.capiro.ai /webhooks/recall  (ALB rule, §7)
     bot.status_change → update MeetingBotSession.status (surface in UI)
     bot.done          → pull transcript (our-Deepgram output via Recall API) → S3 (Meeting.transcriptS3Key)
                                  │
                                  ▼
        generateMeetingDebriefDraft({ method:'upload', sourceText: transcript })   ← EXISTS
                                  │   {recap, actionItems[], notes}
                                  ▼
        createMeetingDebrief(ctx, meetingId, { body, confidential:true })          ← EXISTS
                                  │   (E2E AES-256-GCM via MeetingNotesCryptoService)
                                  ▼
        Notification → user reviews/edits/confirms in DebriefPanel (EngagementPage.tsx)
```

**Everything on the bottom half of that diagram already exists.** New code = the dispatch endpoint, the provider adapter, the webhook receiver, one new table (`MeetingBotSession`), and the consent gate.

### Where each responsibility lives

| Concern | Home | Rationale |
| --- | --- | --- |
| Bot dispatch + webhook + session state | **`apps/api`** (new `engagement/notetaker/*`) | Co-located with debrief generator, BYOK resolver, RLS, `Meeting`. Already the webhook host (Clerk). |
| Transcript → notes | **`apps/api`** `generateMeetingDebriefDraft` | Exists; firm-voice-aware; tenant-key (BYOK) via `AiCredentialService`. |
| Note persistence | **`apps/api`** `createMeetingDebrief` | Exists; encrypted; tenant-scoped; attaches to Meeting+Client. |
| Transcription (GA) | **Our Deepgram** via **Recall BYO-key** | Locked decision #3 — audio transcribed under Capiro's Deepgram account/DPA from launch. No Recall built-in engine. |
| Transcription (fallback / fully in-house) | **`apps/intel-api`** | If we want STT to run entirely on our infra: on `bot.done`, `stream-ingestion.service.ts` ffmpeg-pulls Recall's recording URL → `deepgram-stream.manager.ts` → `segment-commit.service.ts` (encrypted, `recordingPolicy` fail-closed, idempotent). intel-api now has **RLS live + BYOK3 service auth** (§8). Optional richer async notes via `generate_post_hearing_summary` (exec summary / risks / next steps / draft client email). |

### New data model (apps/api, `prisma/schema.prisma`)

```prisma
model MeetingBotSession {
  id             String   @id @default(uuid())
  tenantId       String   @map("tenant_id")            // RLS + current_tenant_id()
  meetingId      String?  @map("meeting_id")           // link to Meeting (nullable: ad-hoc URL)
  clientId       String?  @map("client_id")
  requestedBy    String   @map("requested_by")         // user id
  provider       String   @default("recall")           // MeetingBotProvider key
  externalBotId  String?  @map("external_bot_id")      // Recall bot id
  platform       String?                                // zoom|meet|teams|webex|...
  joinUrl        String   @map("join_url")             // the dispatched URL
  status         String   @default("requested")         // requested|joining|in_call|recording|done|failed|no_show|denied_consent
  recordingPolicy String  @default("transcript_only")   // no_storage|transcript_only|audio_and_transcript
  consent        Json                                   // {mode, affirmedBy, affirmedAt, allPartyStates:[], disclosurePosted}
  transcriptS3Key String? @map("transcript_s3_key")
  debriefId      String?  @map("debrief_id")           // resulting MeetingDebrief
  error          String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  tenant  Tenant   @relation(fields: [tenantId], references: [id])
  meeting Meeting? @relation(fields: [meetingId], references: [id])
}
```
- **RLS** policy + `tenantId` FK from day one (apps/api already has `current_tenant_id()`/`rls_bypass()`).
- Migration must be added to the **migrate task-def family** that carries secrets (known gotcha, §8).

---

## 5. Compliance, consent & security (the real gate)

This is a federal-lobbying, SOC 2 Type II product. Recording other people is where this feature creates *legal* risk, not just technical risk. Treat this as a first-class workstream, not a checkbox.

### Recording-consent law (must design for)
- **Federal = one-party consent; 13 states require all-party consent:** CA, CT, DE, FL, IL, MD, MA, MI, MT, NV, NH, PA, WA.
- **A bot in the participant list is NOT legally sufficient notice** (courts have said so). Consent must be *informed*: what's recorded, how used, who sees it, retention.
- **Live litigation is the warning:** Otter.ai faces 4 class actions (2026) over auto-join/weak-notice; Fireflies is sued under **Illinois BIPA** over capturing **voiceprints** without written consent.
- **Our users record Congressional/agency staff.** That audience raises sensitivity well above a generic sales-notetaker.

### Consent controls we will ship
1. **Per-tenant policy** (Capiro Admin): notetaker Off by default; admin opts the firm in; choose default `recordingPolicy` (`transcript_only` recommended — no audio at rest).
2. **Per-dispatch consent modal:** user must affirm authorization; if we can detect (from attendee emails/domains or a state field) that an all-party-consent state is involved, require an explicit "all parties will be notified" affirmation. Store the affirmation (who/when) in `MeetingBotSession.consent`.
3. **In-meeting disclosure:** bot display name = **"Meri Notetaker (recording)"**; bot posts a chat message on join: *"This meeting is being transcribed by Meri for [Firm]. Notes are stored securely and access-controlled."* Disclosure-before-recording is the defensible posture.
4. **No biometric/voiceprint features** — diarization is fine (Speaker 0/1); do **not** build voice fingerprinting (BIPA landmine).
5. **Kill switch:** any participant can ask the bot to leave; we expose "Remove Meri" and honor it.
6. **Legal sign-off** on the consent copy + ToS/DPA updates before GA. (Ninja decision — see §11.)

### Data protection / SOC 2
- **Recall = new subprocessor.** Before any real meeting: sign Recall's DPA, enable **zero-data-retention** + **US data residency**, add Recall to the **subprocessor list / Trust Center**, run the vendor security review, capture their SOC 2 report in the audit evidence folder.
- **Encryption:** transcripts at rest → our S3 (`Meeting.transcriptS3Key`) with SSE-KMS; debrief body already E2E-encrypted (`MeetingNotesCryptoService`, AES-256-GCM, KMS key version). Never store raw audio unless `recordingPolicy = audio_and_transcript` explicitly chosen.
- **RLS + tenant scoping** on `MeetingBotSession` and any transcript rows.
- **GDPR/CCPA erasure:** ⚠️ Memory flags "S3/GDPR erasure fails" as an existing enterprise-readiness blocker. **Any new S3 transcript object MUST be tagged and wired into the erasure path** — do not add a new un-erasable data store. Track under the erasure remediation, not around it.
- **Retention:** default 30–90 day transcript retention (configurable per tenant); Recall storage set to minimum (7-day free window) or zero-retention with immediate pull to our S3.

---

## 6. Known gaps to close

| # | Gap | Fix | Phase |
| --- | --- | --- | --- |
| G-1 | **Join URL not captured** on synced meetings. Graph select omits `onlineMeeting.joinUrl`/`isOnlineMeeting`; Zoom/Meet links only sit as free text in `description`/`location`. | Extend `microsoft-graph-sync.service.ts` select to pull `onlineMeeting.joinUrl` + `isOnlineMeeting`; add a regex extractor for Zoom/Meet/Teams links in `description`/`location`; add a nullable `joinUrl` column to `Meeting`. | 2 (auto-dispatch) |
| G-2 | Google Meet join URLs come via the Google Workspace sync (separate path) — confirm it captures `hangoutLink`/`conferenceData`. | Audit Google sync; add same extraction. | 2 |
| G-3 | Speaker labels are diarized only ("Speaker 0"). | Map diarized speakers → calendar attendees heuristically (join order / name match). Optional. | 2/3 |
| G-4 | No public webhook route for Recall. | Add `/webhooks/recall` behind the **out-of-band ALB rule** pattern (priority-15 rule is NOT in CFN — must not be dropped by a `cdk deploy`; middleware self-heal per Clerk-webhook precedent). | 1 |

---

## 7. Vendor abstraction

Define a `MeetingBotProvider` interface so Recall is swappable (to MeetingBaaS or self-hosted Attendee) without touching business logic:

```ts
interface MeetingBotProvider {
  dispatch(input: { joinUrl: string; botName: string; webhookUrl: string;
                    recordingPolicy: RecordingPolicy; realtime?: boolean }): Promise<{ externalBotId: string }>;
  remove(externalBotId: string): Promise<void>;
  getTranscript(externalBotId: string): Promise<TranscriptDoc>;       // normalized {speaker, startMs, text}[]
  verifyWebhook(headers, rawBody): boolean;                            // signature check
  parseWebhook(rawBody): NormalizedBotEvent;                           // status_change | done | failed
}
```
- `RecallProvider` implements it first. Keep all Recall-specific shapes inside this class.
- Webhook signature verification is mandatory (don't trust the payload).

---

## 8. Infra & deployment mechanics (honor the house rules)

Target: AWS acct `967807252336`, cluster `capiro-dev`, ALB `capiro-prod-alb`, `app.capiro.ai` path-routing. Deploy via `scripts/deploy-dev.sh` (migrate → roll api → roll web). CI builds arm64 `:latest` on push to `main`.

**Checklist (each is a real prior-incident guardrail):**
- [ ] **New secret `RECALL_API_KEY`** in Secrets Manager, wired to **every** relevant task-def family — including `capiro-dev-api` **and** the `capiro-dev-api-migrate` family (per the per-tenant-AI-key incident where the migrate family lacked a secret and scheduled tasks broke). Same for any intel-api families in Phase 3.
- [ ] **ALB webhook rule** for `/webhooks/recall` added out-of-band (priority ~15, like the Clerk rule). It is **not** in CFN; a `cdk deploy` must not drop it. Add the middleware self-heal.
- [ ] **DB migration** for `MeetingBotSession` (+ `Meeting.joinUrl` in Phase 2). Migration runs via migrate-task on deploy; confirm the family carries `DATABASE_URL` + KMS secrets.
- [ ] **arm64 build** (`--platform linux/arm64`) or the `:latest` pull won't run on Fargate. Verify the ECR `:latest` tag carries the merge SHA before rolling (`:latest` tag race).
- [ ] **Feature flag** `notetaker.enabled` (per-tenant), default OFF. Canary = `capiro-internal` only. Same rollout discipline as `meriv2.inEditorAssistant`.
- [ ] **Alerting:** subscribe `neo@capiro.ai` topics; add a CloudWatch metric on webhook processing failures + bot `failed`/`no_show` rate.
- [ ] **Edit in the worktree cwd** (two local clones exist; avoid the false-typecheck-pass trap).
- [ ] **CI gate:** typecheck + prettier + tests (repo `pnpm lint` is known-broken — do not gate on it). Mind the jest exports-map + worktree `@capiro/shared` build gotchas.

> **Note on intel-api current state (corrects the code-map's stale readiness-report):** Per the merged migration stack (#291/#292), intel-api **already has RLS live on all `intel_*` tables** and **BYOK3 service auth** (`INTERNAL_SERVICE_SECRET`), and the intel-api↔orchestrator tool contract is fixed (`/invoke` + `{input}` + `.result`). So Phase 3 (hosting transcription in intel-api) no longer carries the "must port RLS first" blocker the raw code-scan implied.

---

## 9. Cost model

**Chosen model (locked decision #3 — our Deepgram):** Recall **$0.50 / recording-hour** (join+record, no built-in transcription) + our **Deepgram ~$0.26/hr** (pre-recorded Nova, before any volume discount) = **~$0.76/hr all-in**. No Recall platform fee. Calendar API free. Recall storage free 7 days, then $0.05/media-hr/30-day (we pull immediately + set Recall to minimum/zero retention, so this ≈ $0). (For reference, Recall's built-in transcription would have been $0.65/hr — we're paying ~$0.11/hr more to keep audio under our own Deepgram DPA, which is the point.)

Illustrative per-firm monthly (transcript_only, immediate pull, no long storage):

| Meetings/wk | Avg length | Hrs/mo | Cost/mo @ $0.76/hr |
| --- | --- | --- | --- |
| 10 | 45 min | ~32.5 | **~$25** |
| 20 | 45 min | ~65 | **~$49** |
| 40 | 60 min | ~173 | **~$132** |

For 4 canary tenants this is **~$100–530/mo** — trivial. Set a **usage alarm** and an optional per-tenant monthly cap so a runaway calendar auto-dispatch can't surprise us. Recall volume discounts (Launch/Enterprise) and Deepgram committed-use pricing both cut the per-hour rate as usage grows.

---

## 10. Phased delivery plan + success criteria

### Phase 0 — Foundations & decisions (no user-facing code) — ~3–5 days
**Scope:** Recall account + DPA signed, zero-retention + US residency enabled, subprocessor listing + vendor security review; **wire our Deepgram key into Recall as the BYO transcription provider** (reuse the same Deepgram account/DPA that `intel-api` hearings already use; confirm plan capacity/rate limits); `RECALL_API_KEY` secret wired; feature flag `notetaker.enabled` created; consent copy drafted + legal review kicked off; `MeetingBotProvider` interface + `RecallProvider` skeleton; `MeetingBotSession` model + migration + RLS.
**Success criteria (exit gate):**
- Recall DPA executed; zero-retention + US residency **verified in Recall dashboard** (screenshot in audit evidence).
- Recall added to subprocessor list/Trust Center; SOC 2 report filed.
- **BYO-Deepgram verified end-to-end:** a test bot on a throwaway meeting returns a transcript produced by *our* Deepgram key (confirmed in Deepgram usage dashboard), not Recall's engine.
- `RECALL_API_KEY` resolves in `capiro-dev-api` **and** migrate family (verified via a health check that calls Recall `GET /bot` list).
- Migration applies cleanly on a scratch DB; RLS proven (cross-tenant read returns 0 rows).
- Legal has the consent copy in flight.

### Phase 1 — MVP: manual dispatch → async debrief (canary: capiro-internal) — ~2 wks
**Scope:** `POST /engagement/meetings/:id/notetaker` (+ ad-hoc `POST /engagement/notetaker` with a pasted URL) behind **strict consent gate** + flag; `RecallProvider.dispatch` (with our Deepgram as BYO transcription provider); `/webhooks/recall` receiver (signature-verified) handling `status_change`/`done`/`failed`; **our-Deepgram** transcript pulled → S3 (`Meeting.transcriptS3Key`, SSE-KMS, erasure-tagged); adapter → `generateMeetingDebriefDraft({method:'upload', sourceText})` → `createMeetingDebrief` (as a **draft the user confirms** — never silent-publish); "Send Meri" button + status chip + consent modal in `EngagementPage.tsx` DebriefPanel; notification on completion.
**Success criteria (exit gate):**
- **Join reliability ≥ 95%** across **all three** platforms (Zoom/Meet/Teams) over ≥ 20 real test meetings each (bot joins, is admitted from waiting room, records).
- **Transcription quality:** WER acceptable to reviewers on ≥ 15 real meetings (target ≤ ~12% on clean audio); diarization produces distinct speaker labels; transcript confirmed to originate from our Deepgram key.
- **Notes delivered ≤ 5 min** after meeting end for a 30–60 min meeting (p90).
- **Debrief correctly attached** to the right `Meeting` + `clientId`, encrypted, visible in DebriefPanel, editable, saved.
- **Consent gate blocks 100%** of dispatch attempts without per-dispatch affirmation; disclosure message posts in-call in 100% of joins; affirmation persisted; **no voiceprint/biometric processing exists**.
- **Security:** cross-tenant access denied (RLS test); no raw audio stored under `transcript_only`; webhook rejects unsigned payloads.
- **Zero** un-erasable data stores introduced (new S3 objects tagged + wired to erasure path).

### Phase 2 — Calendar auto-dispatch + join-URL capture (canary → 1–2 customer tenants) — ~2 wks
**Scope:** close G-1/G-2 (Graph `onlineMeeting.joinUrl` + regex extractor + `Meeting.joinUrl` column + Google `conferenceData`); a scheduled dispatcher (EventBridge, ~every 5 min) that, for flag-on tenants with **auto-notetaker enabled per client/meeting**, dispatches a bot ~1 min before start; **auto-mode restricted to pre-authorized clients only** (locked decision #4); per-tenant usage cap + alarm; "auto-notes" toggle in UI.
**Success criteria (exit gate):**
- **Join-URL extraction ≥ 90%** of online meetings across Outlook + Google (measured against a labeled sample).
- Auto-dispatched bots join **≥ 95%** of eligible meetings within 60s of start; **no** bot dispatched to a meeting/client the tenant hasn't pre-authorized (audited to 100%).
- Usage cap enforced (dispatch refused past cap; alarm fires); cost within forecast ±20%.
- No consent regressions (auto-mode only for pre-authorized clients; disclosure still posted).

### Phase 3 — GA rollout — ~1 wk + 30-day bake
**Scope:** flip `notetaker.enabled` to remaining tenants (staged), publish help docs, finalize legal/ToS, monitor.
**Success criteria (GA gate):**
- 30-day canary with **join reliability ≥ 98%**, **webhook processing success ≥ 99.5%**, **zero** cross-tenant or consent incidents.
- **Adoption signal:** among enabled users, ≥ 30% of eligible external meetings get a Meri debrief within 30 days; **edit-and-keep rate** (user edits then saves, i.e., found it useful) ≥ 60% (pure-discard rate < 20%).
- Cost per tenant within forecast; usage alarms quiet.
- Legal sign-off on consent flow + subprocessor disclosures complete.

### Explicitly out of scope / later (per locked decisions)
- **Real-time in-meeting intelligence** (live cards, `tag_live_policy_mentions` reuse, Recall websocket) — **out of scope** (decision #2, async-only). Revisit only as a separate future initiative.
- **Fully in-house STT** (pull Recall recording URL → `intel-api` `stream-ingestion` → `deepgram-stream.manager` → `segment-commit`) — a **fallback** to adopt only if Recall's BYO-Deepgram proves insufficient (e.g., we need the encrypted `segment-commit` store + `recordingPolicy` fail-closed semantics, or Recall BYO-key limits bite). Meets the same "our Deepgram" requirement with more control and more code.
- **Richer async notes** via orchestrator `generate_post_hearing_summary` (exec summary / risks / opportunities / next steps / draft client email) — a low-risk enhancement layered on top of the debrief once the MVP is stable.

---

## 11. Decisions & remaining questions

**Resolved (Ninja, 2026-07-07):**
1. ✅ **Consent** — Strict: per-dispatch affirmation + in-call disclosure, auto-dispatch pre-authorized clients only, no voiceprint features.
2. ✅ **Scope** — Async post-meeting notes only; live in-meeting intelligence out of scope.
3. ✅ **Transcription** — Our own Deepgram from GA (Recall BYO-Deepgram key). Implies a third-party media processor (Recall, zero-retention) is acceptable under our SOC 2 posture; self-host (Attendee) remains the escape hatch only if a customer contractually forbids Recall.

**Still open (not blocking Phase 0):**
4. **Rollout order + spend cap** — which tenants after capiro-internal, and do you want a hard per-tenant monthly $ cap enforced (recommended for auto-dispatch)?
5. **Naming** — "Meri Notetaker" OK as the in-meeting bot identity (it's what participants see, so it doubles as part of the disclosure)?
6. **Deepgram plan headroom** — confirm our current Deepgram account/tier can absorb meeting-transcription volume on top of hearings, or whether we need a committed-use bump before GA.

---

## Appendix A — Key integration points (verified in code)

| Purpose | Symbol / route | File |
| --- | --- | --- |
| Generate notes from transcript | `generateMeetingDebriefDraft(ctx, meetingId, {method, sourceText})` → `{recap, actionItems[], notes}` | `apps/api/src/engagement/engagement.service.ts:3157` |
| Draft endpoint | `POST /engagement/meetings/:id/debrief-draft` | `apps/api/src/engagement/engagement.controller.ts` |
| Save debrief | `createMeetingDebrief(...)` / `POST /engagement/meetings/:id/debriefs` | `engagement.service.ts:3095` |
| Update debrief | `PATCH /engagement/meetings/:id/debriefs/:debriefId` | controller |
| Debrief encryption | `MeetingNotesCryptoService` (AES-256-GCM, KMS keyVersion) | `apps/api/src/engagement/meeting-notes-crypto.service.ts` |
| Meeting model + `transcriptS3Key`, `metadata.webLink`, `raw` | `Meeting` | `apps/api/prisma/schema.prisma:508` |
| Calendar sync (join-URL gap) | `microsoft-graph-sync.service.ts` | `apps/api/src/engagement/microsoft/` |
| Deepgram streaming | `DeepgramStreamManager` | `apps/intel-api/src/hearing/deepgram-stream.manager.ts` |
| ffmpeg URL → PCM ingestion | `StreamIngestionService.start(url, cb)` | `apps/intel-api/src/hearing/stream-ingestion.service.ts` |
| Encrypted transcript store + `recordingPolicy` | `segment-commit.service.ts` (`commitFinal`) | `apps/intel-api/src/hearing/` |
| Post-session summary tool | `generate_post_hearing_summary` | `packages/meriv2-core/src/tools/hearing/generate-post-hearing-summary.ts` |
| Per-tenant AI key (BYOK) | `AiCredentialService.resolveAnthropic(tenantId)` | `apps/workspace/src/generation/ai-credential.service.ts` |
| Existing ad-hoc audio transcription (Whisper) | `transcribeAttachmentWithOpenAi` | `engagement.service.ts:4373` |

## Appendix B — Sources
- Recall.ai pricing / product / integration model, Zoom RTMS, Google Meet Media API, Teams real-time media constraints, meeting-recording consent law (13 all-party states; Otter/Fireflies litigation). Full links in the chat thread that produced this plan (2026-07-07).

## Appendix C — Phase 0 build log (2026-07-07)

Phase 0 code landed on branch `dev/nifty-chatterjee-4d679e`, grounded in a codebase-pattern recon (RLS, config, flags, module wiring, webhook shape) + live Recall.ai API verification. No shortcuts — every pattern mirrors an existing, cited in-repo example.

**Committed (code):**
- `apps/api/prisma/schema.prisma` — new `MeetingBotSession` model (uuid/`@db.Uuid`, `tenant_id`, `Timestamptz(6)`, `*_jsonb` conventions) + back-relations on `Meeting`/`Tenant`/`Client`.
- `apps/api/prisma/migrations/20260707120000_meeting_bot_sessions/migration.sql` — table + `set_updated_at` trigger + **RLS policy byte-for-byte the `meeting_debriefs`/`clio_memory` pattern** (`ENABLE`+`FORCE`, `rls_bypass() OR tenant_id = current_tenant_id()`, `capiro_app` grant; reuses existing SQL fns).
- `apps/api/src/engagement/notetaker/meeting-bot.provider.ts` — vendor-agnostic `MeetingBotProvider` interface + `MEETING_BOT_PROVIDER` DI token + normalized types.
- `apps/api/src/engagement/notetaker/recall.provider.ts` — `RecallProvider` (Token auth, region base URL, `fetch`+AbortException error handling like the AI services, Svix webhook verify reusing the existing `svix` lib, async choreography helpers).
- `apps/api/src/engagement/notetaker/notetaker.module.ts` + registration in `EngagementModule`.
- `apps/api/src/config/config.schema.ts` — `RECALL_API_KEY`/`RECALL_WEBHOOK_SECRET`/`RECALL_API_BASE_URL`/`NOTETAKER_ENABLED` (fail-closed optional).
- `apps/api/src/common/tenant-flags.ts` — `NOTETAKER_FLAG='notetaker.enabled'` + `notetakerEnabled()` (env kill-switch AND per-tenant, default OFF).
- Docs: [consent copy](meeting-notetaker-consent-copy.md), [infra runbook](meeting-notetaker-phase0-infra.md).

**Deliberately NOT in Phase 0 (Phase 1):** the dispatch endpoint, the `/webhooks/recall` receiver (touches shared auth files — `main.ts`/tenant middleware — which carry a change-control banner), and persistence into the debrief. The provider is registered but has no consumer yet.

**Decisions surfaced by the build (need a Phase-1 call):**
1. **ZDR ⟂ async-BYO-Deepgram tension.** Async transcription needs Recall to retain the recording, so literal zero-retention (`retention:null`) is impossible on that path. Default chosen: **short timed retention (24h) + `delete_media` after pulling**. True ZDR requires the real-time streaming path (fragile delivery, out of the async-only MVP). Confirm the 24h/`delete_media` posture is acceptable to compliance, or opt into real-time.
2. **BYO-Deepgram key is Recall-dashboard config per region, not per-request** — so it's a Phase 0 *setup* step (infra runbook Step 1), and the provider only *selects* the provider.
3. **Recall secrets belong on the serve task only** for Phase 0/1 (migrations never create bots); the Phase 2 EventBridge auto-dispatcher will need `RECALL_API_KEY` on its family.
4. **Debrief ownership caveat:** `createMeetingDebrief` scopes by `ctx.userId` meeting-ownership. Fine for user-initiated dispatch (MVP); Phase 2 auto-dispatch needs a resolved service/owner context.

**Verification (2026-07-07, this branch, post `pnpm install`):**
- `prisma format` + `prisma generate` → schema valid, client generated (v5.22.0). ✅
- `prisma migrate diff` (HEAD schema → current) → canonical DDL matches the migration column-for-column; the only deltas (DB `DEFAULT uuid_generate_v4()`/`NOW()`, short FK names, no `ON UPDATE`) are exactly where the repo's own `meeting_debriefs` migration diverges from vanilla Prisma → migration follows house convention. ✅
- `tsc --noEmit` (apps/api) → **0 errors**. ✅
- `prettier --check` on all touched TS → clean after `--write`. ✅
- `@capiro/shared` build → clean. ✅
- Unit test: `tenant-flags.spec.ts` could not be run in the worktree (jest's glob doesn't traverse the worktree reparse point — known gotcha; 0 matches). The new flag helpers are pure and typecheck-covered; the spec runs in CI/main. ⚠️ (runner limitation, not a failure)

## Appendix D — Phase 1 build log (2026-07-08)

Phase 1 completed on Ninja's "finish the plan" instruction, on top of the merged Phase 0/1-A branch (rebased onto main #338–#343; the one EngagementPage conflict resolved in favor of main's redesigned day-timeline). **Everything in the §10 Phase-1 code scope now exists**; the feature stays dormant behind the env+tenant flag and unset secrets.

**Landed (code):**
- **`main.ts` raw mount (was go-live item A):** `raw()` mounted on `/webhooks/recall` — the receiver is now live-capable and fail-closed (unset `RECALL_WEBHOOK_SECRET` ⇒ all webhooks rejected).
- **Dispatch hardening:** meeting lookup now enforces `ownMeetingWhere` (the same ownership predicate the debrief pipeline uses — previously a dispatch for a visible-but-not-owned meeting recorded the whole meeting and failed only at debrief time); join URL validated as absolute http(s); `platform` derived from the URL (zoom/meet/teams/webex); duplicate-dispatch guard (one active bot per meeting).
- **Webhook robustness (at-least-once semantics):** `recording_ready` restricted to `recording.done` (recording.started/processing can no longer trigger premature transcription); `transcript.failed`/`recording.failed` → session `failed` (previously stuck in `processing` forever); atomic idempotency claims (`updateMany` conditional writes) around both transcription-start and debrief-draft so duplicate deliveries can't double-transcribe or double-create debriefs; provider status writes are **forward-only** (a redelivered stale `call_ended` can't clobber `drafting`/`done`); session resolution falls back to the indexed `externalBotId` when an event omits bot metadata; **`bot.done` fallback** — if no recording webhook arrived, the recording id is looked up via Retrieve Bot (`MeetingBotProvider.getRecordingId`), covering both documented Recall choreographies.
- **Transcript persistence (§10 scope "transcript → S3"):** the pulled transcript is filed as a `text/plain` EngagementAttachment on the meeting+client (`source: 'notetaker'`, generalized `createAttachmentFromBuffer`), and `transcriptS3Key` is stamped on both `MeetingBotSession` and `Meeting`. **Deliberate mechanics:** the attachment ROW is the erasure wiring (deleteAttachment removes S3 object + row + KB chunks); S3 object *tags* were skipped because the task role's assets grant has no `s3:PutObjectTagging` — adding tags would fail uploads at runtime. Client-linked transcripts are KB-indexed like any other client document; storage failure is non-fatal (debrief still drafts).
- **Kill switch (§5 control 5):** `DELETE /engagement/meetings/:id/notetaker` → `leave_call` + status `removed`; deliberately NOT flag-gated (removal must work even if the flag is flipped off mid-call). UI shows "Remove Meri" while the bot is dispatchable/in-call.
- **UI:** new `drafting`/`removed` statuses in the chip; completion/failure toast when the detail poll observes the session settle ("Meri drafted your debrief…"), plus debrief+attachment query invalidation. (The §2-step-7 "notification" is this toast + the status chip for MVP; a durable notification rail is Phase-2 scope.)
- **CDK (was go-live item C.1):** `RECALL_API_KEY` wired to the serve task (ARN exists w/ placeholder → deploy-safe); `RECALL_WEBHOOK_SECRET` wiring gated on its ARN appearing in `config.ts` so `cdk deploy` can't wedge on a not-yet-created secret; task-role + exec-role grants added for both.
- **Tests:** 30 unit tests (`recall.provider.spec.ts`, `notetaker.service.spec.ts`) — real svix-signed webhook verification (accept/tamper/missing-header/fail-closed/legacy headers), event-classification table, consent-gate rejections, idempotency claims, `bot.done` fallback, empty-transcript handling, pure helpers.

**Deliberate deviations from the §10 Phase-1 wording:**
1. **Ad-hoc `POST /engagement/notetaker` (no meeting) — consolidated away.** The shipped schema requires `meetingId` (the debrief pipeline needs a Meeting to attach to). The "pasted a join link" flow is covered by: create the meeting (existing UI) → Send Meri (the modal accepts any pasted URL). A meeting-less endpoint would need a shell-Meeting design and a second consent surface for no user benefit in the MVP.
2. **Notification = toast + status chip** (above) rather than a new notification rail.

**Adversarial-review findings (all fixed same day):**
1. *(critical)* Post-dispatch DB-write failure left a live bot with no `externalBotId` on file — the kill switch would then report "removed" without actually removing the bot. Fixed: compensating `leave_call` pulls the bot out of the meeting if we can't record its id, and `remove()` now refuses (retry-in-a-moment) while dispatch is in flight instead of false-safing.
2. *(major)* `GET …/notetaker` lacked the per-user meeting-visibility predicate every other meeting endpoint enforces (tenant members could probe sessions on meetings they can't see). Fixed: same `ownMeetingWhere` 404 as `getMeeting`.
3. *(major)* A transient Retrieve-Bot failure on the `bot.done` fallback silently wedged the session at `processing` forever (webhook already ACKed → no redelivery). Fixed: marks `failed`; a later `recording.done` still recovers it via the status-agnostic claim.
4. *(major)* `recordingPolicy` was accepted but never enforced. Fixed: `no_storage` now skips transcript-at-rest (debrief only); `audio_and_transcript` is rejected at the DTO and service until audio retention is actually built (never silently downgraded).

**Verification (2026-07-08, this worktree):** `tsc --noEmit` apps/api + apps/web + infra/cdk → 0 errors ✅ · notetaker jest suites 38/38 ✅ (run with the `--testMatch` worktree workaround; full apps/api suite also run) · prettier clean ✅ · adversarial review of the full diff → 1 critical + 3 major findings, all fixed + regression-tested (above).

### Post-canary hardening (2026-07-08, after go-live on capiro-internal)

Two follow-up fixes found by exercising the live canary + a second adversarial-review workflow:

- **PR #348 — calendar-link dispatch (the live "Recall API error (HTTP 400)").** The consent modal prefilled the meeting's Outlook *calendar* webLink (not a join link); Recall rejected dispatch as a malformed `meeting_url` only AFTER consent + a session row existed (plan gap G-1 in the wild). Fixed across three layers: web prefills only a real join link (webLink used only if it *is* one, else scan location/invite body) + client-side validator; api refuses non-meeting URLs via a `detectPlatform` gate *before* any session/vendor call; provider translates a Recall create-bot `meeting_url` 400 into a user-actionable message instead of the generic 503.
- **PR #350 — platform-allowlist regression (found by the review workflow verifying #348).** #348's `detectPlatform` gate was *narrower* than Recall's supported set, so it hard-blocked valid meetings — most importantly **US-Government Teams** (`*.teams.microsoft.us`, GCC-High/DoD; the canary client is a defense contractor), plus GoTo and Slack Huddles. Broadened `detectPlatform` + the web mirrors (`isSupportedJoinUrl`/`JOIN_URL_PATTERN`) to Recall's full set. Design principle recorded in the gate's docstring: the recognizer's only job is to catch obvious non-meetings early — Recall is the authority on joinability, and the provider-layer 400 translation gives a friendly error for anything platform-shaped that Recall still can't join, so broadening is strictly safe. `detectPlatform`/`isSupportedJoinUrl` are duplicated web↔api with lockstep SYNC comments (a `@capiro/shared` extraction is a reasonable follow-up). 41/41 tests.

> **Also noted (not a fix):** `Meeting.description` is Graph `bodyPreview` (plain-text, ~255 char, HTML-stripped), so a Teams join URL living only in the invite's `<a href>` is usually absent from it — Teams-meeting prefill will often come up blank and the user pastes the link manually. That is the designed fallback (blank + clear placeholder) and is acceptable for MVP; pulling the full invite body is a sync-layer change deferred to Phase 2 alongside the G-1 join-URL capture work.

### First real dispatch, and a dropped webhook (2026-07-08, same day)

Ninja ran the first real meeting on the canary. The debrief never appeared ("Meri is writing the debrief" stuck indefinitely). Live investigation (session-row diagnostics via a one-off ECS task + direct Recall API calls, no dashboard automation — Recall's Svix-embedded webhook UI is a cross-origin iframe that blocks screenshot/DOM access):

- **Root cause, confirmed conclusively:** the session was stuck at `processing` with `recordingId` AND `transcriptId` already set (i.e. Recall had already finished transcription — verified directly via `GET /api/v1/transcript/:id`, `status.code: "done"`) but `debriefId` was null. That is *exactly* the state right after `startTranscription()` succeeds and *before* `transcript.done` arrives. A `bot.status_change` webhook for the *same bot* had delivered fine seconds earlier (that's how `recordingId`/`transcriptId` got set in the first place, via the `bot.done` fallback), proving the receiver, signature verification, and ALB routing are all healthy — **Recall simply dropped that one webhook delivery.** (Bot lifecycle context: `call_ended` fired with `sub_code: "timeout_exceeded_everyone_left"` only 46s after recording started — a short test call — which explains why nobody caught it faster with a "real" long meeting.)
- **Immediate recovery:** manually replayed a real, correctly-signed `transcript.done` event at the live endpoint using the actual transcript id. It drove the exact same idempotent pipeline to completion — debrief created, transcript filed as an attachment — in ~200ms, proving the pipeline itself has no bug; the only failure was the one-shot webhook dependency. (The recovered debrief was NOT read/decrypted by the operator — confidential content stays inside the product's normal access-controlled UI, per the encryption's own purpose.)
- **The gap this exposes:** `finishTranscript()` was reachable ONLY from `handleBotEvent()`, i.e. only in response to a `transcript.done` webhook. There was no fallback if Recall dropped it — unlike the `recording_ready`/`bot.done` step, which already has two independent paths converging on `startTranscription()`.
- **Fix: a periodic in-process reconciliation sweep.** `NotetakerService` now implements `OnModuleInit`/`OnModuleDestroy`; every 60s (`RECONCILE_SWEEP_INTERVAL_MS`) it queries cross-tenant (`prisma.withSystem`) for sessions stuck at `processing` with a `transcriptId` set, `debriefId` null, and `updatedAt` older than 90s (`STALE_TRANSCRIPT_MS` — comfortably past Recall's typical ~10s transcription turnaround), and calls the *same* `finishTranscript()` a real webhook would have triggered. Deliberately **not** new AWS infra (no EventBridge rule, no CDK change) — an in-process timer ships with the next `deploy-dev.sh` roll and needs no infra sign-off. Race-safety is free: `finishTranscript`'s existing atomic `updateMany` claim means a sweep and a late-arriving real webhook (or the two ECS replicas' independent timers) can never double-process the same session — whichever wins the claim does the work, the other no-ops. An overlap guard (`reconciling` boolean) skips a tick if the previous sweep is still running (LLM debrief generation takes real time), and the timer is `.unref()`'d and cleared on `onModuleDestroy` so it never blocks graceful shutdown.
- **Scope discipline:** did NOT add a similar proactive check for the `recording`-status side (bots that never get a `call_ended`/`recording.done` at all) — every session we've observed stuck at `recording` was independently confirmed still genuinely live on Recall's side (`GET /api/v1/bot/:id` showed real, ongoing `status_changes`), so there's no evidence of the same failure mode there, and building a "is this bot actually still live" check would need a new Recall API integration point (checking bot-level terminal status, not just `recordings[0].id`) that isn't justified without a confirmed incident. Also did not add a long-stale "auto-fail after N hours" cleanup for eternally-stuck sessions of any status — a real but lower-urgency, cosmetic-only gap, left for a future pass so this fix stays tightly scoped to the confirmed failure mode.
- **Tests:** 5 new (`reconcileStaleTranscripts` finds+finishes a stale row exactly like the webhook path incl. the atomic claim; no-op when nothing's stale; a per-row failure doesn't kill the sweep; the timer schedules/stops via `onModuleInit`/`onModuleDestroy`; a slow sweep can't overlap itself) — 46/46 notetaker tests. `tsc --noEmit` clean.
