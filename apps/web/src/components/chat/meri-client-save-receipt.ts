import type { PendingApproval } from './useMeriChatController.js';

export interface MeriClientSaveReceipt {
  status: 'saved' | 'pending' | 'partial' | 'failed' | 'unconfirmed';
  label: string;
  summary: string;
  files: Array<{
    name: string;
    status: 'saved' | 'pending' | 'failed';
    reason: string | null;
    location: string | null;
  }>;
  location: string | null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Old receipts used Documents. Open the saved file in the client's canonical Files tab. */
function documentLocation(value: unknown, clientId: string, documentId: string): string | null {
  if (typeof value !== 'string' || !value.startsWith('/clients?')) return null;
  try {
    const url = new URL(value, 'https://capiro.invalid');
    if (
      url.origin !== 'https://capiro.invalid' ||
      url.pathname !== '/clients' ||
      url.searchParams.getAll('clientId').length !== 1 ||
      url.searchParams.get('clientId') !== clientId ||
      url.searchParams.getAll('tab').length !== 1 ||
      !['documents', 'files'].includes(url.searchParams.get('tab') ?? '') ||
      url.searchParams.getAll('attachmentId').length > 1 ||
      (url.searchParams.has('attachmentId') && url.searchParams.get('attachmentId') !== documentId) ||
      url.hash
    )
      return null;
    return `/clients?${new URLSearchParams({ clientId, tab: 'files', attachmentId: documentId })}`;
  } catch {
    return null;
  }
}

/** Render persisted write receipts; executing or merely proposed actions never count as saved. */
export function clientSaveReceipt(proposal: PendingApproval): MeriClientSaveReceipt | null {
  if (proposal.tool !== 'save_note' && proposal.tool !== 'save_chat_attachments') return null;
  if (
    !['succeeded', 'failed_retryable', 'failed_terminal', 'outcome_unknown'].includes(
      proposal.status,
    )
  )
    return null;
  const raw = object(proposal.resultSummary);
  const note = object(raw.note);
  const clientId =
    text(raw.clientId) ?? (proposal.tool === 'save_note' ? text(note.clientId) : null);
  const clientName = text(raw.clientName);
  const target = clientId && clientName
    ? proposal.tool === 'save_note' && !text(raw.documentId)
      ? ` under ${clientName}`
      : ` in ${clientName}’s Files`
    : '';
  const unconfirmed: MeriClientSaveReceipt = {
    status: 'unconfirmed',
    label: 'Save not confirmed',
    summary: 'The save result could not be confirmed. Check the client records before retrying.',
    files: [],
    location: null,
  };
  if (proposal.status === 'outcome_unknown') return unconfirmed;
  if (raw.tool !== proposal.tool) return unconfirmed;

  if (proposal.tool === 'save_note') {
    const status = raw.status;
    const documentId = text(raw.documentId);
    if (
      (status !== 'saved' && status !== 'pending' && status !== 'failed') ||
      !text(note.id) ||
      !('clientId' in note) ||
      (raw.clientId !== undefined && raw.clientId !== note.clientId) ||
      (note.clientId !== null && !text(note.clientId)) ||
      (documentId && documentId !== note.id) ||
      (status !== 'saved' && (!documentId || !clientId))
    )
      return unconfirmed;
    const label = {
      saved: 'Note saved',
      pending: 'Note processing',
      failed: 'Note filing failed',
    }[status];
    const detail = text(raw.message);
    return {
      status,
      label,
      summary: `${label}${target}.${detail ? ` ${detail}` : ''}`,
      files: [],
      location:
        status === 'saved' && documentId && clientId
          ? documentLocation(raw.location, clientId, documentId)
          : null,
    };
  }

  if (!clientId) return unconfirmed;
  if (!Array.isArray(raw.files) || !raw.files.length) return unconfirmed;
  const files: MeriClientSaveReceipt['files'] = [];
  for (const entry of raw.files) {
    const file = object(entry);
    const name = text(file.fileName) ?? 'Unavailable attachment';
    const status = file.status;
    const documentId = text(file.documentId);
    if (
      !text(file.attachmentId) ||
      !['saved', 'pending', 'failed'].includes(String(status)) ||
      (status !== 'failed' && !documentId)
    )
      return unconfirmed;
    files.push({
      name,
      status: status as 'saved' | 'pending' | 'failed',
      reason: text(file.reason),
      location: status === 'saved' && documentId
        ? documentLocation(file.location, clientId, documentId)
        : null,
    });
  }
  const saved = files.filter((file) => file.status === 'saved').length;
  const pending = files.filter((file) => file.status === 'pending').length;
  const failed = files.filter((file) => file.status === 'failed').length;
  const status = failed ? (saved || pending ? 'partial' : 'failed') : pending ? 'pending' : 'saved';
  if (raw.status !== status && !(raw.status === 'partial' && status === 'pending' && saved > 0))
    return unconfirmed;
  const label = {
    saved: 'Files saved',
    pending: 'Processing files',
    partial: 'Partially saved',
    failed: 'Files not saved',
  }[status];
  return {
    status,
    label,
    files,
    location: null,
    summary: `${saved} saved, ${pending} processing, ${failed} failed${target}.${failed ? ' Retry the failed files; saved files will not be duplicated.' : ''}`,
  };
}
