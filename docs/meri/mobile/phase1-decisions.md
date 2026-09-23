# Meri iOS Phase 1 product and contract decisions

## Included now

- Authenticated bootstrap with server-derived client options, minimum app/API/event versions, default-off feature availability, and confirmation metadata. The manifest never grants access.
- Hermes durable run start/retry/replay/Stop and approval wrappers. `run_accepted` at durable sequence 1—not the earlier request acknowledgement—is the send acceptance boundary.
- Bounded, cursor-based Meetings list/detail plus conditional meeting, prep, note, and debrief edits. Existing owner, author/admin, encrypted-body, client-wall, and sharing checks remain authoritative.
- Existing attachment presign/confirm/status behavior, including scan readiness and idempotent exact confirmation retry.
- Authenticated APNs token register/revoke lifecycle only. No notification sending is introduced.

## Revised for safety

- Offline drafts may be retained locally, but prompts, meeting edits, approvals, uploads, shares, and notetaker actions must never auto-send after reconnect.
- Meeting-scoped Meri will require a server-validated meeting ID and client scope in a later contract; arbitrary client-supplied context is not accepted as evidence.
- Device notifications, if later enabled, may contain only an opaque run/meeting identifier and a generic message. They must never contain client names, meeting subjects, prompts, note/debrief text, or model output.

## Deferred pending product/design sign-off

- Post-creation attendee editing and its calendar-provider reconciliation semantics.
- Meeting cancellation/deletion and privacy behavior.
- Meeting-scoped chat entry and full parity for confirmation/citation UI.
- Combined sharing/delivery actions and any new side effects beyond existing audited web operations.
- Calendar search semantics beyond the bounded canonical Meetings window.
- Voice memos, device recording, microphone permission, recording consent, and visible/audible indicators.
- Product-only Figma matrix sign-off, official logo treatment, and iOS visual implementation.

These deferred items are not represented as completed Phase 1 behavior.
