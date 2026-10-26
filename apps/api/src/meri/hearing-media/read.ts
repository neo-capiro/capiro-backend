import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { MeriToolsService } from '../meri-tools.service.js';
import {
  assertMeriToolRequestActive,
  meriToolRequestControl,
} from '../meri-tool-request-control.js';

const invalid = () => {
  throw new BadRequestException('Invalid saved hearing media request');
};
function object(value: unknown, keys: string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    return invalid();
  return value as Record<string, unknown>;
}
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

/** The caller supplies identity to compare, never a media URL or permission. */
export function readHearingMediaRequest(raw: unknown) {
  const body = object(raw, ['schemaVersion', 'selection', 'source', 'playback']);
  if (body.schemaVersion !== 'capiro.hearing-media-read/1') invalid();
  const selection = object(body.selection, [
    'recordsView',
    'hearingId',
    'recordId',
    'clientId',
    'asOf',
    'cursor',
  ]);
  if (
    !['published', 'briefs', 'reconciliation'].includes(String(selection.recordsView)) ||
    !text(selection.hearingId, 200) ||
    !text(selection.recordId, 200) ||
    (selection.clientId !== null &&
      (typeof selection.clientId !== 'string' ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(selection.clientId))) ||
    (selection.asOf !== null &&
      (typeof selection.asOf !== 'string' ||
        !/^\d{4}-\d\d-\d\dT/.test(selection.asOf) ||
        !Number.isFinite(Date.parse(selection.asOf)))) ||
    (selection.cursor !== null && !text(selection.cursor, 1024))
  )
    invalid();
  const source = object(body.source, ['recordId', 'contentHash']);
  if (
    !text(source.recordId, 500) ||
    typeof source.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(source.contentHash)
  )
    invalid();
  let playback: { epochId: string; positionMs: number } | null = null;
  if (body.playback !== null) {
    const value = object(body.playback, ['epochId', 'positionMs']);
    if (
      !text(value.epochId, 200) ||
      !Number.isSafeInteger(value.positionMs) ||
      Number(value.positionMs) < 0 ||
      Number(value.positionMs) > 86400000
    )
      invalid();
    playback = { epochId: value.epochId as string, positionMs: value.positionMs as number };
  }
  return {
    selection,
    source: { recordId: source.recordId as string, contentHash: source.contentHash as string },
    playback,
  };
}

async function ownerResponse(response: Response) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (response.status === 401 || response.status === 403)
      throw new ForbiddenException('Hearing media access unavailable');
    if (
      !response.ok ||
      response.redirected ||
      !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')
    )
      throw new ServiceUnavailableException('Hearing media unavailable');
    reader = response.body?.getReader();
    if (!reader) throw new ServiceUnavailableException('Hearing media unavailable');
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > 65536)
        throw new ServiceUnavailableException('Hearing media response exceeded its bound');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    if (reader) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    } else await response.body?.cancel().catch(() => undefined);
  }
}

async function assertCurrentSource(
  tools: Pick<MeriToolsService, 'executeFromAuthenticatedUser'>,
  ctx: TenantContext,
  input: ReturnType<typeof readHearingMediaRequest>,
) {
  assertMeriToolRequestActive();
  const result = (await tools.executeFromAuthenticatedUser(
    ctx,
    'search_committee_hearings',
    input.selection,
  )) as {
    records?: Array<{
      recordId?: string;
      provenance?: { hearingId?: string; contentHash?: string };
    }>;
  };
  assertMeriToolRequestActive();
  const record = result.records?.[0];
  if (
    result.records?.length !== 1 ||
    record?.recordId !== input.source.recordId ||
    record.provenance?.hearingId !== input.selection.hearingId ||
    record.provenance?.contentHash !== input.source.contentHash
  )
    throw new ConflictException('Saved hearing record changed or is unavailable');
}

async function currentActor(prisma: PrismaService, ctx: TenantContext) {
  assertMeriToolRequestActive();
  const actor = await prisma.withTenantUser(
    ctx.tenantId,
    ctx.userId,
    async (tx) =>
      tx.$queryRaw<
        Array<{ actor: string }>
      >`SELECT u.clerk_user_id AS actor FROM users u JOIN tenant_memberships m ON m.user_id=u.id
      WHERE u.id=${ctx.userId}::uuid AND m.tenant_id=${ctx.tenantId}::uuid AND m.status::text='active'`,
  );
  assertMeriToolRequestActive();
  if (!actor[0]?.actor) throw new ForbiddenException('Current hearing access unavailable');
  return actor[0].actor;
}

/** Reuse the governed exact-record read and Intel's permission/signing owner. */
export async function readSavedHearingMedia(
  prisma: PrismaService,
  tools: Pick<MeriToolsService, 'executeFromAuthenticatedUser'>,
  ctx: TenantContext,
  raw: unknown,
  fetchImpl: typeof fetch = fetch,
) {
  const input = readHearingMediaRequest(raw);
  await assertCurrentSource(tools, ctx, input);
  const actor = await currentActor(prisma, ctx);
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  if (!secret) throw new ServiceUnavailableException('Hearing media owner unavailable');
  const source = { hearingId: input.selection.hearingId, ...input.source };
  const lifetime = meriToolRequestControl();
  const timeout = AbortSignal.timeout(15000);
  const signal = lifetime?.signal ? AbortSignal.any([lifetime.signal, timeout]) : timeout;
  const response = await fetchImpl(
    (process.env.TRACKER_APP_BASE_URL ?? 'https://app.capiro.ai').replace(/\/+$/, '') +
      '/intel-api/internal/hearing-record-retrieval/media',
    {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { 'content-type': 'application/json', 'x-internal-service-secret': secret },
      body: JSON.stringify({
        tenantId: ctx.tenantId,
        actor,
        eventId: source.hearingId,
        playback: input.playback,
      }),
    },
  );
  const media = await ownerResponse(response);
  // Owner I/O cannot carry an earlier permission or record version into release.
  await assertCurrentSource(tools, ctx, input);
  if ((await currentActor(prisma, ctx)) !== actor)
    throw new ForbiddenException('Current hearing access unavailable');
  assertMeriToolRequestActive();
  return { schemaVersion: 'capiro.hearing-media-read/1' as const, source, media };
}
