import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { z } from 'zod';
import { ApplicationCurrentService } from '../auth/application-current.service.js';
import {
  assertMeriToolRequestActive,
  meriToolRequestControl,
} from './meri-tool-request-control.js';
import {
  parseRetainedReadContext,
  readRetainedReadDeadline,
  readRetainedReadHeader,
  retainedReadObject,
  retainedReadSnapshot,
} from './retained-read-context.js';
import { hasVerifiedToolServiceIdentity } from './tool-service-secret.guard.js';

const MAX_BYTES = 262144;
const uuid = z.string().uuid();
const selector = uuid.transform((value) => value.toLowerCase());
const page = { clientId: selector, cursor: z.string().min(1).max(2048).optional() };
const requestSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('planner_projects'), ...page, archived: z.boolean().optional() })
    .strict(),
  z
    .object({
      kind: z.literal('planner_tasks'),
      ...page,
      archived: z.boolean().optional(),
      projectId: selector.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('planner_task'), clientId: selector, id: selector }).strict(),
  z
    .object({
      kind: z.literal('planner_events'),
      ...page,
      id: selector,
      target: z.enum(['task', 'project']),
    })
    .strict(),
  z.object({ kind: z.literal('strategy_versions'), ...page, strategyId: selector }).strict(),
  z.object({ kind: z.literal('strategy_activity'), ...page, strategyId: selector }).strict(),
  z.object({ kind: z.literal('objective_versions'), ...page, objectiveId: selector }).strict(),
]);
type Selection = z.infer<typeof requestSchema>;
const relations = {
  planner_projects: 'sp_planner_projects',
  planner_tasks: 'sp_planner_tasks',
  planner_task: 'sp_planner_tasks',
  planner_events: 'sp_planner_events',
  strategy_versions: 'sp_version',
  strategy_activity: 'sp_activity_log',
  objective_versions: 'client_objective_revisions',
} as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const envelope = z
  .object({
    version: z.literal('0.1.0'),
    kind: z.enum(Object.keys(relations) as [Selection['kind'], ...Selection['kind'][]]),
    clientId: uuid,
    observedAt: z.string().datetime(),
    items: z
      .array(
        z
          .object({
            source: z.object({ relation: z.string(), id: uuid, contentSha256: hash }).strict(),
            record: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .max(100),
    nextCursor: z.string().min(1).max(2048).nullable(),
    coverage: z
      .object({
        scope: z.literal('selected_client'),
        sourceUniverseComplete: z.literal(false),
        representation: z.enum(['owner_records', 'activity_summaries']),
        rowLimit: z.literal(100),
        maxOutputBytes: z.literal(MAX_BYTES),
        byteTruncated: z.boolean(),
        limitations: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
const refused = () => new ForbiddenException('Saved Strategy access unavailable');
const invalidOwner = () => new ServiceUnavailableException('Saved Strategy owner response invalid');
const sameId = (actual: unknown, expected: string) =>
  typeof actual === 'string' && actual.toLowerCase() === expected;

/** Verify source/selection identity while preserving the owner DTO and full saved snapshots. */
function receive(input: Selection, raw: unknown) {
  const parsed = envelope.safeParse(raw);
  if (!parsed.success) throw invalidOwner();
  const result = parsed.data;
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_BYTES)
    throw new PayloadTooLargeException('Saved Strategy result exceeds read limit');
  if (
    result.kind !== input.kind ||
    !sameId(result.clientId, input.clientId) ||
    result.coverage.representation !==
      (input.kind === 'strategy_activity' ? 'activity_summaries' : 'owner_records')
  )
    throw invalidOwner();
  const ids = new Set<string>();
  for (const { source, record } of result.items) {
    if (
      source.relation !== relations[input.kind] ||
      record.id !== source.id ||
      ids.has(source.id.toLowerCase()) ||
      createHash('sha256').update(JSON.stringify(record)).digest('hex') !== source.contentSha256
    )
      throw invalidOwner();
    ids.add(source.id.toLowerCase());
    if (
      input.kind === 'planner_projects' ||
      input.kind === 'planner_tasks' ||
      input.kind === 'planner_task'
    ) {
      if (
        !sameId(record.clientId, input.clientId) ||
        typeof record.name !== 'string' ||
        !Number.isSafeInteger(record.version) ||
        Number(record.version) < 1
      )
        throw invalidOwner();
      if (input.kind === 'planner_task' && !sameId(record.id, input.id)) throw invalidOwner();
      if (
        input.kind === 'planner_tasks' &&
        input.projectId &&
        (!Array.isArray(record.memberships) ||
          !record.memberships.some(
            (value) =>
              value && typeof value === 'object' && sameId(value.projectId, input.projectId!),
          ))
      )
        throw invalidOwner();
    } else if (input.kind === 'planner_events') {
      if (
        !sameId(record[input.target === 'task' ? 'taskId' : 'projectId'], input.id) ||
        typeof record.kind !== 'string' ||
        typeof record.text !== 'string'
      )
        throw invalidOwner();
    } else if (input.kind === 'strategy_activity') {
      if (
        record.entityType !== 'strategy' ||
        !sameId(record.entityId, input.strategyId) ||
        typeof record.action !== 'string'
      )
        throw invalidOwner();
    } else if (input.kind === 'strategy_versions') {
      if (!sameId(record.strategyId, input.strategyId) || !Object.hasOwn(record, 'snapshot'))
        throw invalidOwner();
    } else if (
      !sameId(record.clientId, input.clientId) ||
      !sameId(record.objectiveId, input.objectiveId) ||
      !Object.hasOwn(record, 'snapshot')
    )
      throw invalidOwner();
  }
  if (
    input.kind === 'planner_task' &&
    (result.items.length !== 1 || result.nextCursor !== null || result.coverage.byteTruncated)
  )
    throw invalidOwner();
  if (result.coverage.byteTruncated && (!result.items.length || result.nextCursor === null))
    throw invalidOwner();
  if (result.nextCursor !== null) {
    const value = input as unknown as Record<string, unknown>;
    const binding = [
      input.kind,
      input.clientId,
      value.id ?? null,
      value.projectId ?? null,
      value.strategyId ?? null,
      value.objectiveId ?? null,
      value.target ?? null,
      value.archived ?? false,
    ];
    const expected = Buffer.from(
      JSON.stringify({ binding, after: result.items.at(-1)?.source.id }),
    ).toString('base64url');
    if (!result.items.length || expected !== result.nextCursor) throw invalidOwner();
  }
  // Return original field order: source digests cover the exact owner's serialized records.
  return raw;
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw invalidOwner();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        throw new PayloadTooLargeException('Saved Strategy result exceeds read limit');
      }
      chunks.push(chunk.value);
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw invalidOwner();
    }
  } finally {
    reader.releaseLock();
  }
}

@Injectable()
export class SavedStrategyReadService {
  constructor(
    private readonly config: ConfigService,
    private readonly current: ApplicationCurrentService,
  ) {}

  async read(ctx: TenantContext, req: Request, raw: unknown) {
    // Strategy's shared guard supports the original signed-in organization only.
    if (req.headers['x-capiro-impersonate-tenant'] !== undefined) throw refused();
    const parsed = requestSchema.safeParse(retainedReadSnapshot(raw, 8192));
    if (!parsed.success) throw new BadRequestException('Choose a supported saved Strategy read');
    const input = parsed.data;
    const context = parseRetainedReadContext(
      ctx,
      readRetainedReadHeader(req),
      hasVerifiedToolServiceIdentity(req),
    );
    const deadlineMs = readRetainedReadDeadline(req);
    const normalization = retainedReadObject(context.normalizationContext, ['strategySavedScope']);
    const scope = retainedReadObject(normalization.strategySavedScope, [
      'clientId',
      'identityRevision',
      'membershipRevision',
    ]);
    if (
      scope.clientId !== input.clientId ||
      !hash.safeParse(scope.identityRevision).success ||
      !hash.safeParse(scope.membershipRevision).success
    )
      throw refused();
    const conversationClientId =
      context.subject.kind === 'client' ? context.subject.entityIds[0]! : null;
    if (conversationClientId !== null && conversationClientId !== input.clientId) throw refused();
    const selection = {
      conversationId: context.binding.conversationId,
      clientId: conversationClientId,
    };
    const first = await this.current.read(ctx, req, selection);
    if (
      first.identityRevision !== scope.identityRevision ||
      first.membershipRevision !== scope.membershipRevision ||
      !first.clientIds.includes(input.clientId)
    )
      throw refused();
    const expect = {
      identityRevision: first.identityRevision,
      membershipRevision: first.membershipRevision,
      contextRevision: first.contextRevision,
    };
    const active = () => {
      assertMeriToolRequestActive();
      if (Date.now() >= deadlineMs) throw refused();
    };
    active();
    let url: URL;
    try {
      const base = this.config.get<string>('STRATEGY_API_BASE_URL');
      if (!base) throw new Error();
      url = new URL(base);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/strategy-api/saved-reads`;
    } catch {
      throw new ServiceUnavailableException('Saved Strategy owner unavailable');
    }
    const timeout = AbortSignal.timeout(Math.min(15000, Math.max(1, deadlineMs - Date.now())));
    const control = meriToolRequestControl();
    const signal = control?.signal ? AbortSignal.any([control.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: req.headers.authorization!,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
        signal,
        redirect: 'error',
      });
    } catch {
      active();
      throw new ServiceUnavailableException('Saved Strategy owner unavailable');
    }
    active();
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) throw refused();
      if (response.status === 404) throw new NotFoundException('Saved Strategy record not found');
      if (response.status === 400)
        throw new BadRequestException('Saved Strategy selectors refused');
      if (response.status === 413)
        throw new PayloadTooLargeException('Saved Strategy result exceeds read limit');
      throw new ServiceUnavailableException('Saved Strategy owner unavailable');
    }
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      throw invalidOwner();
    }
    let json: unknown;
    try {
      json = await readJson(response);
    } catch (error) {
      active();
      if (error instanceof PayloadTooLargeException) throw error;
      throw invalidOwner();
    }
    const result = receive(input, json);
    active();
    await this.current.read(ctx, req, { ...selection, expect });
    active();
    return result;
  }
}
