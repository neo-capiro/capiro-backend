/**
 * Meri notetaker consent copy — compliance-reviewed
 * (docs/plans/meeting-notetaker-consent-copy.md). ⚠️ SINGLE SOURCE: this is
 * the ONE place the consent wording lives. Do not fork or reword it per page.
 *
 * Extracted verbatim (UI-free) from `meeting-actions.tsx`'s
 * NotetakerConsentFields so that BOTH renderers of the consent form — the
 * canonical AntD `NotetakerConsentFields` (app.capiro.ai) and the vNext
 * `VNextSendMeriModal` (os.capiro.ai, which may not import antd) — consume
 * the identical strings. Rendered text is unchanged on both surfaces.
 */
export const NOTETAKER_CONSENT_COPY = {
  intro:
    'Meri will join as a visible participant named "Meri Notetaker (recording)", transcribe the meeting, and draft a private debrief for your review. A notice is posted in the meeting so participants know recording is happening. You\'re responsible for ensuring you\'re permitted to record this meeting.',
  meetingUrlLabel: 'Meeting join URL',
  meetingUrlExtra:
    'The link participants click to join — from the calendar invite body, not the invite itself.',
  meetingUrlPlaceholder: 'https://zoom.us/j/… · meet.google.com/… · teams.microsoft.com/…',
  meetingUrlRequired: 'Paste the meeting join URL.',
  meetingUrlInvalid:
    "That doesn't look like a join link — use the Zoom, Teams, Google Meet, Webex, GoTo, or Slack URL from the invite.",
  authorizedRequired: 'Please confirm you are authorized.',
  authorizedLabel: "I'm authorized to have this meeting transcribed for my firm.",
  notifiedRequired: 'Please acknowledge participant notification.',
  notifiedLabel:
    "I understand participants will be notified, and I'll obtain any additional consent required where participants are located.",
} as const;
