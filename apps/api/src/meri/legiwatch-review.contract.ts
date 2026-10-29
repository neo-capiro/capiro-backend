import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';

const id = z.string().min(1).max(250);
const uuid = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text = z.string();
const json = z.record(z.string(), z.unknown());
const scope = {
  clientId: uuid.nullable(),
  jurisdiction: z.string().regex(/^[A-Z]{2}$/),
  sessionKey: z.string().min(1).max(60),
};
export const legiwatchReviewRequest = z.discriminatedUnion('view', [
  z.object({ view: z.literal('folders'), clientId: uuid.nullable() }).strict(),
  z
    .object({ view: z.literal('suggestions'), ...scope, folderId: id, cursor: id.optional() })
    .strict(),
  z.object({ view: z.literal('rules'), clientId: uuid.nullable(), folderId: id }).strict(),
  z.object({ view: z.literal('workflows'), clientId: uuid.nullable(), folderId: id }).strict(),
]);
export type LegiwatchReviewRequest = z.infer<typeof legiwatchReviewRequest>;
const folder = z.object({
  id,
  tenantId: uuid,
  clientId: uuid.nullable(),
  name: text,
  code: text.nullable(),
  archived: z.literal(false),
  ownerClerkId: text.nullable(),
  otherUserAccess: text,
  defaultSession: text,
  jurisdiction: text,
  version,
  canEdit: z.boolean(),
  canManage: z.boolean(),
  count: version,
});
const sourceScope = z.object({
  jurisdiction: scope.jurisdiction,
  sessionKey: scope.sessionKey,
  fields: z
    .array(z.enum(['title', 'bill_text', 'amendment_text']))
    .min(1)
    .max(3),
});
const suggestion = z.object({
  id,
  tenant_id: uuid,
  owner_clerk_id: text,
  rule_id: id,
  rule_version: version,
  run_id: id,
  folder_id: id,
  bill_id: id,
  fingerprint: text,
  version,
  state: text,
  decision_id: id.nullable(),
  payload: z
    .object({
      bill: json,
      sourceFingerprint: text,
      folderVersion: version,
      stateVersion: version,
      coverage: z.object({
        complete: z.boolean(),
        inspectedDocuments: version,
        missing: z.array(text),
      }),
      matches: z.array(json),
      sourceScope,
      origin: z.enum(['deterministic', 'semantic']),
      explanation: text.optional(),
    })
    .passthrough(),
});
const rule = z.object({
  id,
  tenant_id: uuid,
  owner_clerk_id: text,
  name: text,
  version,
  state: z.enum(['needs_review', 'active', 'paused']),
  config: z.object({ folderIds: z.array(id), scope: sourceScope }).passthrough(),
  activation: json.nullable(),
  issues: z.array(text),
  compiled: z.array(json),
});
const workflow = z.object({
  id,
  tenant_id: uuid,
  owner_clerk_id: text,
  workflow_id: id.nullable(),
  template: text,
  input_hash: text,
  input: z.object({ folderIds: z.array(id) }).passthrough(),
  state: text,
  reason: text.nullable(),
  steps: json,
});
const invalid = () => new ServiceUnavailableException('LegiWatch owner response invalid');
function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const p = schema.safeParse(raw);
  if (!p.success) throw invalid();
  return p.data;
}

/** The existing Intel owner enforces feature, actor, folder and client walls.
 * This projection retains review evidence and actionable versions, not leases,
 * private tenant columns or an invented public-source record identity. */
export function receiveLegiwatchReview(
  input: LegiwatchReviewRequest,
  raw: unknown,
  tenantId: string,
  actor: string,
) {
  let data: unknown;
  if (input.view === 'folders') {
    const page = parse(
      z.object({
        folders: z.array(folder),
        scope: z.object({ clientId: uuid.nullable() }),
        effects: z.array(z.never()),
      }),
      raw,
    );
    if (
      page.scope.clientId !== input.clientId ||
      new Set(page.folders.map((r) => r.id)).size !== page.folders.length ||
      page.folders.some((r) => r.tenantId !== tenantId || r.clientId !== input.clientId)
    )
      throw invalid();
    data = { folders: page.folders.map(({ tenantId: _tenant, ...r }) => r) };
  } else if (input.view === 'suggestions') {
    const page = parse(z.object({ rows: z.array(suggestion).max(50), next: id.nullable() }), raw);
    let previous = input.cursor ?? '';
    for (const row of page.rows) {
      if (
        row.tenant_id !== tenantId ||
        row.owner_clerk_id !== actor ||
        row.folder_id !== input.folderId ||
        row.payload.sourceScope.jurisdiction !== input.jurisdiction ||
        row.payload.sourceScope.sessionKey !== input.sessionKey ||
        row.id <= previous
      )
        throw invalid();
      previous = row.id;
    }
    if (page.next !== null && (page.rows.length !== 50 || page.next !== page.rows.at(-1)?.id))
      throw invalid();
    data = {
      rows: page.rows.map(({ tenant_id: _tenant, owner_clerk_id: _owner, ...r }) => r),
      next: page.next,
    };
  } else {
    const rows =
      input.view === 'rules'
        ? parse(z.array(rule).max(201), raw)
        : parse(z.array(workflow).max(100), raw);
    if (
      new Set(rows.map((r) => r.id)).size !== rows.length ||
      rows.some(
        (r) =>
          r.tenant_id !== tenantId ||
          r.owner_clerk_id !== actor ||
          !('config' in r ? r.config.folderIds : r.input.folderIds).includes(input.folderId),
      )
    )
      throw invalid();
    data = { rows: rows.map(({ tenant_id: _tenant, owner_clerk_id: _owner, ...r }) => r) };
  }
  return {
    version: '0.1.0' as const,
    tool: 'get_legiwatch_review' as const,
    generatedAt: new Date().toISOString(),
    selection: input,
    data,
    effects: [],
    coverage: {
      basis: 'current_owner_read',
      sourceUniverseComplete: false,
      maxOutputBytes: 262144,
      ownerRowLimit: { folders: null, suggestions: 50, rules: 201, workflows: 100 }[input.view],
      limitations:
        input.view === 'suggestions'
          ? [
              'Current owner keyset page; not a cross-page snapshot. Source coverage and missing evidence remain on each suggestion.',
            ]
          : [
              'Current authorized owner list. Rules and workflows retain their existing owner limits; no completeness or continuation is inferred.',
            ],
    },
  };
}
export function parseLegiwatchReview(raw: unknown) {
  const result = legiwatchReviewRequest.safeParse(raw);
  if (!result.success) throw new BadRequestException('Choose an exact LegiWatch review selection');
  return result.data;
}
