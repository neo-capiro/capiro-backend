# Meri Notetaker — Consent & Disclosure Copy (DRAFT for legal review)

**Status:** DRAFT — not yet legally reviewed. Do not ship user-facing until counsel signs off.
**Owner:** Ninja + counsel. **Author:** Claude, 2026-07-07. **Related:** [meeting-notetaker-bot-plan.md](meeting-notetaker-bot-plan.md) §5.

> **Why this exists.** For a federal-lobbying product whose users record calls with Hill/agency staff, recording consent is a legal exposure, not UX polish. Federal law is one-party consent, but **13 states require all-party consent** (CA, CT, DE, FL, IL, MD, MA, MI, MT, NV, NH, PA, WA). Courts have held that a bot merely appearing in the participant list is **not** legally sufficient notice — consent must be *informed*. Live 2026 litigation (Otter.ai class actions; Fireflies BIPA voiceprint suit) targets exactly weak-notice / auto-join / biometric practices. Our posture (locked): **strict** — per-dispatch affirmation, in-call disclosure before recording, auto-dispatch for pre-authorized clients only, and **no voiceprint/biometric features**.

---

## 1. In-meeting bot identity
- **Display name in the participant list:** `Meri Notetaker (recording)` — the "(recording)" suffix is deliberate; the name itself is part of the notice.
- The bot must **not** be silent/hidden. It joins visibly and posts the disclosure below.

## 2. In-meeting disclosure message (bot posts to meeting chat on join)
> **Meri Notetaker** is transcribing this meeting for **{{firmName}}** to prepare a private debrief. The transcript is stored securely and access-controlled; no audio is retained. If you'd prefer we not record, say so and the host can remove this notetaker at any time.

Posted:
- **On join**, before any transcript is committed, in every meeting, on every platform (Zoom/Meet/Teams chat).
- Where a platform blocks bot chat, fall back to the display-name notice + a verbal-reminder prompt in the requesting user's pre-meeting checklist.

## 3. Per-dispatch consent modal (shown to the Capiro user who clicks "Send Meri")
**Title:** Send Meri to take notes?

**Body:**
> Meri will join **{{meetingSubject}}** as a visible participant named "Meri Notetaker (recording)," transcribe the conversation, and draft a private debrief for your review. A notice is posted in the meeting so participants know recording is happening.
>
> You are responsible for ensuring you're permitted to record this meeting.

**Required checkboxes (dispatch is blocked until both are checked):**
1. ☐ I'm authorized to have this meeting transcribed for my firm.
2. ☐ I understand participants will be notified, and I'll obtain any additional consent required where participants are located.

**Conditional escalation (shown when an all-party-consent state is detected among attendees/organizer — by email domain, saved contact location, or an explicit "location unknown" fallback):**
> ⚠️ One or more participants may be in a state that requires **everyone's** consent to record ({{detectedStates}}). Confirm all participants will be told recording is happening **before** the conversation begins.
>
> 3. ☐ I confirm all-party consent will be obtained for this meeting.

**Buttons:** `Cancel` · `Send Meri` (disabled until required boxes checked).

**Persisted on dispatch** (`MeetingBotSession.consent`): `{ mode, affirmedByUserId, affirmedAt, allPartyStatesFlagged: [], disclosurePosted: bool }`.

## 4. Tenant admin opt-in copy (Capiro Admin → notetaker settings)
> **Meeting Notetaker.** When enabled, your firm's users can send Meri to join and transcribe their online meetings, and Meri will draft debriefs automatically. Recording is always disclosed to participants, and no voiceprints or biometric data are ever collected. You are responsible for your firm's compliance with applicable recording-consent laws.
>
> - Notetaker: `Off` / `On`
> - Default recording policy: `Transcript only (no audio stored)` [recommended] / `Audio + transcript`
> - Automatic notetaker for meetings with **pre-authorized clients only**: `Off` / `On`

## 5. Auto-dispatch guardrail copy (per-client authorization)
Auto-dispatch (Phase 2) is **opt-in per client**, never firm-wide-silent:
> ☐ Automatically send Meri to online meetings for **{{clientName}}**. Meri will announce itself and post the recording notice in each meeting.

## 6. Hard product rules (enforced in code, not just copy)
- Dispatch is **blocked** unless the per-dispatch affirmation is persisted.
- The in-meeting disclosure MUST be posted before the first transcript segment is committed; if disclosure fails to post, log it and surface a warning on the resulting debrief.
- Auto-dispatch only for clients with an explicit per-client authorization on record.
- **No voiceprint / speaker-identification-by-biometrics.** Diarization = anonymous labels ("Speaker 1") mapped only to calendar attendees, never to a stored voice fingerprint.
- Any participant/host can remove the bot; we honor removal immediately and stop committing transcript.
- Default `recordingPolicy = transcript_only` (no audio at rest) unless the tenant explicitly opts into audio storage.

## 7. Questions for counsel (the review this doc kicks off)
1. Is the in-meeting chat disclosure + visible "(recording)" name + per-dispatch affirmation sufficient for **one-party-consent** meetings? For **all-party-consent** meetings, is our escalation checkbox enough, or do we need an affirmative in-meeting acknowledgment from participants?
2. Do we need a **verbal** disclosure requirement (not just chat text) for any state?
3. Recording **government employees / Congressional staff** — any lobbying-specific, ethics, or FOIA/records considerations beyond wiretap law?
4. Confirm diarization-without-voiceprints keeps us clear of **BIPA** and comparable biometric statutes (IL/TX/WA).
5. Required updates to our **ToS / privacy policy / DPA** and the **subprocessor disclosure** (adding Recall.ai) before GA.
6. Retention default (proposed 30–90 days, tenant-configurable) — any legal floor/ceiling?
7. Do we need a documented mechanism for a participant to request **deletion** of a transcript they're in (ties to the open GDPR/CCPA erasure work)?
