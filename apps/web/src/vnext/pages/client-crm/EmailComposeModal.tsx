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

/**
 * The ceiling an email attachment must clear to be SENDABLE, mirroring
 * `GRAPH_INLINE_ATTACHMENT_MAX` in apps/api/src/engagement/engagement.service.ts
 * (`loadGraphAttachments`).
 *
 * The upload endpoint itself accepts up to `MAX_ATTACHMENT_BYTES` (25MB) —
 * correctly, because the client/capability Documents flow shares that route.
 * But an email send inlines the bytes into the Graph/Gmail payload, and
 * `loadGraphAttachments` hard-fails ATTACHMENT_TOO_LARGE above this. Without a
 * pre-flight a 10MB PDF uploads, chips in fine, and then the draft simply
 * cannot be sent — the refusal has to land where the user can still act on it.
 *
 * The same 3MB literal also appears in `sendCampaign`, on a deliberately
 * DIVERGENT path that skips an oversized file and reports it via
 * `skippedAttachments` instead of throwing. Reconciling those two behaviours is
 * its own ticket.
 */
const MAX_EMAIL_ATTACHMENT_BYTES = 3 * 1024 * 1024;

/**
 * Content types for the extensions the picker advertises, keyed to the exact
 * strings the server's `ALLOWED_ATTACHMENT_MIME` holds.
 *
 * The browser reports `file.type` as `''` for several of these — .csv, .txt
 * and .docx most often, varying by OS picker — and the old
 * `file.type || 'application/octet-stream'` fallback picked the one value
 * `isAllowedAttachmentContentType` explicitly rejects, so the upload 400'd on a
 * file the server would happily have taken. An `accept` list alone does not fix
 * that; this does.
 */
const EXTENSION_CONTENT_TYPE: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
};

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
  /**
   * Pre-filled Cc — e.g. everyone else who was on the message being replied
   * to. A pre-filled Cc is stated out loud in the window (see the reply-all
   * notice below) rather than left as a text box the user has to notice: this
   * is a widened audience, and on these threads the extra parties are
   * routinely opposing counsel or Hill staff.
   */
  defaultCc?: MailRecipient[];
  /**
   * The caller could not work out which address belongs to the user, so it
   * could not exclude them from the recipients it pre-filled. Renders a short
   * inline notice asking the user to check the recipients.
   *
   * Inline, deliberately, and NOT a toast: this component is rendered by
   * callers that do not necessarily sit under a `CapiroToastProvider`, where
   * `useCapiroToast()` falls back to a no-op and the warning would render
   * nothing at all.
   */
  identityUnconfirmed?: boolean;
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
  defaultCc,
  identityUnconfirmed = false,
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
  // Why the last picked file was refused before it was ever uploaded. Inline
  // rather than a toast so it stays next to the attach control the user just
  // used — and so it is visible at all in the callers that render this modal
  // without a CapiroToastProvider above it.
  const [attachRefusal, setAttachRefusal] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const toKey = to.map((r) => r.email).join(',');
  const defaultCcKey = (defaultCc ?? []).map((r) => r.email).join(',');
  useEffect(() => {
    if (open) {
      const ccEmails = (defaultCc ?? []).map((r) => r.email).join(', ');
      setSelectedTo(to);
      setAddRecipientOpen(false);
      setRecipientSearch('');
      setCcOpen(ccEmails.length > 0);
      setBccOpen(false);
      setCc(ccEmails);
      setBcc('');
      setSubject(defaultSubject ?? '');
      setBodyHtml('');
      setPreRewriteBodyHtml(null);
      setRewriteNote(null);
      setAttachments([]);
      setAttachRefusal(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, toKey, threadId, defaultCcKey]);

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

  // The roster minus the addressee(s) this compose was opened for.
  // `orgContacts` deliberately INCLUDES them — their ids are what `personIds`
  // records on send — so the affordance gates below key off this list rather
  // than the raw roster. Otherwise a person whose client has no other contact
  // on file would grow a "+ Add recipient" button that could only ever say
  // "everyone is already added".
  const otherContacts = useMemo(() => {
    const primary = new Set(to.map((recipient) => recipient.email.toLowerCase()));
    return (orgContacts ?? []).filter((contact) => !primary.has(contact.email.toLowerCase()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgContacts, toKey]);

  // Same upload-url -> S3 -> confirm flow CapabilityDrawerVNext.tsx already
  // uses for document attachments — no new upload plumbing. A freshly
  // uploaded file can still be mid-scan when the user hits Send; that's
  // surfaced honestly as a real send error (loadGraphAttachments'
  // ATTACHMENT_NOT_READY) rather than pretended away, since there's no
  // reliable point at which "scan finished" is guaranteed within a compose
  // window's lifetime.
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const contentType = attachmentContentType(file);
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

  // A pre-filled Cc means this compose was opened as a reply-all. Who is being
  // copied gets said in words above the field: a widened audience must be
  // something the user is TOLD, not something they have to notice in a
  // populated text box. Read off the live field so the notice stays true after
  // the user edits it.
  const ccPrefilled = (defaultCc ?? []).length > 0;
  const ccAddresses = cc
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const ccNotice =
    ccAddresses.length === 0
      ? 'Nobody is copied on this reply.'
      : `Reply all — ${
          ccAddresses.length === 1 ? '1 person is' : `${ccAddresses.length} people are`
        } copied on this reply: ${ccAddresses.join(', ')}`;

  return (
    <CapiroModal open={open} title={threadId ? 'Reply' : 'New email'} onClose={onClose} width={640}>
      <div className="capiro-email-compose">
        {identityUnconfirmed ? (
          <p className="capiro-email-compose__notice capiro-email-compose__notice--warn">
            We could not confirm which address is yours, so nobody was excluded from these
            recipients — check them before sending.
          </p>
        ) : null}

        {/* A <div>, not a <label>: this row holds recipient chips and the
            add-recipient button rather than one form control, and a label
            hands its whole text content to the first button inside it as that
            button's accessible name — and forwards clicks on the row's plain
            text to that button. */}
        <div className="capiro-email-compose__field capiro-email-compose__field--to">
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
            {otherContacts.length > 0 ? (
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
        </div>

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
                otherContacts.length === 0
                  ? 'No other contacts on file for this client'
                  : 'Everyone on file is already added'
              }
              leadingIcon={<DashboardIcon name="Users01" size={16} />}
            />
          </div>
        ) : null}

        {ccPrefilled ? (
          <p className="capiro-email-compose__notice capiro-email-compose__notice--cc">
            {ccNotice}
          </p>
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
                // The same list CapabilityDrawerVNext's file-upload button
                // uses, which is the flow this upload reuses — without it the
                // picker offers types the server's allowlist rejects. It is a
                // hint, not enforcement: `accept` cannot express the
                // allowlist's SVG exclusion, and a user can still pick "All
                // files" in some OS dialogs. Those cases still fail loudly
                // server-side, which keeps the allowlist single-sourced there.
                accept=".pdf,.doc,.docx,.txt,.ppt,.pptx,.xls,.xlsx,.csv,image/*"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (!file) return;
                  setAttachRefusal(null);
                  // Both this gate and the server's are `size > limit`, so
                  // exactly 3MB is fine — hence "3MB or smaller", not
                  // "under 3MB".
                  if (file.size > MAX_EMAIL_ATTACHMENT_BYTES) {
                    setAttachRefusal(
                      `"${file.name}" is ${megabytes(file.size)}MB. Email attachments must be ` +
                        `${megabytes(MAX_EMAIL_ATTACHMENT_BYTES)}MB or smaller — share a link instead.`,
                    );
                    return;
                  }
                  upload.mutate(file);
                }}
              />
            </>
          }
        />

        {attachRefusal ? (
          <p className="capiro-email-compose__notice capiro-email-compose__notice--warn">
            {attachRefusal}
          </p>
        ) : null}

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

/** Whole MB where it divides evenly, one decimal otherwise — for size copy. */
function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? String(mb) : mb.toFixed(1);
}

/**
 * The content type to presign an attachment with. `file.type` when the browser
 * reported one; otherwise inferred from the extension, because
 * 'application/octet-stream' is the one value the server's allowlist
 * explicitly rejects (see EXTENSION_CONTENT_TYPE). An unrecognized extension
 * still falls back to it and still fails loudly server-side, which keeps the
 * allowlist itself single-sourced on the API.
 */
function attachmentContentType(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_CONTENT_TYPE[extension] ?? 'application/octet-stream';
}

function mailErrorMessage(error: unknown, fallback: string): string {
  if (isAxiosError(error)) {
    const message = error.response?.data?.message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}
