# Live Hearing — Consent, Recording & Disclosure Language

Date: 2026-06-29
Owner: Capiro (Neo Martinez, CTO)
Status: DRAFT — engineering-authored starting language. NOT legal advice; have counsel review
before production use. This file is the source of the consent/disclosure strings the Live
Hearing Room renders and the policy the `consent_status` / `recording_policy` fields enforce.

---

## 0. Why this exists

Live Hearing captures audio and produces transcripts. Some captures are of **public proceedings**
(congressional hearings, markups — already public record) and some are of **non-public meetings**
(client calls, agency meetings, roundtables) where **federal and state wiretap / two-party-consent
laws may apply**. Recording a conversation without required consent can be a crime in some states
and creates civil liability. The product must default to the safe posture and force an explicit
decision before capturing anything non-public.

Legal baseline (informational, confirm with counsel):
- Federal law (18 U.S.C. § 2511) permits one-party consent.
- ~11+ states require **all-party (two-party) consent** (incl. CA, FL, IL, MD, MA, PA, WA, etc.).
- Capiro cannot know every participant's location, so for non-public meetings it must obtain and
  record affirmative all-party consent rather than assume one-party suffices.

---

## 1. Source-type → default consent posture (enforced in code)

| `source_type` | Public record? | Default `consent_status` | Capture allowed without action? |
|---|---|---|---|
| `hearing` | Yes (congressional) | `not_required` | Yes |
| `markup` | Yes (congressional) | `not_required` | Yes |
| `webinar` | Usually public/announced | `needs_review` | No — confirm |
| `agency_session` | Often non-public | `needs_review` | No — confirm |
| `meeting` | Non-public | `needs_review` | No — confirm |

Rule: `start_live_transcription` is BLOCKED while `consent_status = needs_review`. The user must
move it to `confirmed` (attesting consent was obtained) before capture starts. Public
congressional `hearing`/`markup` default to `not_required` because they are already public record.

---

## 2. In-app strings (render verbatim in the Live Hearing Room)

### 2.1 Public hearing/markup banner (consent_status = not_required)
> **Public proceeding.** This is a public congressional proceeding on the public record. Capiro
> is generating a working transcript and intelligence notes for your firm's internal use. Always
> verify quotes against the official transcript before external use.

### 2.2 Non-public capture — consent gate (blocks start until confirmed)
> **Consent required before recording.**
> You are about to capture audio of a non-public meeting. Recording laws vary by state, and some
> require the consent of **every** participant. Before you begin:
>
> 1. Confirm you have a lawful basis to record this meeting, and
> 2. Obtain the consent of all participants where required by the laws applicable to them.
>
> By selecting **"I confirm consent has been obtained,"** you attest that you have met these
> requirements. Capiro records this attestation, the time, and the confirming user in the
> compliance audit log. Capiro does not provide legal advice; consult your compliance officer or
> counsel if you are unsure.
>
> ☐ I confirm consent has been obtained from all required parties.
> [ Start capture ]   [ Cancel ]

### 2.3 Suggested verbal disclosure (shown to the user to READ ALOUD at meeting start)
> "Before we begin, I want to let everyone know I'm using a transcription tool to take notes for
> our team. It captures a transcript of this conversation. Is everyone comfortable proceeding on
> that basis?"

(If anyone objects → user must Cancel; do not capture.)

### 2.4 Recording-policy selector (what is stored)
> **What should Capiro keep?**
> - **Transcript only** (default) — keep the text transcript; the audio is never stored.
> - **Audio + transcript** — keep both the audio recording and the transcript.
> - **No storage** — live notes only; nothing is saved after the session ends.

---

## 3. `recording_policy` semantics (enforced at the storage layer, not UI)

| Policy | Audio persisted | Transcript persisted | Notes |
|---|---|---|---|
| `no_storage` | No | No | Live captions stream to UI and vanish; only session metadata kept |
| `transcript_only` (default) | **No** | Yes (encrypted) | Raw audio never written to disk/object store |
| `audio_and_transcript` | Yes (tenant-scoped, SSE) | Yes (encrypted) | Both retained per retention policy |

Enforcement lives in `SegmentCommitService` — the policy gates writes in code; a UI bug cannot
cause audio to be stored when policy says it must not.

---

## 4. Data handling commitments (reflect in privacy posture)

- Client-relevant transcript text is **encrypted at rest** (AES-256-GCM, same scheme as
  `meeting_debriefs`).
- Transcripts are **tenant-scoped**; no cross-tenant access. Extracted intelligence flows only to
  the tenant's own knowledge graph (tenant_members-only), never shared.
- Every consent attestation, recording-policy choice, and transcript access is written to the
  **compliance/audit store** with user + timestamp.
- Deepgram is the sub-processor for speech-to-text. Audio is streamed for transcription; confirm
  Deepgram's data-retention/zero-retention setting matches Capiro's commitment (see recommendation
  in the handoff). Disclose Deepgram as a sub-processor in the Capiro DPA / privacy policy.

---

## 5. Audit-log fields (compliance store, per session)

- `sessionId`, `tenantId`, `createdBy` (user)
- `consentStatus` transitions (needs_review → confirmed) with timestamp + confirming user
- `recordingPolicy` selected
- `verbalDisclosureAcknowledged` (boolean — did the user check that they read the disclosure)
- transcript access events (who viewed/exported, when)

---

## 6. Open legal questions to route to counsel (do not block 5b dev)

1. Confirm the all-party-consent state list and whether Capiro should hard-block capture by
   detected participant location vs. rely on user attestation.
2. Deepgram sub-processor disclosure + DPA language.
3. Retention period for `audio_and_transcript` captures.
4. Whether `webinar` should default to `not_required` (often public/announced) or stay
   `needs_review`. Drafted conservatively as `needs_review`.
