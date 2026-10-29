import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { nativeCanonicalSha256 } from './native-approvals/native-approval.contract.js';

/**
 * Native `save_note` action boundary.
 *
 * Owner facts this contract is derived from (not re-implemented here):
 *  - MeriToolsService.saveNote is the canonical owner. It has three destinations:
 *    a meeting note (two non-atomic writes: EngagementService.createMeetingNote
 *    then a ClioNote row), a client Files document (MeriClientFilingService.saveNote,
 *    idempotency-keyed), and a true General ClioNote (tenant/user bound, single write).
 *  - policy-pack declares `internal_artifacts.pass` for save_note, so the static
 *    decision is PASS and the action executes ONCE directly. This contract therefore
 *    never asks for approval and never presents a WARN approval adapter.
 *  - The proposal ledger's generic transient classification may call a lost or
 *    partial note effect `failed_retryable`. A retry would duplicate a General or
 *    meeting note, so note actions are re-classified: an ambiguous or lost effect is
 *    UNKNOWN with read-only recovery, while a provably pre-effect refusal stays definite.
 */
export const NOTE_ACTION = 'save_note';
export const NOTE_ACTION_SCOPE_KEY = '__meriNoteActionScope';
export const NOTE_ACTION_MAX_BYTES = 65536;
export const NOTE_BODY_MAX_CHARS = 40000;
export const NOTE_TITLE_MAX_CHARS = 160;

const uuid = z
  .string()
  .uuid()
  .regex(/^[a-f0-9-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => text(max).optional();

/**
 * The closed native note request. Body is required and bounded exactly as the
 * canonical owner bounds it. `conversationId` is deliberately absent: the current
 * attended owner supplies it so a caller cannot re-attribute the note to another
 * conversation. No model authority, source, memory or project fields are accepted.
 */
export const noteRequestSchema = z
  .object({
    body: z.string().min(1).max(NOTE_BODY_MAX_CHARS),
    title: optionalText(NOTE_TITLE_MAX_CHARS),
    clientId: uuid.optional(),
    meetingId: uuid.optional(),
    confidential: z.boolean().optional(),
    accessLevel: optionalText(80),
  })
  .strict();
export type NoteRequest = z.infer<typeof noteRequestSchema>;

export const noteSelectionSchema = z
  .object({ conversationId: uuid, selectedClientId: uuid.nullable() })
  .strict();
export const noteScopeSchema = noteSelectionSchema
  .extend({
    identityRevision: digest,
    membershipRevision: digest,
    contextRevision: digest,
  })
  .strict();
export type NoteScope = z.infer<typeof noteScopeSchema>;
/**
 * A write may bind the caller's expected current authority all-or-nothing. A
 * partial binding is rejected outright rather than compared against undefined.
 */
export const notePrepareContextSchema = z.union([noteSelectionSchema, noteScopeSchema]);

export interface NoteActionAccess {
  scope: NoteScope;
  mode: 'execute' | 'observe';
  clientIds: readonly string[];
  assertCurrent(): Promise<void>;
}

export const isNoteAction = (tool: string) => tool === NOTE_ACTION;

/**
 * The ledger stores the same request plus the owner-supplied attended
 * conversation. Reads, receipts and the claim guard therefore accept — and
 * discard — exactly that one extra field.
 */
const canonicalNoteRequestSchema = noteRequestSchema
  .extend({ conversationId: uuid.optional() })
  .strict();

function normalizeNote(input: unknown): NoteRequest {
  const parsed = noteRequestSchema.safeParse(input);
  if (!parsed.success) throw new BadRequestException('Invalid note action');
  const body = parsed.data.body.trim();
  if (!body || body.length > NOTE_BODY_MAX_CHARS)
    throw new BadRequestException('Notes must be at most 40,000 characters');
  const request: NoteRequest = {
    ...parsed.data,
    body,
    ...(parsed.data.title ? { title: parsed.data.title } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > NOTE_ACTION_MAX_BYTES)
    throw new BadRequestException('Invalid note action');
  return request;
}

/** Caller-facing validation of a closed note request. */
export function noteRequest(tool: string, input: unknown): NoteRequest {
  if (!isNoteAction(tool)) throw new BadRequestException('Invalid note action');
  return normalizeNote(input);
}

/** Owner-stored request validation: identical, but tolerates the bound conversation. */
export function noteCanonicalRequest(tool: string, input: unknown): NoteRequest {
  if (!isNoteAction(tool)) throw new BadRequestException('Invalid note action');
  const parsed = canonicalNoteRequestSchema.safeParse(input);
  if (!parsed.success) throw new BadRequestException('Invalid note action');
  const { conversationId: _conversationId, ...rest } = parsed.data;
  return normalizeNote(rest);
}

/** Immutable body correlation. The body itself never enters a receipt or history. */
export const noteBodyHash = (body: string) =>
  nativeCanonicalSha256({ body, length: body.length });

/**
 * Public request view for reads and typed history: the exact immutable request
 * identity without the private body text.
 */
export function noteActionRequest(input: unknown) {
  const request = noteCanonicalRequest(NOTE_ACTION, input);
  return {
    tool: NOTE_ACTION,
    bodyHash: noteBodyHash(request.body),
    bodyLength: request.body.length,
    title: request.title ?? null,
    clientId: request.clientId ?? null,
    meetingId: request.meetingId ?? null,
    confidential: request.confidential ?? null,
    accessLevel: request.accessLevel ?? null,
  };
}

export function noteActionFingerprint(tool: string, input: Record<string, unknown>, scope?: NoteScope) {
  return isNoteAction(tool) ? { ...input, [NOTE_ACTION_SCOPE_KEY]: scope } : input;
}

export function publicNoteActionPreview(preview: Record<string, unknown>) {
  const { [NOTE_ACTION_SCOPE_KEY]: _scope, ...rest } = preview;
  return rest;
}

export function readNoteScope(preview: unknown) {
  const result = noteScopeSchema.safeParse(
    (preview as Record<string, unknown> | null)?.[NOTE_ACTION_SCOPE_KEY],
  );
  if (!result.success) throw new ForbiddenException('Note proposal scope unavailable');
  return result.data;
}

/**
 * Current-authority assertion for a note action. Mirrors the other native action
 * boundaries: real conversation, execute mode for a write, and — when the note
 * targets a client or meeting — that client must be inside the caller's current
 * visible roster and match their selected client.
 */
export async function assertNoteActionAccess(
  access: NoteActionAccess | undefined,
  conversationId: string | null | undefined,
  tool: string,
  input: unknown,
  preview?: unknown,
  terminalObservation = false,
  readOnly = false,
) {
  const scope = noteScopeSchema.safeParse(access?.scope);
  const request = noteCanonicalRequest(tool, input);
  if (
    !access ||
    !scope.success ||
    typeof access.assertCurrent !== 'function' ||
    scope.data.conversationId !== conversationId ||
    (!readOnly && access.mode !== 'execute')
  )
    throw new ForbiddenException('Current note action access required');
  if (
    request.clientId !== undefined &&
    ((scope.data.selectedClientId !== null && request.clientId !== scope.data.selectedClientId) ||
      !access.clientIds.includes(request.clientId))
  )
    throw new ForbiddenException('Current note action access required');
  if (preview !== undefined) {
    const stored = readNoteScope(preview);
    const compare = (value: NoteScope) =>
      terminalObservation ? { ...value, membershipRevision: null } : value;
    if (nativeCanonicalSha256(compare(stored)) !== nativeCanonicalSha256(compare(scope.data)))
      throw new ForbiddenException('Note proposal authority changed');
  }
  await access.assertCurrent();
  return scope.data;
}

export type NoteDestination = 'meeting' | 'client_document' | 'general';
/** Truthful readiness. A pending/quarantined document is never reported as ready or indexed. */
export type NoteReadiness = 'ready' | 'indexing' | 'indexed' | 'private' | 'scanning' | 'unavailable';

export type NoteReceipt =
  | {
      destination: 'meeting';
      noteId: string;
      meetingNoteId: string;
      meetingNoteStatus: string | null;
      confidential: boolean | null;
      accessLevel: string | null;
      readiness: 'ready';
      bodyHash: string;
      generatedAt: string | null;
    }
  | {
      destination: 'client_document';
      noteId: string;
      documentId: string;
      location: string;
      indexingStatus: 'indexed' | 'pending' | 'not_indexed' | null;
      reused: boolean;
      readiness: Exclude<NoteReadiness, 'ready' | 'indexed' | 'private'> | 'indexed' | 'private';
      bodyHash: string;
      generatedAt: string | null;
    }
  | {
      destination: 'general';
      noteId: string;
      clientId: null;
      readiness: 'ready';
      bodyHash: string;
      generatedAt: string | null;
    };

const optionalString = (value: unknown, max = 400) =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * Canonical owner receipt. Derived only from what the owner actually returned:
 * destination, exact persisted ids, the canonical link, readiness and the body
 * hash. No indexed/completed/navigation claim is invented, and no body text is
 * retained. A result that carries an identity but contradicts the request is
 * untrusted and raises `receipt unavailable` so the caller records UNKNOWN
 * instead of a success or a retry.
 */
export function noteActionReceipt(tool: string, raw: unknown, input: unknown): NoteReceipt | null {
  const request = noteCanonicalRequest(tool, input);
  const value = record(raw);
  const note = record(value.note);
  const noteId = optionalString(note.id, 100);
  const bodyHash = noteBodyHash(request.body);
  const generatedAt = optionalString(value.generatedAt, 60);
  const meeting = value.meetingNote === null || value.meetingNote === undefined
    ? null
    : record(value.meetingNote);
  const meetingNoteId = meeting ? optionalString(meeting.id, 100) : null;
  const documentId = optionalString(value.documentId, 100);
  const status = optionalString(value.status, 40);

  if (!noteId) return null;
  // The persisted body must be the exact body this request carried.
  if (typeof note.body === 'string' && noteBodyHash(note.body) !== bodyHash)
    throw new ServiceUnavailableException('Saved-note receipt unavailable');

  if (meetingNoteId) {
    if (request.meetingId === undefined)
      throw new ServiceUnavailableException('Saved-note receipt unavailable');
    return {
      destination: 'meeting',
      noteId,
      meetingNoteId,
      meetingNoteStatus: meeting ? optionalString(meeting.status, 40) : null,
      confidential: typeof meeting?.confidential === 'boolean' ? meeting.confidential : null,
      accessLevel: meeting ? optionalString(meeting.accessLevel, 80) : null,
      readiness: 'ready',
      bodyHash,
      generatedAt,
    };
  }

  if (documentId) {
    const location = optionalString(value.location, 400);
    // The canonical Files link must address the exact persisted document.
    if (!location || !location.includes(`attachmentId=${documentId}`) || documentId !== noteId)
      throw new ServiceUnavailableException('Saved-note receipt unavailable');
    const indexing = optionalString(value.indexingStatus, 40);
    const indexingStatus =
      indexing === 'indexed' || indexing === 'pending' || indexing === 'not_indexed'
        ? indexing
        : null;
    const readiness =
      status === 'failed'
        ? ('unavailable' as const)
        : status === 'pending'
          ? ('scanning' as const)
          : indexingStatus === 'indexed'
            ? ('indexed' as const)
            : indexingStatus === 'not_indexed'
              ? ('private' as const)
              : ('indexing' as const);
    return {
      destination: 'client_document',
      noteId,
      documentId,
      location,
      indexingStatus,
      reused: value.reused === true,
      readiness,
      bodyHash,
      generatedAt,
    };
  }

  // General note: a ClioNote with no client. Not a client Files document and not memory.
  if (request.clientId !== undefined)
    throw new ServiceUnavailableException('Saved-note receipt unavailable');
  if (value.clientId !== null && value.clientId !== undefined && value.clientId !== '')
    throw new ServiceUnavailableException('Saved-note receipt unavailable');
  return { destination: 'general', noteId, clientId: null, readiness: 'ready', bodyHash, generatedAt };
}

export type NoteActionErrorStatus = 'failed_terminal' | 'outcome_unknown';

/**
 * Failure classification for the native note path.
 *
 * The canonical owner performs its meeting/client/conversation validation BEFORE
 * any write, so a definite 4xx refusal (or a canonical validation message) is
 * provably effect-free and stays definite. Anything else — a transient failure, a
 * lost response, or an error raised between the meeting note and its ClioNote —
 * may already have written a note, so it becomes UNKNOWN and is never resent.
 */
export function noteExecutionFailure(
  tool: string,
  classified: { status: string; code: string; message: string },
): { status: NoteActionErrorStatus; code: string; message: string } | null {
  if (!isNoteAction(tool)) return null;
  if (classified.status !== 'failed_retryable') return null;
  return {
    status: 'outcome_unknown',
    code: 'note_outcome_unknown',
    message:
      'No confirmed saved-note receipt; the note (or its meeting note) may already be saved, so it will not be resent. Read the recorded result.',
  };
}
