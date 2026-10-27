import { createHash } from 'node:crypto';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { nativeCanonicalSha256 } from './native-approvals/native-approval.contract.js';

export const RELEVANCE_PREVIEW = 'preview_legiwatch_relevance';
export const RELEVANCE_SAVE = 'save_legiwatch_relevance';
const id = z.string().min(1).max(250);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z
  .string()
  .uuid()
  .regex(/^[a-f0-9-]+$/);
const fields = z
  .array(z.enum(['title', 'bill_text', 'amendment_text']))
  .min(1)
  .max(3);
const scope = z
  .object({
    jurisdiction: z.string().regex(/^[A-Z]{2}$/),
    sessionKey: z.string().min(1).max(60),
    fields,
  })
  .strict();
const selection = z
  .object({ clientId: uuid.nullable(), folderId: id, ...scope.shape, billId: id })
  .strict();
const evidence = {
  explanation: z.string().min(1).max(2000),
  documentId: id,
  start: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  end: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  quote: z.string().min(1).max(2000),
};
export const relevancePreviewSchema = selection
  .extend({
    explanation: evidence.explanation.optional(),
    documentId: id.optional(),
    start: evidence.start.optional(),
    end: evidence.end.optional(),
    quote: evidence.quote.optional(),
  })
  .strict();
export const relevanceSaveSchema = selection
  .extend({ ...evidence, previewHash: digest, requestKey: z.string().min(8).max(180) })
  .strict();
export type RelevancePreview = z.infer<typeof relevancePreviewSchema>;
export type RelevanceSave = z.infer<typeof relevanceSaveSchema>;
const invalid = () => new ServiceUnavailableException('LegiWatch relevance owner response invalid');
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function evidenceValid(input: RelevancePreview) {
  if (new Set(input.fields).size !== input.fields.length) return false;
  const parts = [input.explanation, input.documentId, input.start, input.end, input.quote];
  if (parts.every((value) => value === undefined)) return true;
  return (
    parts.every((value) => value !== undefined) &&
    !!input.explanation?.trim() &&
    input.end! > input.start! &&
    input.end! - input.start! <= 2000 &&
    input.quote!.length === input.end! - input.start!
  );
}
export function parseRelevancePreview(raw: unknown): RelevancePreview {
  const parsed = relevancePreviewSchema.safeParse(raw);
  if (!parsed.success || !evidenceValid(parsed.data))
    throw new BadRequestException('Invalid LegiWatch source evidence selection');
  return parsed.data;
}
export function parseRelevanceSave(raw: unknown): RelevanceSave {
  const parsed = relevanceSaveSchema.safeParse(raw);
  if (!parsed.success || !evidenceValid(parsed.data))
    throw new BadRequestException('Invalid LegiWatch relevance proposal');
  return parsed.data;
}
/** Match the canonical SemanticSuggestionService input and property order. This
 * hash belongs to that owner, not Meri's sorted command fingerprint. */
export function relevanceSemanticInput(input: RelevancePreview) {
  return {
    scope: { jurisdiction: input.jurisdiction, sessionKey: input.sessionKey, fields: input.fields },
    folderId: input.folderId,
    billId: input.billId,
    explanation: input.explanation,
    documentId: input.documentId,
    start: input.start,
    end: input.end,
    quote: input.quote,
  };
}
const coverage = z
  .object({
    complete: z.boolean(),
    inspectedDocuments: z.number().int().min(0),
    missing: z.array(z.string()),
  })
  .strict();
const sourceBill = z.object({
  id,
  number: z.string(),
  title: z.string(),
  sponsor: z.string().nullable(),
  jurisdiction: scope.shape.jurisdiction,
  sessionKey: scope.shape.sessionKey,
  status: z.string().nullable(),
  latestAction: z.string().nullable(),
  latestActionAt: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  chamber: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  classifications: z.array(z.string()).optional(),
  subjects: z.array(z.string()).optional(),
  currentCommittee: z.string().nullable().optional(),
});
const sourceDocument = z
  .object({
    id,
    billId: id,
    kind: fields.element,
    revision: id,
    observationId: id,
    sourceUrl: z.string().nullable(),
    extractorVersion: z.string().nullable(),
    text: z.string().max(12000).nullable(),
    complete: z.boolean(),
    reason: z.string().nullable(),
    excerptOnly: z.boolean(),
  })
  .strict();
const pendingEffect = z
  .object({ kind: z.literal('pending_semantic_suggestion'), automaticAssignment: z.literal(false) })
  .strict();
export function receiveRelevancePreview(input: RelevancePreview, raw: unknown) {
  let data: unknown;
  if (input.explanation === undefined) {
    const parsed = z
      .object({
        bill: sourceBill,
        documents: z.array(sourceDocument).max(1001),
        coverage,
        effects: z.array(z.never()),
        previewHash: z.null(),
      })
      .strict()
      .safeParse(raw);
    if (!parsed.success) throw invalid();
    const page = parsed.data;
    if (
      page.bill.id !== input.billId ||
      page.bill.jurisdiction !== input.jurisdiction ||
      page.bill.sessionKey !== input.sessionKey ||
      new Set(page.documents.map((d) => d.id)).size !== page.documents.length ||
      page.documents.some(
        (d) =>
          d.billId !== input.billId ||
          !input.fields.includes(d.kind) ||
          (d.excerptOnly && d.text?.length !== 12000),
      )
    )
      throw invalid();
    data = page;
  } else {
    const semantic = z.object({ scope, folderId: id, billId: id, ...evidence }).strict();
    const parsed = z
      .object({
        input: semantic,
        binding: z
          .object({
            input: semantic,
            sourceFingerprint: digest,
            folderVersion: z.number().int().min(0),
          })
          .strict(),
        previewHash: digest,
        coverage,
        effects: z.tuple([pendingEffect]),
      })
      .strict()
      .safeParse(raw);
    if (!parsed.success) throw invalid();
    const page = parsed.data,
      selected = relevanceSemanticInput(input);
    if (
      nativeCanonicalSha256(page.input) !== nativeCanonicalSha256(selected) ||
      nativeCanonicalSha256(page.binding.input) !== nativeCanonicalSha256(selected) ||
      page.previewHash !==
        sha({
          input: selected,
          sourceFingerprint: page.binding.sourceFingerprint,
          folderVersion: page.binding.folderVersion,
        })
    )
      throw invalid();
    data = page;
  }
  return {
    version: '0.1.0' as const,
    tool: RELEVANCE_PREVIEW,
    generatedAt: new Date().toISOString(),
    selection: input,
    data,
    effects: [],
    coverage: {
      basis: 'current_owner_read' as const,
      sourceUniverseComplete: false,
      maxOutputBytes: 262144,
      limitations: [
        'Evidence text uses UTF-16 source offsets. Documents may be excerpts or incomplete; preserve their coverage.',
        'A verified relevance preview is a proposed pending suggestion, never an automatic bill assignment.',
      ],
    },
  };
}
/** Only the canonical operation receipt proves the pending suggestion was saved. */
export function relevanceReceipt(result: unknown, rawRequest: unknown) {
  const request = parseRelevanceSave(rawRequest),
    outer = result as { tool?: unknown; result?: unknown } | null;
  const parsed = z
    .object({
      binding: digest,
      suggestionId: uuid,
      version: z.number().int().min(1),
      origin: z.literal('semantic'),
      state: z.literal('pending'),
    })
    .strict()
    .safeParse(outer?.result);
  if (
    outer?.tool !== RELEVANCE_SAVE ||
    !parsed.success ||
    parsed.data.binding !== sha([request.previewHash, request.requestKey])
  )
    throw invalid();
  return { request, outcome: 'suggested' as const, payload: parsed.data };
}
