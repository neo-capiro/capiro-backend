import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  BRIEF_SECTION_KEYS,
  BRIEF_TEXT_MAX,
  BRIEF_TITLE_MAX,
  type BriefSectionKey,
} from '../business-development/bizdev-brief.types.js';
import { nativeCanonicalSha256 } from './native-approvals/native-approval.contract.js';

/** The one approved Core action this route proposes. Existing tool, existing
 * saved-version owner: this contract only binds the current prospect
 * conversation, the exact expected brief version and the exact receipt. */
export const BIZDEV_BRIEF_ACTION = 'save_business_development_brief';
export const BIZDEV_SCOPE_KEY = '__meriBizdevBriefScope';
const uuid = z
  .string()
  .uuid()
  .regex(/^[a-f0-9-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** The saved-version owner returns real instants in-process and ISO strings from
 * the durable JSON receipt; both normalize to one exact ISO instant. */
const isoTimestamp = z
  .union([z.string(), z.date()])
  .transform((value) => (value instanceof Date ? value.toISOString() : value))
  .refine((value) => Number.isFinite(Date.parse(value)), 'invalid timestamp');

/** One brief section exactly as the model may state it: text plus indexes into
 * the current version's existing citations. Provenance and citation records are
 * never model-submitted — the existing tool forces provenance to `generated`. */
const briefSectionSchema = z
  .object({
    text: z.string().min(1).max(BRIEF_TEXT_MAX),
    citationIndexes: z.array(z.number().int().min(0)),
  })
  .strict();
const briefSectionShapes = Object.fromEntries(
  BRIEF_SECTION_KEYS.map((key) => [key, briefSectionSchema]),
) as Record<BriefSectionKey, typeof briefSectionSchema>;
export const bizdevSectionsSchema = z.object(briefSectionShapes).strict();
export const bizdevRequestSchema = z
  .object({
    /** The exact current prospect chat this edit is authorized by. */
    conversationId: uuid,
    /** The saved version this edit is based on; a stale number conflicts. */
    expectedVersionNumber: z.number().int().min(1).max(2147483646),
    title: z.string().min(1).max(BRIEF_TITLE_MAX).optional(),
    sections: bizdevSectionsSchema,
    /** The caller's deterministic idempotency key for this exact edit. It is
     * part of the stored input and of the proposal fingerprint, so an identical
     * re-prepare resolves to the same proposal and a changed edit cannot reuse a
     * prior approval. */
    requestKey: z.string().min(8).max(180),
  })
  .strict();
export type BizdevRequest = z.infer<typeof bizdevRequestSchema>;
export const bizdevSelectionSchema = z.object({ conversationId: uuid }).strict();
/** The bounded prospect scope this action was prepared under. The proposal
 * carries it back so read/decide can prove the same persisted owner scope. */
export const bizdevScopeSchema = bizdevSelectionSchema
  .extend({
    prospectId: uuid,
    prospectName: z.string().min(1).max(200),
    canonicalOrganizationId: uuid.nullable(),
    linkedClientId: uuid.nullable(),
    scopeVersion: digest,
  })
  .strict();
export type BizdevScope = z.infer<typeof bizdevScopeSchema>;
/** In-process callback resolved from the persisted prospect conversation. No
 * caller-supplied grant, no second authority, no cached permission. */
export interface BizdevProposalAccess {
  scope: BizdevScope;
  assertCurrent(): Promise<void>;
}

/** The canonical stored tool input. Only the exact five sections' text and
 * citation indexes travel, copied as submitted: the proposal fingerprint and the
 * journal's recorded arguments must describe the same edit, so this owner never
 * rewrites the model's text or indexes. Trimming, index validity, the version
 * write and the durable idempotency key stay with the existing saved-version
 * owner, which is also what makes a replay return the identical receipt. */
export function bizdevInput(request: BizdevRequest): Record<string, unknown> {
  return {
    conversationId: request.conversationId,
    expectedVersionNumber: request.expectedVersionNumber,
    requestKey: request.requestKey,
    ...(request.title === undefined ? {} : { title: request.title }),
    sections: Object.fromEntries(
      BRIEF_SECTION_KEYS.map((key) => {
        const section = request.sections[key];
        return [key, { text: section.text, citationIndexes: [...section.citationIndexes] }];
      }),
    ),
  };
}

export function bizdevRequest(input: unknown, conversationId?: string | null): BizdevRequest {
  const parsed = bizdevRequestSchema.safeParse(input);
  if (
    !parsed.success ||
    (conversationId !== undefined &&
      conversationId !== null &&
      parsed.data.conversationId !== conversationId)
  )
    throw new BadRequestException('Invalid business-development brief edit');
  return parsed.data;
}

export async function assertBizdevAccess(
  access: BizdevProposalAccess | undefined,
  conversationId: string | null | undefined,
  input: unknown,
  preview?: unknown,
) {
  const scope = bizdevScopeSchema.safeParse(access?.scope),
    request = bizdevRequest(input);
  if (
    !scope.success ||
    !access ||
    typeof access.assertCurrent !== 'function' ||
    scope.data.conversationId !== conversationId ||
    request.conversationId !== conversationId
  )
    throw new ForbiddenException('Current business-development brief access required');
  if (preview !== undefined) {
    const stored = readBizdevScope(preview);
    if (nativeCanonicalSha256(stored) !== nativeCanonicalSha256(scope.data))
      throw new ForbiddenException('Business-development brief proposal authority changed');
  }
  await access.assertCurrent();
  return scope.data;
}

/** The saved-version owner's own precondition refusals. They are the only
 * failures provably raised before the version write — the owner raises them
 * inside its single transaction: a stale `expectedVersionNumber`, an
 * unauthorized citation index set, a section shape outside the exact
 * five-section contract, an idempotency-key mismatch, a missing brief/base
 * version or the version ceiling.
 *
 * Everything else stays UNKNOWN, including any bare HTTP status: the invoked
 * owner can throw after an effect has landed (result mapping after the commit,
 * a lost response, a transport or DB failure). No path here re-runs an effect
 * and nothing unconfirmed is relabelled as a saved brief. */
const BIZDEV_BRIEF_PRE_EFFECT_REFUSALS = [
  'BIZDEV_BRIEF_VERSION_CONFLICT',
  'BIZDEV_BRIEF_CITATION_REJECTED',
  'BIZDEV_BRIEF_SECTIONS_INVALID',
  'BIZDEV_BRIEF_IDEMPOTENCY_MISMATCH',
];
export function classifyBizdevBriefFailure(classified: {
  status: string;
  code: string;
  message: string;
}): { status: 'failed_terminal' | 'outcome_unknown'; code: string; message: string } {
  const refused =
    BIZDEV_BRIEF_PRE_EFFECT_REFUSALS.includes(classified.code) ||
    /no saved version yet|has no brief yet|version limit|base version not found|brief not found|prospect not found/i.test(
      classified.message,
    );
  if (classified.status === 'failed_terminal' && refused)
    return { status: 'failed_terminal', code: classified.code, message: classified.message };
  return {
    status: 'outcome_unknown',
    code: 'bizdev_brief_outcome_unknown',
    message: `${classified.message} No confirmed saved brief/version receipt; the brief is not relabelled and no replay starts automatically.`,
  };
}

export function readBizdevScope(preview: unknown): BizdevScope {
  const parsed = bizdevScopeSchema.safeParse(
    (preview as Record<string, unknown> | null)?.[BIZDEV_SCOPE_KEY],
  );
  if (!parsed.success) throw new ForbiddenException('Business-development brief scope unavailable');
  return parsed.data;
}

export function bizdevFingerprint(
  tool: string,
  input: Record<string, unknown>,
  scope?: BizdevScope,
) {
  return tool === BIZDEV_BRIEF_ACTION ? { ...input, [BIZDEV_SCOPE_KEY]: scope } : input;
}

export function publicBizdevPreview(preview: Record<string, unknown>): Record<string, unknown> {
  const { [BIZDEV_SCOPE_KEY]: _scope, ...publicPreview } = preview;
  return publicPreview;
}

/** Exact saved brief/version receipt from the existing saved-version owner. The
 * recorded version must be the expected version's immediate successor; an
 * unconfirmed, foreign or lost effect is never released as a saved brief. */
export function bizdevBriefReceipt(result: unknown, input: unknown) {
  const request = bizdevRequest(input),
    r = result as { tool?: unknown } | null;
  const parsed = z
    .object({
      tool: z.literal(BIZDEV_BRIEF_ACTION),
      status: z.literal('saved'),
      generatedAt: isoTimestamp,
      brief: z
        .object({
          id: uuid,
          title: z.string(),
          status: z.enum(['draft', 'archived']),
          currentVersionNumber: z.number().int().min(1),
          updatedAt: isoTimestamp,
        })
        .strict(),
      version: z
        .object({
          id: uuid,
          versionNumber: z.number().int().min(1),
          createdAt: isoTimestamp,
          citationCount: z.number().int().min(0),
        })
        .strict(),
      reused: z.boolean(),
      prospectName: z.string().min(1).max(200),
    })
    .strict()
    .safeParse(r);
  const contract = createHash('sha256')
    .update(
      JSON.stringify({
        conversationId: request.conversationId,
        expectedVersionNumber: request.expectedVersionNumber,
      }),
    )
    .digest('hex');
  if (
    r?.tool !== BIZDEV_BRIEF_ACTION ||
    !parsed.success ||
    !Number.isFinite(Date.parse(parsed.data.generatedAt)) ||
    !Number.isFinite(Date.parse(parsed.data.brief.updatedAt)) ||
    !Number.isFinite(Date.parse(parsed.data.version.createdAt)) ||
    parsed.data.version.versionNumber !== request.expectedVersionNumber + 1 ||
    parsed.data.brief.currentVersionNumber !== parsed.data.version.versionNumber
  )
    throw new ServiceUnavailableException('Business-development brief outcome unavailable');
  return { request, binding: contract, ...parsed.data };
}
