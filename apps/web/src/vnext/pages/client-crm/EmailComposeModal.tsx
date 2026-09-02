import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { useApi } from '../../../lib/use-api.js';
import { CapiroModal } from '../../components/overlays/index.js';
import { CapiroButton } from '../../components/actions/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { SettingsRichTextEditor } from '../settings/SettingsRichTextEditor.js';
import {
  getEmailSignature,
  rewriteEmail,
  sendSingleMail,
  type MailRecipient,
} from './mail-api.js';
import './email-compose-modal.css';

/**
 * The compose window Jordan asked for — reachable from a Timeline email row
 * and from the person drawer's "Mail" button, always the same component so
 * both entry points behave identically. Pops up centered (`CapiroModal`),
 * not as a side drawer.
 *
 * Body editing reuses `SettingsRichTextEditor` (the signature editor's own
 * component — bold/italic/underline, sanitized) rather than a new WYSIWYG.
 * Sending goes through `POST /api/engagement/mail/send`
 * (`EngagementService.sendSingleMail`), which appends the user's real
 * Settings signature server-side — this component never edits or duplicates
 * that HTML, only previews it read-only so sending isn't a surprise.
 */

export interface EmailComposeModalProps {
  open: boolean;
  onClose: () => void;
  /** Pre-filled recipient — the person or correspondent this compose was opened for. */
  to: MailRecipient;
  recipientTitle?: string;
  clientId?: string;
  clientName?: string;
  personId?: string;
  /** Reply within an existing thread instead of starting a new one. */
  threadId?: string;
  defaultSubject?: string;
  /** Fires after a confirmed send so callers can invalidate their own queries. */
  onSent?: () => void;
}

export function EmailComposeModal({
  open,
  onClose,
  to,
  recipientTitle,
  clientId,
  clientName,
  personId,
  threadId,
  defaultSubject,
  onSent,
}: EmailComposeModalProps) {
  const api = useApi();
  const toast = useCapiroToast();

  const [ccOpen, setCcOpen] = useState(false);
  const [bccOpen, setBccOpen] = useState(false);
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState(defaultSubject ?? '');
  const [bodyHtml, setBodyHtml] = useState('');
  const [preRewriteBodyHtml, setPreRewriteBodyHtml] = useState<string | null>(null);
  const [rewriteNote, setRewriteNote] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setCcOpen(false);
      setBccOpen(false);
      setCc('');
      setBcc('');
      setSubject(defaultSubject ?? '');
      setBodyHtml('');
      setPreRewriteBodyHtml(null);
      setRewriteNote(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, to.email, threadId]);

  const signatureQ = useQuery({
    enabled: open,
    queryKey: ['me', 'email-signature'],
    queryFn: () => getEmailSignature(api),
    staleTime: 60_000,
  });

  const rewrite = useMutation({
    mutationFn: () =>
      rewriteEmail(api, {
        rawText: bodyHtml,
        recipientName: to.name ?? undefined,
        recipientTitle,
        clientName,
      }),
    onSuccess: (result) => {
      setPreRewriteBodyHtml(bodyHtml);
      setBodyHtml(result.bodyHtml);
      setRewriteNote(
        result.verified
          ? null
          : "Meri's rewrite couldn't be fully verified against your notes, so this is your original text, unrewritten.",
      );
    },
    onError: (error) => toast.error(mailErrorMessage(error, 'Could not rewrite this draft')),
  });

  const send = useMutation({
    mutationFn: () =>
      sendSingleMail(api, {
        clientId,
        personId,
        to,
        cc: parseRecipients(cc),
        bcc: parseRecipients(bcc),
        subject: subject.trim(),
        bodyHtml,
        threadId,
      }),
    onSuccess: () => {
      toast.success('Email sent');
      onSent?.();
      onClose();
    },
    onError: (error) => toast.error(mailErrorMessage(error, 'Could not send this email')),
  });

  const canSend = Boolean(to.email) && subject.trim().length > 0 && stripHtml(bodyHtml).length > 0;

  return (
    <CapiroModal open={open} title={threadId ? 'Reply' : 'New email'} onClose={onClose} width={640}>
      <div className="capiro-email-compose">
        <label className="capiro-email-compose__field">
          <span className="capiro-email-compose__label">To</span>
          <span className="capiro-email-compose__static">
            {to.name ? `${to.name} <${to.email}>` : to.email}
          </span>
          <span className="capiro-email-compose__ccbcc-links">
            {!ccOpen ? (
              <button type="button" onClick={() => setCcOpen(true)}>Cc</button>
            ) : null}
            {!bccOpen ? (
              <button type="button" onClick={() => setBccOpen(true)}>Bcc</button>
            ) : null}
          </span>
        </label>

        {ccOpen ? (
          <label className="capiro-email-compose__field">
            <span className="capiro-email-compose__label">Cc</span>
            <input
              className="capiro-email-compose__input"
              value={cc}
              placeholder="name@example.com, another@example.com"
              onChange={(event) => setCc(event.target.value)}
            />
          </label>
        ) : null}
        {bccOpen ? (
          <label className="capiro-email-compose__field">
            <span className="capiro-email-compose__label">Bcc</span>
            <input
              className="capiro-email-compose__input"
              value={bcc}
              placeholder="name@example.com"
              onChange={(event) => setBcc(event.target.value)}
            />
          </label>
        ) : null}

        <label className="capiro-email-compose__field">
          <span className="capiro-email-compose__label">From</span>
          {/* The exact connected address is only resolved server-side at
              send time (findCampaignSendConnection) — there's no read
              endpoint for it here, so this names the mechanism rather than
              guessing an address the backend might resolve differently. */}
          <span className="capiro-email-compose__static">Your connected mailbox (Settings → Personal)</span>
        </label>

        <label className="capiro-email-compose__field">
          <span className="capiro-email-compose__label">Subject</span>
          <input
            className="capiro-email-compose__input"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="Subject"
          />
        </label>

        <SettingsRichTextEditor
          value={bodyHtml}
          onChange={setBodyHtml}
          placeholder="Write your notes, or a full message — then Rewrite with Meri to polish rough notes into a coherent email."
          variant="email"
        />

        {rewriteNote ? <p className="capiro-email-compose__rewrite-note">{rewriteNote}</p> : null}

        {preRewriteBodyHtml != null ? (
          <button
            type="button"
            className="capiro-email-compose__undo-rewrite"
            onClick={() => {
              setBodyHtml(preRewriteBodyHtml);
              setPreRewriteBodyHtml(null);
              setRewriteNote(null);
            }}
          >
            Undo rewrite
          </button>
        ) : null}

        {signatureQ.data?.enabled && signatureQ.data.html ? (
          <div className="capiro-email-compose__signature-preview">
            <span className="capiro-email-compose__label">Signature (added automatically)</span>
            <div
              className="capiro-email-compose__signature-html"
              // Server-sanitized on save (sanitizeSignatureHtml) — the same
              // HTML the Settings signature editor itself renders back.
              dangerouslySetInnerHTML={{ __html: signatureQ.data.html }}
            />
          </div>
        ) : null}
      </div>

      <div className="capiro-email-compose__footer">
        <CapiroButton
          variant="secondary"
          size="standard"
          loading={rewrite.isPending}
          disabled={stripHtml(bodyHtml).length === 0 || send.isPending}
          onClick={() => rewrite.mutate()}
        >
          Rewrite with Meri
        </CapiroButton>
        <span className="capiro-email-compose__footer-spacer" />
        <CapiroButton variant="secondary" size="standard" disabled={send.isPending} onClick={onClose}>
          Cancel
        </CapiroButton>
        <CapiroButton
          variant="primary"
          size="standard"
          loading={send.isPending}
          disabled={!canSend || rewrite.isPending}
          onClick={() => send.mutate()}
        >
          Send
        </CapiroButton>
      </div>
    </CapiroModal>
  );
}

function parseRecipients(value: string): MailRecipient[] | undefined {
  const emails = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return emails.length ? emails.map((email) => ({ email })) : undefined;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}

function mailErrorMessage(error: unknown, fallback: string): string {
  if (isAxiosError(error)) {
    const message = error.response?.data?.message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}
