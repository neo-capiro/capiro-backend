import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { nativeCanonicalSha256 } from './native-approvals/native-approval.contract.js';

export const LEGIWATCH_ACTION = 'apply_legiwatch_suggestion';
export const LEGIWATCH_SCOPE_KEY = '__meriLegiwatchScope';
const uuid = z
  .string()
  .uuid()
  .regex(/^[a-f0-9-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const legiwatchRequestSchema = z
  .object({
    clientId: uuid.nullable(),
    folderId: uuid,
    jurisdiction: z.string().regex(/^[A-Z]{2}$/),
    sessionKey: z.string().min(1).max(120),
    suggestionId: uuid,
    expectedVersion: z.number().int().min(1).max(2147483646),
    action: z.enum(['add', 'dismiss', 'exclude', 'restore', 'undo']),
    requestKey: z.string().min(8).max(180),
  })
  .strict();
export type LegiwatchRequest = z.infer<typeof legiwatchRequestSchema>;
export const legiwatchSelectionSchema = z
  .object({ conversationId: uuid, selectedClientId: uuid.nullable() })
  .strict();
export const legiwatchScopeSchema = legiwatchSelectionSchema
  .extend({
    identityRevision: digest,
    membershipRevision: digest,
    contextRevision: digest,
  })
  .strict();
export type LegiwatchScope = z.infer<typeof legiwatchScopeSchema>;
/** In-process callback from ApplicationCurrentService. No caller-supplied grant or durable second authority. */
export interface LegiwatchProposalAccess {
  scope: LegiwatchScope;
  assertCurrent(): Promise<void>;
}
export function legiwatchInput(request: LegiwatchRequest): Record<string, unknown> {
  const { clientId, ...rest } = request;
  return { ...rest, ...(clientId === null ? {} : { clientId }) };
}
export function legiwatchRequest(input: unknown): LegiwatchRequest {
  const raw = input as Record<string, unknown> | null;
  const parsed = legiwatchRequestSchema.safeParse(
    raw && { ...raw, clientId: raw.clientId ?? null },
  );
  if (!parsed.success) throw new BadRequestException('Invalid LegiWatch suggestion selection');
  return parsed.data;
}
export async function assertLegiwatchAccess(
  access: LegiwatchProposalAccess | undefined,
  conversationId: string | null | undefined,
  input: unknown,
  preview?: unknown,
) {
  const scope = legiwatchScopeSchema.safeParse(access?.scope),
    request = legiwatchRequest(input);
  if (
    !scope.success ||
    !access ||
    typeof access.assertCurrent !== 'function' ||
    scope.data.conversationId !== conversationId ||
    (scope.data.selectedClientId !== null && request.clientId !== scope.data.selectedClientId)
  )
    throw new ForbiddenException('Current LegiWatch proposal access required');
  if (preview !== undefined) {
    const stored = readLegiwatchScope(preview);
    if (nativeCanonicalSha256(stored) !== nativeCanonicalSha256(scope.data))
      throw new ForbiddenException('LegiWatch proposal authority changed');
  }
  await access.assertCurrent();
  return scope.data;
}
export function readLegiwatchScope(preview: unknown): LegiwatchScope {
  const parsed = legiwatchScopeSchema.safeParse(
    (preview as Record<string, unknown> | null)?.[LEGIWATCH_SCOPE_KEY],
  );
  if (!parsed.success) throw new ForbiddenException('LegiWatch proposal scope unavailable');
  return parsed.data;
}
export function legiwatchFingerprint(
  tool: string,
  input: Record<string, unknown>,
  scope?: LegiwatchScope,
) {
  return tool === LEGIWATCH_ACTION ? { ...input, [LEGIWATCH_SCOPE_KEY]: scope } : input;
}
export function publicLegiwatchPreview(preview: Record<string, unknown>): Record<string, unknown> {
  const { [LEGIWATCH_SCOPE_KEY]: _scope, ...publicPreview } = preview;
  return publicPreview;
}
/** Exact Intel owner receipt. A handled stale/excluded/conflict outcome is never relabelled as an applied change. */
export function legiwatchReceipt(result: unknown, input: unknown) {
  const request = legiwatchRequest(input),
    r = result as { tool?: unknown; result?: unknown } | null;
  const parsed = z
    .object({
      outcome: z.enum([
        'added',
        'already_present',
        'dismissed',
        'excluded',
        'pending',
        'stale',
        'undone',
        'undo_conflict',
        'held',
      ]),
      payload: z
        .object({
          binding: digest,
          suggestionId: uuid,
          decisionId: uuid.nullable(),
          version: z.number().int().min(1),
          action: legiwatchRequestSchema.shape.action,
        })
        .strict(),
    })
    .strict()
    .safeParse(r?.result);
  const binding = createHash('sha256')
    .update(
      JSON.stringify({
        id: request.suggestionId,
        expected: request.expectedVersion,
        action: request.action,
      }),
    )
    .digest('hex');
  if (
    r?.tool !== LEGIWATCH_ACTION ||
    !parsed.success ||
    parsed.data.payload.binding !== binding ||
    parsed.data.payload.suggestionId !== request.suggestionId ||
    parsed.data.payload.action !== request.action ||
    parsed.data.payload.version !== request.expectedVersion + 1
  )
    throw new ServiceUnavailableException('LegiWatch durable outcome unavailable');
  return { request, ...parsed.data };
}
