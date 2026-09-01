import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { isAxiosError } from 'axios';
import { extractMeetingJoinUrl, isSupportedMeetingJoinUrl } from '@capiro/shared';
import { NOTETAKER_CONSENT_COPY } from '../../../pages/engagement/notetaker-consent-copy.js';
import { useDispatchNotetaker } from '../../../pages/engagement/meetings/meetings-api.js';
import { MeriGlyph } from '../../../pages/engagement/meetings/meetings-ui.js';
import type { Meeting } from '../../../pages/engagement/meetings/meetings-types.js';
import { EngagementDialog } from '../../../pages/engagement/meetings/EngagementDialog.js';
import { useCapiroToast } from '../../components/feedback/toast.js';

/**
 * "Send Meri to take notes?" — the vNext (os.capiro.ai) renderer of the
 * consent form. The canonical `SendMeriModal` builds this form on AntD
 * (`Form` + the AntD `NotetakerConsentFields`), which may not render on the
 * vNext surface, so this variant rebuilds the same form on the
 * EngagementDialog shell's own field primitives (`engagement-dialog__field`)
 * and native checkboxes. Everything behavioral is identical to the canonical
 * modal:
 *
 *   - the compliance-reviewed consent COPY comes verbatim from the shared
 *     single source (`notetaker-consent-copy.ts`) — never forked or reworded;
 *   - the join-URL validation is the same `isSupportedMeetingJoinUrl` from
 *     `@capiro/shared` the canonical form (and the API's dispatch gate) uses,
 *     with the same required/invalid messages;
 *   - the dispatch call (`useDispatchNotetaker`, POST with meetingId /
 *     meetingUrl / both affirmations / joinAt) and the "Send Meri" gating
 *     (disabled until BOTH boxes are checked) are unchanged;
 *   - the success toast text is the canonical one, via `useCapiroToast`
 *     instead of AntD `message`.
 *
 * One deliberate presentation addition: a dispatch failure surfaces through
 * EngagementDialog's inline `error` slot (the canonical AntD modal left that
 * rejection silent — dialog stayed open with no feedback).
 */

/**
 * `dispatch()` (notetaker.service.ts) throws a specific, actionable
 * BadRequestException/ForbiddenException for every gate it checks — tenant
 * not enabled, unsupported join URL, a notetaker already assigned, etc. Show
 * that real reason instead of a one-size-fits-all string whenever the API
 * actually sent one.
 */
function notetakerErrorMessage(error: unknown): string {
  if (isAxiosError(error)) {
    const message = error.response?.data?.message;
    if (typeof message === 'string' && message) return message;
  }
  return 'Could not send Meri. Try again.';
}

export function VNextSendMeriModal({
  meeting,
  open,
  onClose,
}: {
  meeting: Meeting | null;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useCapiroToast();
  const dispatch = useDispatchNotetaker();

  const [meetingUrl, setMeetingUrl] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [notified, setNotified] = useState(false);
  const [urlTouched, setUrlTouched] = useState(false);

  useEffect(() => {
    if (open && meeting) {
      setMeetingUrl(meeting.joinLink ?? extractMeetingJoinUrl(meeting) ?? '');
      setAuthorized(false);
      setNotified(false);
      setUrlTouched(false);
      dispatch.reset();
    }
    // Same reset contract as the canonical modal's form.setFieldsValue effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, meeting]);

  // Same two rules, same order, same messages as the canonical AntD field —
  // which (like every AntD Form.Item) validates on change, so the message is
  // computed live and shown once the field has been touched or submitted.
  const urlError = !meetingUrl
    ? NOTETAKER_CONSENT_COPY.meetingUrlRequired
    : !isSupportedMeetingJoinUrl(meetingUrl)
      ? NOTETAKER_CONSENT_COPY.meetingUrlInvalid
      : null;

  const ready = Boolean(authorized && notified);

  const submit = async () => {
    if (!meeting) return;
    if (urlError) {
      setUrlTouched(true);
      return;
    }
    try {
      await dispatch.mutateAsync({
        meetingId: meeting.id,
        meetingUrl,
        authorizedToRecord: authorized,
        allPartiesWillBeNotified: notified,
        joinAt: meeting.startsAt,
      });
      toast.success('Meri is joining this meeting.');
      onClose();
    } catch {
      // Surfaced inline via the dialog's error slot below.
    }
  };

  const consentCheckboxStyle = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 9,
    fontSize: 12.5,
    fontWeight: 400,
    lineHeight: 1.5,
    color: 'var(--ink-1, #101828)',
    cursor: 'pointer',
    margin: '0 0 10px',
  } as const;

  return (
    <EngagementDialog
      open={open && meeting != null}
      eyebrow="Meeting · compliance"
      title="Send Meri to take notes"
      description={meeting?.subject}
      width={520}
      busy={dispatch.isPending}
      busyLabel="Scheduling Meri…"
      error={dispatch.isError ? notetakerErrorMessage(dispatch.error) : null}
      dirty={Boolean(authorized || notified)}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" disabled={dispatch.isPending} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-accent"
            disabled={!ready || dispatch.isPending}
            onClick={() => void submit()}
          >
            <MeriGlyph size={16} tone="invert" />
            {dispatch.isPending ? 'Sending…' : 'Send Meri'}
          </button>
        </>
      }
    >
      <div
        style={{
          display: 'flex',
          gap: 9,
          padding: '10px 12px',
          marginBottom: 16,
          // Send-with-Meri panel — the assistant tier (WARM-SURFACE-PALETTE.md),
          // not the generic sunken fill.
          background: 'var(--eng-surface-assistant, #fffdfa)',
          borderRadius: 8,
        }}
      >
        <Lock size={14} style={{ color: 'var(--ink-3, #667085)', marginTop: 2, flexShrink: 0 }} />
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink-1, #101828)' }}>
            Private until you share it
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--ink-3, #667085)' }}>
            You can share these notes with your organization at any time from the meeting panel.
          </div>
        </div>
      </div>

      <p style={{ margin: '0 0 14px', fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink-3, #667085)' }}>
        {NOTETAKER_CONSENT_COPY.intro}
      </p>

      <label className="engagement-dialog__field" style={{ marginBottom: 14 }}>
        {NOTETAKER_CONSENT_COPY.meetingUrlLabel}
        <input
          value={meetingUrl}
          placeholder={NOTETAKER_CONSENT_COPY.meetingUrlPlaceholder}
          disabled={dispatch.isPending}
          aria-invalid={Boolean(urlTouched && urlError)}
          onChange={(event) => {
            setMeetingUrl(event.target.value);
            setUrlTouched(true);
          }}
        />
        {urlTouched && urlError ? (
          <span style={{ fontSize: 11.5, fontWeight: 400, color: 'var(--eng-error, #b42318)' }}>
            {urlError}
          </span>
        ) : (
          <small>{NOTETAKER_CONSENT_COPY.meetingUrlExtra}</small>
        )}
      </label>

      <label style={consentCheckboxStyle}>
        <input
          type="checkbox"
          checked={authorized}
          disabled={dispatch.isPending}
          onChange={(event) => setAuthorized(event.target.checked)}
          style={{ marginTop: 2, flexShrink: 0 }}
        />
        <span>{NOTETAKER_CONSENT_COPY.authorizedLabel}</span>
      </label>
      <label style={{ ...consentCheckboxStyle, margin: 0 }}>
        <input
          type="checkbox"
          checked={notified}
          disabled={dispatch.isPending}
          onChange={(event) => setNotified(event.target.checked)}
          style={{ marginTop: 2, flexShrink: 0 }}
        />
        <span>{NOTETAKER_CONSENT_COPY.notifiedLabel}</span>
      </label>
    </EngagementDialog>
  );
}
