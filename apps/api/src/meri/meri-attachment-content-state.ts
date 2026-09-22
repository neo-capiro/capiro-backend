import { ATTACHMENT_OCR_MAX_PAGES } from './meri-attachment-document.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ResolvedAiCredential } from '../ai-credentials/ai-credential-resolver.service.js';
import { extractMeriDocument } from './meri-attachment-document.js';

export type AttachmentContentState =
  | 'ready'
  | 'partial'
  | 'metadata_only'
  | 'failed'
  | 'pending'
  | 'unsupported';

export interface AttachmentContentDescription {
  state: AttachmentContentState;
  readable: boolean;
  extractedChars: number;
  limitation: string | null;
}

const RETRY_NOTE = 'retry_attempted';

export function attachmentReasonWithoutRetryNote(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const cleaned = reason.replace(/^retry_attempted(?::\s*)?/, '').trim();
  return cleaned || null;
}

export function attachmentRetryAttempted(reason: string | null | undefined): boolean {
  return Boolean(reason?.startsWith(RETRY_NOTE));
}

export function reasonWithAttachmentRetryNote(reason: string | null | undefined): string {
  const detail = attachmentReasonWithoutRetryNote(reason);
  return detail ? `${RETRY_NOTE}: ${detail}`.slice(0, 300) : RETRY_NOTE;
}

export function describeAttachmentContentState(input: {
  status: string;
  textContent?: string | null;
  reason?: string | null;
  kind?: string | null;
  pages?: number | null;
}): AttachmentContentDescription {
  const text = input.textContent?.trim() ?? '';
  const extractedChars = text.length;
  const reason = attachmentReasonWithoutRetryNote(input.reason);

  if (text) {
    if (input.status === 'truncated') {
      return {
        state: 'partial',
        readable: true,
        extractedChars,
        limitation: reason ?? 'Only part of this document is included because it exceeds the reading limit.',
      };
    }
    return { state: 'ready', readable: true, extractedChars, limitation: reason };
  }

  if (input.status === 'failed') {
    return { state: 'failed', readable: false, extractedChars: 0, limitation: reason ?? 'Document extraction failed.' };
  }
  if (input.status === 'pending') {
    return { state: 'pending', readable: false, extractedChars: 0, limitation: reason ?? 'Document extraction is pending.' };
  }
  if (input.status === 'unsupported') {
    return { state: 'unsupported', readable: false, extractedChars: 0, limitation: reason ?? 'This file type is unsupported.' };
  }
  if (input.status === 'scanned' || input.status === 'image_ready' || input.kind === 'image') {
    return {
      state: 'metadata_only',
      readable: false,
      extractedChars: 0,
      limitation: reason ?? `No extractable text; OCR is capped at ${ATTACHMENT_OCR_MAX_PAGES} pages.`,
    };
  }
  return {
    state: 'metadata_only',
    readable: false,
    extractedChars: 0,
    limitation: reason ?? 'No readable extracted text is available.',
  };
}

export async function retryAttachmentExtraction(
  prisma: PrismaService,
  attachmentId: string,
  tenantId: string,
  userId: string,
  resolveCredential: () => Promise<ResolvedAiCredential | null>,
): Promise<AttachmentContentDescription> {
  return prisma.withTenant(tenantId, async (tx) => {
    const row = await tx.clioAttachment.findFirst({
      where: { id: attachmentId, tenantId, userId },
      select: { id: true, kind: true, status: true, textContent: true, reason: true, pages: true, data: true },
    });
    if (!row) throw new Error('Attachment not found');
    const current = describeAttachmentContentState(row);
    if (current.readable || !row.data || attachmentRetryAttempted(row.reason)) return current;
    try {
      const result = await extractMeriDocument({
        bytes: Buffer.from(row.data),
        kind: row.kind as import('./meri-attachment.helpers.js').AttachmentKind,
        tenantId,
        userId,
        resolveCredential,
      });
      const reason = reasonWithAttachmentRetryNote(result.reason);
      await tx.clioAttachment.update({
        where: { id: row.id },
        data: { status: result.status, textContent: result.text, pages: result.pages, reason },
      });
      return describeAttachmentContentState({ ...result, textContent: result.text, reason, kind: row.kind });
    } catch {
      const reason = reasonWithAttachmentRetryNote(row.reason ?? 'Document extraction failed again.');
      await tx.clioAttachment.update({ where: { id: row.id }, data: { status: 'failed', reason } });
      return describeAttachmentContentState({ ...row, status: 'failed', reason });
    }
  });
}
