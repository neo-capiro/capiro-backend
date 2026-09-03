import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { Paperclip } from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import { CapiroModal } from '../../components/overlays/index.js';
import { CapiroButton } from '../../components/actions/index.js';
import { Combobox, type ComboboxOption } from '../../components/fields/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { DashboardIcon } from '../../components/untitledui/dashboard-icons.js';
import { SettingsRichTextEditor } from '../settings/SettingsRichTextEditor.js';
import {
  getEmailSignature,
  rewriteEmail,
  sendSingleMail,
  type MailRecipient,
} from './mail-api.js';
import './email-compose-modal.css';

/** A person this compose window could add as a "To" recipient. */
export interface EmailComposeContact {
  id: string;
  name: string;
  email: string;
}

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
  /** Pre-filled recipient(s) — who this compose was opened for. */
  to: MailRecipient[];
  recipientTitle?: string;
  clientId?: string;
  clientName?: string;
  /**
   * Everyone else this compose can add to "To" — e.g. the client's org
   * roster, so a lobbyist can send to more than one person on the team
   * without leaving the compose window. Omit to hide the add-recipient
   * affordance entirely (the Timeline reply flow has no such roster handy).
   */
  orgContacts?: EmailComposeContact[];
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
  orgContacts,
  threadId,
  defaultSubject,
  onSent,
}: EmailComposeModalProps) {
  const api = useApi();
  const toast = useCapiroToast();

  const [selectedTo, setSelectedTo] = useState<MailRecipient[]>(to);
  const [addRecipientOpen, setAddRecipientOpen] = useState(false);
  const [recipientSearch, setRecipientSearch] = useState('');
  const [ccOpen, setCcOpen] = useState(false);
  const [bccOpen, setBccOpen] = useState(false);
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState(defaultSubject ?? '');
  const [bodyHtml, setBodyHtml] = useState('');
  const [preRewriteBodyHtml, setPreRewriteBodyHtml] = useState<string | null>(null);
  const [rewriteNote, setRewriteNote] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Array<{ id: string; fileName: string }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const toKey = to.map((r) => r.email).join(',');
  useEffect(() => {
    if (open) {
      setSelectedTo(to);
      setAddRecipientOpen(false);
      setRecipientSearch('');
      setCcOpen(false);
      setBccOpen(false);
      setCc('');
      setBcc('');
      setSubject(defaultSubject ?? '');
      setBodyHtml('');
      setPreRewriteBodyHtml(null);
      setRewriteNote(null);
      setAttachments([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, toKey, threadId]);

  // Contacts not already selected — and searchable, since an org roster on a
  // large client account can run long.
  const addableContacts = useMemo<ComboboxOption[]>(() => {
    const selectedEmails = new Set(selectedTo.map((r) => r.email.toLowerCase()));
    const q = recipientSearch.trim().toLowerCase();
    return (orgContacts ?? [])
      .filter((c) => !selectedEmails.has(c.email.toLowerCase()))
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q))
      .map((c) => ({ value: c.id, label: c.name, meta: c.email }));
  }, [orgContacts, selectedTo, recipientSearch]);

  // Same upload-url -> S3 -> confirm flow CapabilityDrawerVNext.tsx already
  // uses for document attachments — no new upload plumbing. A freshly
  // uploaded file can still be mid-scan when the user hits Send; that's
  // surfaced honestly as a real send error (loadGraphAttachments'
  // ATTACHMENT_NOT_READY) rather than pretended away, since there's no
  // reliable point at which "scan finished" is guaranteed within a compose
  // window's lifetime.
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const contentType = file.type || 'application/octet-stream';
      const presigned = (
        await api.post<{ url: string; fields: Record<string, string>; s3Key: string }>(
          '/api/engagement/attachments/upload-url',
          { clientId, fileName: file.name, contentType, contentLength: file.size },
        )
      ).data;
      const form = new FormData();
      Object.entries(presigned.fields).forEach(([key, value]) => form.append(key, value));
      form.append('file', file);
      const s3Res = await fetch(presigned.url, { method: 'POST', body: form });
      if (!s3Res.ok) throw new Error('Upload to storage failed');
      return (
        await api.post<{ id: string; fileName: string }>('/api/engagement/attachments/confirm', {
          clientId,
          fileName: file.name,
          contentType,
          s3Key: presigned.s3Key,
          source: 'email-compose',
        })
      ).data;
    },
    onSuccess: (attachment) => setAttachments((current) => [...current, attachment]),
    onError: (error) => toast.error(mailErrorMessage(error, 'Could not attach that file')),
  });

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
        // The AI rewrite just needs a sense of tone/audience — the first
        // recipient is a reasonable stand-in even when there are several.
        recipientName: selectedTo[0]?.name ?? undefined,
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
    mutationFn: () => {
      const personIds = selectedTo
        .map((r) => orgContacts?.find((c) => c.email.toLowerCase() === r.email.toLowerCase())?.id)
        .filter((id): id is string => Boolean(id));
      return sendSingleMail(api, {
        clientId,
        personIds: personIds.length ? personIds : undefined,
        to: selectedTo,
        cc: parseRecipients(cc),
        bcc: parseRecipients(bcc),
        subject: subject.trim(),
        bodyHtml,
        threadId,
        attachmentIds: attachments.length ? attachments.map((a) => a.id) : undefined,
      });
    },
    onSuccess: () => {
      toast.success('Email sent');
      onSent?.();
      onClose();
    },
    onError: (error) => toast.error(mailErrorMessage(error, 'Could not send this email')),
  });

  const canSend = selectedTo.length > 0 && subject.trim().length > 0 && stripHtml(bodyHtml).length > 0;

  return (
    <CapiroModal open={open} title={threadId ? 'Reply' : 'New email'} onClose={onClose} width={640}>
      <div className="capiro-email-compose">
        <label className="capiro-email-compose__field capiro-email-compose__field--to">
          <span className="capiro-email-compose__label">To</span>
          <span className="capiro-email-compose__to-chips">
            {selectedTo.map((recipient) => (
              <span key={recipient.email} className="capiro-email-compose__chip">
                <span className="capiro-email-compose__chip-name">
                  {recipient.name ? `${recipient.name} <${recipient.email}>` : recipient.email}
                </span>
                {selectedTo.length > 1 ? (
                  <button
                    type="button"
                    className="capiro-email-compose__chip-remove"
                    aria-label={`Remove ${recipient.name ?? recipient.email}`}
                    onClick={() =>
                      setSelectedTo((current) => current.filter((r) => r.email !== recipient.email))
                    }
                  >
                    ×
                  </button>
                ) : null}
              </span>
            ))}
            {orgContacts && orgContacts.length > 0 ? (
              <button
                type="button"
                className="capiro-email-compose__add-recipient"
                onClick={() => setAddRecipientOpen((current) => !current)}
              >
                + Add recipient
              </button>
            ) : null}
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

        {addRecipientOpen ? (
          <div className="capiro-email-compose__field capiro-email-compose__add-recipient-row">
            {/* Everyone on this client's org tree (Relationships → Organization)
                not already in "To" — so a lobbyist can loop in more than one
                person on the team without leaving this window. This row
                itself stays open after a pick (Combobox closes its own
                dropdown on select, same as everywhere else it's used) — one
                more click on it reopens the list, already missing whoever
                was just added, ready for the next. */}
            <Combobox
              value={undefined}
              onChange={(option) => {
                const contact = orgContacts?.find((c) => c.id === option.value);
                if (!contact) return;
                setSelectedTo((current) => [...current, { email: contact.email, name: contact.name }]);
                setRecipientSearch('');
              }}
              options={addableContacts}
              placeholder="Search this client's contacts…"
              searchValue={recipientSearch}
              onSearchChange={setRecipientSearch}
              searchPlaceholder="Search by name or email…"
              emptyMessage={
                (orgContacts?.length ?? 0) === 0
                  ? 'No other contacts on file for this client'
                  : 'Everyone on file is already added'
              }
              leadingIcon={<DashboardIcon name="Users01" size={16} />}
            />
          </div>
        ) : null}

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
          extraToolbarActions={
            <>
              <button
                type="button"
                className="stv-rte-btn"
                title="Attach a file"
                aria-label="Attach a file"
                disabled={upload.isPending}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip size={15} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) upload.mutate(file);
                }}
              />
            </>
          }
        />

        {attachments.length > 0 ? (
          <div className="stv-rte-attachments">
            {attachments.map((attachment) => (
              <span key={attachment.id} className="stv-rte-attachment">
                <span className="stv-rte-attachment-name">{attachment.fileName}</span>
                <button
                  type="button"
                  className="stv-rte-attachment-remove"
                  aria-label={`Remove ${attachment.fileName}`}
                  onClick={() =>
                    setAttachments((current) => current.filter((a) => a.id !== attachment.id))
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}

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
          disabled={!canSend || rewrite.isPending || upload.isPending}
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
