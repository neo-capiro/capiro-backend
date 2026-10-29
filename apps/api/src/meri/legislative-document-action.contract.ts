/** Closed canonical contract for the two governed legislative-document WRITE effects.
 * `prepare_legiwatch_briefing` is a write despite its name: both effects create an editable private draft
 * through Intel's existing owners and never publish, send, schedule or approve anything.
 *
 * Owner split:
 * - briefing -> Intel EditorialService.save (source/current-context checks, request-key/input-hash lock,
 *   canonical selection, then the existing Workspace export);
 * - research -> Intel ResearchService.saveResearch/createWorkspace/researchSource.
 *
 * One durable receipt states the effect truthfully and is never upgraded:
 * `complete` means the owner returned the exported document; `selection_only` means only the canonical
 * selection was saved; `unknown` means no confirmed receipt exists and the effect must be observed,
 * never repeated. */
import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { nativeCanonicalSha256 } from './native-approvals/native-approval.contract.js';

export const LEGISLATIVE_DOCUMENT_BRIEFING = 'prepare_legiwatch_briefing';
export const LEGISLATIVE_DOCUMENT_RESEARCH = 'save_legislative_research';
export const LEGISLATIVE_DOCUMENT_TOOLS = [
  LEGISLATIVE_DOCUMENT_BRIEFING,
  LEGISLATIVE_DOCUMENT_RESEARCH,
] as const;
export type LegislativeDocumentTool = (typeof LEGISLATIVE_DOCUMENT_TOOLS)[number];
export const LEGISLATIVE_DOCUMENT_KIND = 'legislative_document_action';
export const LEGISLATIVE_DOCUMENT_SCOPE_KEY = '__meriLegislativeDocumentScope';
/** Owner-enforced session bound for retained legislative research documents. */
const RESEARCH_SESSION_MAX = 60;
const uuid = z
  .string()
  .uuid()
  .regex(/^[a-f0-9-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const jurisdiction = z
  .string()
  .regex(/^(US|[A-Z]{2})$/);
const source = z
  .object({
    kind: z.string().min(1).max(40),
    id: z.string().min(1).max(200),
    revision: z.string().min(1).max(200),
  })
  .strict();
const citation = z
  .object({
    kind: z.string().min(1).max(40),
    id: z.string().min(1).max(200),
    revision: z.string().min(1).max(200),
    locator: z.string().min(1).max(200),
    start: z.number().int().min(0),
    end: z.number().int().min(1),
    quote: z.string().min(1).max(8000),
  })
  .strict()
  .refine((value) => value.end > value.start);
const researchCitation = z
  .object({
    documentId: z.string().min(1).max(200),
    revision: z.string().min(1).max(200),
    locator: z.string().min(1).max(200),
    start: z.number().int().min(0),
    end: z.number().int().min(1),
    quote: z.string().min(1).max(8000),
  })
  .strict()
  .refine((value) => value.end > value.start);
const requestKey = z.string().min(8).max(180);
const briefingSelection = z
  .object({
    clientId: uuid.nullish(),
    folderId: uuid,
    jurisdiction: jurisdiction.optional(),
    sessionKey: z.string().min(1).max(120).optional(),
    template: z.enum(['research_update', 'daily_legislative_brief', 'morning_news_brief']),
    title: z.string().min(1).max(200),
    analysis: z.string().min(1).max(30000),
    cutoff: z.string().min(1).max(40),
    timezone: z.string().min(1).max(64),
    sources: z.array(source).max(50),
    // The declared briefing contract advertises 150 citations; this owner-specific bound is the canonical
    // one for both sides, so the generic write parser's 100-element array ceiling cannot refuse a valid draft.
    citations: z.array(citation).min(1).max(150),
  })
  .strict();
const researchSelection = z
  .object({
    clientId: uuid.nullish(),
    folderId: uuid.nullish(),
    jurisdiction,
    sessionKey: z.string().min(1).max(RESEARCH_SESSION_MAX),
    title: z.string().min(1).max(200),
    analysis: z.string().min(1).max(30000),
    documents: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            revision: z.string().min(1).max(200),
            sessionKey: z.string().min(1).max(RESEARCH_SESSION_MAX).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    citations: z.array(researchCitation).min(1).max(100),
    /** Preserved owner contract: a document from another session needs this explicit opt-in. */
    allowCrossBill: z.boolean().optional(),
    rightSessionKey: z.string().min(1).max(RESEARCH_SESSION_MAX).optional(),
  })
  .strict();
export const legislativeDocumentBriefingRequestSchema = briefingSelection
  .extend({ requestKey })
  .strict();
export const legislativeDocumentResearchRequestSchema = researchSelection
  .extend({ requestKey })
  .strict();
export type LegislativeDocumentBriefingRequest = z.infer<
  typeof legislativeDocumentBriefingRequestSchema
>;
export type LegislativeDocumentResearchRequest = z.infer<
  typeof legislativeDocumentResearchRequestSchema
>;
export type LegislativeDocumentRequest =
  | LegislativeDocumentBriefingRequest
  | LegislativeDocumentResearchRequest;
export const legislativeDocumentSelectionSchema = z
  .object({ conversationId: uuid, selectedClientId: uuid.nullable() })
  .strict();
export const legislativeDocumentScopeSchema = legislativeDocumentSelectionSchema
  .extend({
    identityRevision: digest,
    membershipRevision: digest,
    contextRevision: digest,
  })
  .strict();
export type LegislativeDocumentScope = z.infer<typeof legislativeDocumentScopeSchema>;
/** In-process callback from ApplicationCurrentService. No caller-supplied grant or durable second authority. */
export interface LegislativeDocumentProposalAccess {
  scope: LegislativeDocumentScope;
  assertCurrent(): Promise<void>;
}
export function isLegislativeDocumentTool(tool: string): tool is LegislativeDocumentTool {
  return (LEGISLATIVE_DOCUMENT_TOOLS as readonly string[]).includes(tool);
}
function schemaFor(tool: string) {
  if (tool === LEGISLATIVE_DOCUMENT_BRIEFING) return legislativeDocumentBriefingRequestSchema;
  if (tool === LEGISLATIVE_DOCUMENT_RESEARCH) return legislativeDocumentResearchRequestSchema;
  throw new BadRequestException('Unknown legislative document effect');
}
/** Exact owner request. An absent client/folder scope stays absent so the server re-derives it. */
export function legislativeDocumentRequest(tool: string, input: unknown): LegislativeDocumentRequest {
  const raw = input as Record<string, unknown> | null;
  const parsed = schemaFor(tool).safeParse(
    raw && {
      ...raw,
      clientId: raw.clientId ?? null,
      ...(tool === LEGISLATIVE_DOCUMENT_RESEARCH ? { folderId: raw.folderId ?? null } : {}),
    },
  );
  if (!parsed.success) throw new BadRequestException('Invalid legislative document selection');
  return parsed.data as LegislativeDocumentRequest;
}
/** Canonical proposal input: null scopes are omitted because the canonical write parser rejects null strings. */
export function legislativeDocumentInput(
  tool: string,
  request: LegislativeDocumentRequest,
): Record<string, unknown> {
  const { clientId, folderId, ...rest } = request as Record<string, unknown> & {
    clientId: string | null;
    folderId?: string | null;
  };
  return {
    ...rest,
    ...(clientId === null || clientId === undefined ? {} : { clientId }),
    ...(folderId === null || folderId === undefined ? {} : { folderId }),
  };
}
/** Re-validates a canonical input at the shared write boundary and returns it unchanged. */
export function parseLegislativeDocumentInput(
  tool: string,
  input: unknown,
): Record<string, unknown> {
  const canonical = legislativeDocumentInput(tool, legislativeDocumentRequest(tool, input));
  return canonical;
}
export function legislativeDocumentPreview(tool: string, input: unknown) {
  const { clientId: _clientId, ...fields } = legislativeDocumentRequest(tool, input);
  return {
    label:
      tool === LEGISLATIVE_DOCUMENT_BRIEFING
        ? 'Prepare LegiWatch briefing draft'
        : 'Save legislative research draft',
    fields: fields as unknown as Record<string, unknown>,
  };
}
export async function assertLegislativeDocumentAccess(
  access: LegislativeDocumentProposalAccess | undefined,
  tool: string,
  conversationId: string | null | undefined,
  input: unknown,
  preview?: unknown,
) {
  const scope = legislativeDocumentScopeSchema.safeParse(access?.scope),
    request = legislativeDocumentRequest(tool, input);
  if (
    !scope.success ||
    !access ||
    typeof access.assertCurrent !== 'function' ||
    scope.data.conversationId !== conversationId ||
    (scope.data.selectedClientId !== null && request.clientId !== scope.data.selectedClientId)
  )
    throw new ForbiddenException('Current legislative document proposal access required');
  if (preview !== undefined) {
    const stored = readLegislativeDocumentScope(preview);
    if (nativeCanonicalSha256(stored) !== nativeCanonicalSha256(scope.data))
      throw new ForbiddenException('Legislative document proposal authority changed');
  }
  await access.assertCurrent();
  return scope.data;
}
export function readLegislativeDocumentScope(preview: unknown): LegislativeDocumentScope {
  const parsed = legislativeDocumentScopeSchema.safeParse(
    (preview as Record<string, unknown> | null)?.[LEGISLATIVE_DOCUMENT_SCOPE_KEY],
  );
  if (!parsed.success)
    throw new ForbiddenException('Legislative document proposal scope unavailable');
  return parsed.data;
}
export function legislativeDocumentFingerprint(
  tool: string,
  input: Record<string, unknown>,
  scope?: LegislativeDocumentScope,
) {
  return isLegislativeDocumentTool(tool)
    ? { ...input, [LEGISLATIVE_DOCUMENT_SCOPE_KEY]: scope }
    : input;
}
export function publicLegislativeDocumentPreview(
  preview: Record<string, unknown>,
): Record<string, unknown> {
  const { [LEGISLATIVE_DOCUMENT_SCOPE_KEY]: _scope, ...publicPreview } = preview;
  return publicPreview;
}
/** Exact Core bridge receipt. A saved selection is never relabelled as a completed document. */
export function legislativeDocumentReceipt(tool: string, result: unknown, input: unknown) {
  // The receipt is the bridge's own classification of the owner response, bound to this exact request.
  const request = legislativeDocumentRequest(tool, input),
    r = result as {
      tool?: unknown;
      status?: unknown;
      selectionId?: unknown;
      documentId?: unknown;
      location?: unknown;
      reused?: unknown;
    } | null;
  const parsed = z
    .object({
      tool: z.literal(tool),
      status: z.enum(['saved', 'selection_saved', 'unknown']),
      selectionId: z.string().min(1).max(200).nullable(),
      documentId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/).nullable(),
      location: z.string().regex(/^\/workspace\/draft\/[a-zA-Z0-9-]{1,100}$/).nullable(),
      reused: z.boolean(),
    })
    .safeParse(r);
  // `unknown` and any malformed classification stay unknown: the effect must be observed, never repeated.
  if (!parsed.success || parsed.data.status === 'unknown')
    throw new ServiceUnavailableException('Legislative document durable outcome unavailable');
  const state = parsed.data.status === 'saved' ? 'complete' : 'selection_only';
  if (
    (state === 'complete' &&
      (parsed.data.documentId === null ||
        parsed.data.location === null ||
        !parsed.data.location.endsWith(parsed.data.documentId))) ||
    (state === 'selection_only' &&
      (parsed.data.documentId !== null || parsed.data.location !== null))
  )
    throw new ServiceUnavailableException('Legislative document durable outcome unavailable');
  return {
    request,
    state,
    selectionId: parsed.data.selectionId,
    documentId: parsed.data.documentId,
    location: parsed.data.location,
    reused: parsed.data.reused,
  };
}
/** Stable digest of the exported document id for durable evidence; never a fabricated citation. */
export function legislativeDocumentEvidenceDigest(receipt: { documentId: string | null }) {
  return receipt.documentId === null
    ? null
    : createHash('sha256').update(receipt.documentId).digest('hex');
}
