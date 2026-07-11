// Shared meeting quick-actions used by BOTH the Engagement Manager
// (EngagementPage) and the dashboard home Client Engagement strip (HomePage):
// Join the online meeting, Send Meri to take notes, and view saved notes. Kept
// in one module so the notetaker CONSENT COPY (compliance-reviewed) and the
// join-link detection live in exactly one place and can't drift between pages.
import { type MouseEvent, type ReactNode } from 'react';
import { Button, Checkbox, Form, Input, Tooltip, Typography } from 'antd';
import {
  ExportOutlined,
  FileTextOutlined,
  RobotOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import {
  extractMeetingJoinUrl as extractMeetingJoinUrlShared,
  isSupportedMeetingJoinUrl,
  type MeetingJoinSource,
} from '@capiro/shared';

// ── Join-link detection ─────────────────────────────────────────────────────
// The detection logic now lives in @capiro/shared (the single source of truth,
// shared with the API's sync/dispatch gate) — so the historical "must stay in
// lockstep with the server" hazard is now structurally enforced. These
// re-exports keep the original names so existing importers (EngagementPage,
// HomePage) are unchanged.
export const extractMeetingJoinUrl = extractMeetingJoinUrlShared;
export const isSupportedJoinUrl = isSupportedMeetingJoinUrl;
export type MeetingJoinInfo = MeetingJoinSource;

/** Open a meeting's online join link in a new tab (no-op if none / unsupported). */
export function openMeetingJoinLink(meeting: MeetingJoinSource): void {
  const url = extractMeetingJoinUrl(meeting);
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

// ── Meetings v2 shared action primitives (prototype-matched) ─────────────────
// Small presentational atoms composed by BOTH the redesigned Meetings module
// and the dashboard Client Engagement widget, so the two surfaces can't drift.
// Styling lives in theme.css (.meri-send-btn / .meri-attending-pill /
// .meri-join-link) using the app's tokens, which map 1:1 to the prototype
// (navy pill / accent-soft pill / accent link).

/** Navy filled "Send Meri" pill button (spec §4.3, dashboard parity §8a). */
export function SendMeriButton({
  onClick,
  label = 'Send Meri',
  disabled,
  title,
}: {
  onClick: (event: MouseEvent) => void;
  label?: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="meri-send-btn"
      disabled={disabled}
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        onClick(event);
      }}
    >
      <RobotOutlined />
      <span>{label}</span>
    </button>
  );
}

/** Light-blue "Meri Attending" status pill (shown once a bot is scheduled/attending). */
export function MeriAttendingPill({ label = 'Meri Attending' }: { label?: string }) {
  return (
    <span className="meri-attending-pill">
      <RobotOutlined />
      <span>{label}</span>
    </span>
  );
}

/**
 * Accent-blue "Join" text link with an external-link glyph. Prefers the stored
 * `joinUrl` (Meeting.joinLink), falling back to deriving one from the meeting's
 * free text for pre-migration rows. Renders nothing when no supported join URL
 * exists. Stops click propagation so it never triggers a surrounding row click.
 */
export function JoinLink({
  joinUrl,
  meeting,
}: {
  joinUrl?: string | null;
  meeting?: MeetingJoinSource;
}) {
  const url = joinUrl ?? (meeting ? extractMeetingJoinUrl(meeting) : null);
  if (!url) return null;
  return (
    <a
      className="meri-join-link"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
    >
      <ExportOutlined />
      <span>Join</span>
    </a>
  );
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
 *
 * Semantic colors so the actions read at a glance: Join = green (go/join, the
 * live-meeting convention), Send Meri = brand navy (the Meri feature), Notes =
 * neutral tonal (informational). `compact` renders icon-only buttons with
 * tooltips for tight surfaces (the narrow home dashboard strip); otherwise
 * icon + label for the roomier Engagement views.
 */
export function MeetingQuickActions({
  meeting,
  onJoin,
  onSendNotetaker,
  onViewNotes,
  compact = false,
}: {
  meeting: MeetingActionInfo;
  onJoin: () => void;
  onSendNotetaker: () => void;
  onViewNotes: () => void;
  compact?: boolean;
}) {
  const ended = new Date(meeting.endsAt).getTime() < Date.now();
  const hasNotes = meeting.debriefs.length > 0;
  const canJoinOrRecord = !ended && Boolean(extractMeetingJoinUrl(meeting));
  if (!canJoinOrRecord && !hasNotes) return null;

  const handler =
    (fn: () => void) => (event: { stopPropagation: () => void; preventDefault: () => void }) => {
      event.stopPropagation();
      event.preventDefault();
      fn();
    };

  const actions: Array<{
    key: string;
    label: string;
    icon: ReactNode;
    onClick: () => void;
    color: 'green' | 'primary' | 'default';
    variant: 'solid' | 'filled';
  }> = [];
  if (canJoinOrRecord) {
    actions.push({
      key: 'join',
      label: 'Join',
      icon: <VideoCameraOutlined />,
      onClick: onJoin,
      color: 'green',
      variant: 'solid',
    });
    actions.push({
      key: 'meri',
      label: 'Send Meri',
      icon: <RobotOutlined />,
      onClick: onSendNotetaker,
      color: 'primary',
      variant: 'solid',
    });
  }
  if (hasNotes) {
    actions.push({
      key: 'notes',
      label: 'Notes',
      icon: <FileTextOutlined />,
      onClick: onViewNotes,
      color: 'default',
      variant: 'filled',
    });
  }

  return (
    <div className="engagement-meeting-quick-actions" style={{ display: 'flex', gap: 6 }}>
      {actions.map((action) =>
        compact ? (
          <Tooltip key={action.key} title={action.label}>
            <Button
              size="small"
              color={action.color}
              variant={action.variant}
              icon={action.icon}
              aria-label={action.label}
              onClick={handler(action.onClick)}
            />
          </Tooltip>
        ) : (
          <Button
            key={action.key}
            size="small"
            color={action.color}
            variant={action.variant}
            icon={action.icon}
            onClick={handler(action.onClick)}
          >
            {action.label}
          </Button>
        ),
      )}
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
