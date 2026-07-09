// Shared meeting quick-actions used by BOTH the Engagement Manager
// (EngagementPage) and the dashboard home Client Engagement strip (HomePage):
// Join the online meeting, Send Meri to take notes, and view saved notes. Kept
// in one module so the notetaker CONSENT COPY (compliance-reviewed) and the
// join-link detection live in exactly one place and can't drift between pages.
import { type ReactNode } from 'react';
import { Button, Checkbox, Form, Input, Typography } from 'antd';
import { FileTextOutlined, RobotOutlined, VideoCameraOutlined } from '@ant-design/icons';

// ── Join-link detection ─────────────────────────────────────────────────────
// MUST stay in lockstep with the server gate detectPlatform()
// (apps/api/src/engagement/notetaker/notetaker.service.ts) — covers Recall's
// full supported set incl. US-Gov Teams (*.teams.microsoft.us), GoTo, Slack.
export const JOIN_URL_PATTERN =
  /https:\/\/(?:[\w-]+\.)?(?:zoom\.us|zoomgov\.com)\/[jsw]\/[^\s<>"')\]]+|https:\/\/meet\.google\.com\/[a-z0-9-]+|https:\/\/(?:[\w-]+\.)?teams\.(?:microsoft\.(?:com|us)|live\.com)\/[^\s<>"')\]]+|https:\/\/(?:[\w-]+\.)?webex\.com\/[^\s<>"')\]]+|https:\/\/(?:[\w-]+\.)?(?:goto\.com|gotomeeting\.com)\/[^\s<>"')\]]+|https:\/\/gotomeet\.me\/[^\s<>"')\]]+|https:\/\/app\.slack\.com\/huddle\/[^\s<>"')\]]+/i;

export function isSupportedJoinUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    host === 'zoom.us' ||
    host.endsWith('.zoom.us') ||
    host === 'zoomgov.com' ||
    host.endsWith('.zoomgov.com') ||
    host === 'meet.google.com' ||
    host === 'teams.microsoft.com' ||
    host === 'teams.live.com' ||
    host === 'teams.microsoft.us' ||
    host.endsWith('.teams.microsoft.us') ||
    host === 'webex.com' ||
    host.endsWith('.webex.com') ||
    host === 'goto.com' ||
    host.endsWith('.goto.com') ||
    host === 'gotomeeting.com' ||
    host.endsWith('.gotomeeting.com') ||
    host === 'gotomeet.me' ||
    (host === 'app.slack.com' && url.pathname.includes('/huddle/'))
  );
}

/** Minimal meeting shape needed to derive a join link. */
export interface MeetingJoinInfo {
  location?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Find a real join link for the meeting: webLink only if it IS one (it usually
 * isn't — Outlook's webLink opens the calendar item), then location, then the
 * invite body. Outlook HTML-escapes URLs in the description, so unescape &amp;
 * on the match (Teams links carry query params).
 */
export function extractMeetingJoinUrl(meeting: MeetingJoinInfo): string | null {
  const webLink = typeof meeting.metadata?.webLink === 'string' ? meeting.metadata.webLink : '';
  if (webLink && isSupportedJoinUrl(webLink)) return webLink;
  for (const text of [meeting.location ?? '', meeting.description ?? '']) {
    const match = JOIN_URL_PATTERN.exec(text);
    if (match) return match[0].replace(/&amp;/g, '&');
  }
  return null;
}

/** Open a meeting's online join link in a new tab (no-op if none / unsupported). */
export function openMeetingJoinLink(meeting: MeetingJoinInfo): void {
  const url = extractMeetingJoinUrl(meeting);
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

// ── Quick-action buttons ────────────────────────────────────────────────────
/** Meeting shape MeetingQuickActions needs to gate the buttons. */
export interface MeetingActionInfo extends MeetingJoinInfo {
  endsAt: string;
  debriefs: Array<{ id: string }>;
}

/**
 * Per-meeting quick actions rendered on every meeting-list surface (Engagement
 * list/day/calendar + the dashboard home strip). Each button stops propagation
 * so it doesn't also trigger the row's click. Gating:
 *  - Join / Send Meri: only for meetings that haven't ended AND have a supported
 *    online join link (a bot can only join a real Zoom/Meet/Teams/… URL).
 *  - Notes: only when the meeting already has a saved debrief.
 * Renders nothing when a meeting offers none of these. Callbacks are bound by
 * the caller (which holds the full meeting object).
 */
export function MeetingQuickActions({
  meeting,
  onJoin,
  onSendNotetaker,
  onViewNotes,
}: {
  meeting: MeetingActionInfo;
  onJoin: () => void;
  onSendNotetaker: () => void;
  onViewNotes: () => void;
}) {
  const ended = new Date(meeting.endsAt).getTime() < Date.now();
  const hasNotes = meeting.debriefs.length > 0;
  const canJoinOrRecord = !ended && Boolean(extractMeetingJoinUrl(meeting));
  if (!canJoinOrRecord && !hasNotes) return null;
  return (
    <div
      className="engagement-meeting-quick-actions"
      style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}
    >
      {canJoinOrRecord ? (
        <Button
          size="small"
          icon={<VideoCameraOutlined />}
          onClick={(event) => {
            event.stopPropagation();
            event.preventDefault();
            onJoin();
          }}
        >
          Join
        </Button>
      ) : null}
      {canJoinOrRecord ? (
        <Button
          size="small"
          icon={<RobotOutlined />}
          onClick={(event) => {
            event.stopPropagation();
            event.preventDefault();
            onSendNotetaker();
          }}
        >
          Send Meri
        </Button>
      ) : null}
      {hasNotes ? (
        <Button
          size="small"
          icon={<FileTextOutlined />}
          onClick={(event) => {
            event.stopPropagation();
            event.preventDefault();
            onViewNotes();
          }}
        >
          Notes
        </Button>
      ) : null}
    </div>
  );
}

// ── Notetaker consent form fields (compliance-reviewed copy — SINGLE SOURCE) ──
/**
 * The consent modal's body: intro + the join-URL field + the two required
 * affirmations. Rendered inside each page's own `<Form form={...} onFinish={...}>`
 * (Form.Item binds via context). Field names — meetingUrl / authorizedToRecord /
 * allPartiesWillBeNotified — are the contract the page's onFinish reads.
 *
 * ⚠️ This is the ONE place the consent copy lives. It is compliance-reviewed
 * (docs/plans/meeting-notetaker-consent-copy.md); do not fork it per page.
 */
export function NotetakerConsentFields() {
  return (
    <>
      <Typography.Paragraph type="secondary">
        Meri will join as a visible participant named "Meri Notetaker (recording)", transcribe the
        meeting, and draft a private debrief for your review. A notice is posted in the meeting so
        participants know recording is happening. You're responsible for ensuring you're permitted
        to record this meeting.
      </Typography.Paragraph>
      <Form.Item
        name="meetingUrl"
        label="Meeting join URL"
        extra="The link participants click to join — from the calendar invite body, not the invite itself."
        rules={[
          { required: true, message: 'Paste the meeting join URL.' },
          {
            validator: (_rule, value: string) =>
              !value || isSupportedJoinUrl(value)
                ? Promise.resolve()
                : Promise.reject(
                    new Error(
                      "That doesn't look like a join link — use the Zoom, Teams, Google Meet, Webex, GoTo, or Slack URL from the invite.",
                    ),
                  ),
          },
        ]}
      >
        <Input placeholder="https://zoom.us/j/… · meet.google.com/… · teams.microsoft.com/…" />
      </Form.Item>
      <Form.Item
        name="authorizedToRecord"
        valuePropName="checked"
        rules={[
          {
            validator: (_rule, value: boolean) =>
              value
                ? Promise.resolve()
                : Promise.reject(new Error('Please confirm you are authorized.')),
          },
        ]}
      >
        <Checkbox>I&apos;m authorized to have this meeting transcribed for my firm.</Checkbox>
      </Form.Item>
      <Form.Item
        name="allPartiesWillBeNotified"
        valuePropName="checked"
        rules={[
          {
            validator: (_rule, value: boolean) =>
              value
                ? Promise.resolve()
                : Promise.reject(new Error('Please acknowledge participant notification.')),
          },
        ]}
      >
        <Checkbox>
          I understand participants will be notified, and I&apos;ll obtain any additional consent
          required where participants are located.
        </Checkbox>
      </Form.Item>
    </>
  );
}

// ── Saved-debrief read-only view (for the quick notes modal) ─────────────────
export interface DebriefDraftState {
  recap: string;
  actionItems: string[];
  notes: string;
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 80);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sectionText(body: string, start: string, end?: string): string {
  const startPattern = new RegExp(`(?:^|\\n)${escapeRegExp(start)}\\s*\\n`, 'i');
  const startMatch = body.match(startPattern);
  if (!startMatch || startMatch.index === undefined) return '';
  const contentStart = startMatch.index + startMatch[0].length;
  const rest = body.slice(contentStart);
  if (!end) return rest.trim();
  const endPattern = new RegExp(`\\n${escapeRegExp(end)}\\s*\\n`, 'i');
  const endMatch = rest.match(endPattern);
  return (endMatch?.index === undefined ? rest : rest.slice(0, endMatch.index)).trim();
}

/** Parse the plain-text debrief body into its Recap / Action Items / Notes sections. */
export function parseDebriefBody(body: string): DebriefDraftState {
  const fallback = { recap: body.trim(), actionItems: [], notes: '' };
  if (!body.trim()) return { recap: '', actionItems: [], notes: '' };
  const recap = sectionText(body, 'Recap', 'Action Items');
  const actionItems = sectionText(body, 'Action Items', 'Notes');
  const notes = sectionText(body, 'Notes');
  if (!recap && !actionItems && !notes) return fallback;
  return {
    recap: recap || fallback.recap,
    actionItems: splitLines(actionItems.replace(/^- /gm, '')),
    notes,
  };
}

function NotesBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="engagement-detail-block">
      <Typography.Text strong>{title}</Typography.Text>
      {children}
    </section>
  );
}

/** Read-only render of a saved debrief body (Recap / Action Items / Notes). */
export function DebriefNotesView({ body }: { body: string }) {
  const draft = parseDebriefBody(body);
  return (
    <div className="engagement-debrief-output">
      <NotesBlock title="Recap">
        <Typography.Paragraph>{draft.recap || 'No recap saved.'}</Typography.Paragraph>
      </NotesBlock>
      <NotesBlock title="Action Items">
        {draft.actionItems.length ? (
          <ul className="engagement-bullet-list">
            {draft.actionItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : (
          <Typography.Text type="secondary">No action items saved.</Typography.Text>
        )}
      </NotesBlock>
      <NotesBlock title="Notes">
        <Typography.Paragraph>{draft.notes || 'No notes saved.'}</Typography.Paragraph>
      </NotesBlock>
    </div>
  );
}
