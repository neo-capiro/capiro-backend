/** Read-only continuation over the existing completed research-session owner.
 * The cursor is a query selector, never authority. Encrypt its last candidate so
 * a skipped, currently inaccessible report cannot leak its identity in a token. */
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOMAIN = 'meri-completed-reports/v1';
const MAX_PAGE = 25;
const LIFETIME_MS = 60 * 60 * 1000;

export interface CompletedReportSummary {
  id: string;
  artifactId: string;
  title: string;
  kind: string;
  clientId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompletedReport extends CompletedReportSummary {
  markdown: string;
}

export interface CompletedReportPosition {
  id: string;
}

interface Query {
  clientId: string | null | undefined;
  limit: number;
}

interface Cursor {
  version: 1;
  owner: string;
  clientId: string | null;
  allClients: boolean;
  limit: number;
  asOf: string;
  expiresAt: number;
  after: CompletedReportPosition;
}

function key(secret: string | undefined): Buffer {
  if (!secret || secret.length < 16)
    throw new ServiceUnavailableException('Completed report continuation is unavailable');
  return createHash('sha256').update(DOMAIN).update('\0').update(secret).digest();
}

function owner(ctx: TenantContext): string {
  return createHash('sha256')
    .update(JSON.stringify([ctx.tenantId, ctx.userId]))
    .digest('hex');
}

function invalid(): never {
  throw new BadRequestException('Completed report continuation does not match this read');
}

function iso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function encode(value: Cursor, secret: string | undefined): string {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  cipher.setAAD(Buffer.from(DOMAIN));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url');
}

function decode(token: string, secret: string | undefined): Cursor {
  const encryptionKey = key(secret);
  try {
    if (!/^[a-zA-Z0-9_-]{40,2048}$/.test(token)) invalid();
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.toString('base64url') !== token) invalid();
    const cipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(DOMAIN));
    cipher.setAuthTag(bytes.subarray(12, 28));
    const value = JSON.parse(
      Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'),
    );
    if (
      !value ||
      Object.keys(value).sort().join() !==
        'after,allClients,asOf,clientId,expiresAt,limit,owner,version' ||
      value.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(value.owner) ||
      typeof value.allClients !== 'boolean' ||
      !(
        value.clientId === null ||
        (typeof value.clientId === 'string' && UUID.test(value.clientId))
      ) ||
      !Number.isSafeInteger(value.limit) ||
      value.limit < 1 ||
      value.limit > MAX_PAGE ||
      !iso(value.asOf) ||
      !Number.isSafeInteger(value.expiresAt) ||
      !value.after ||
      Object.keys(value.after).join() !== 'id' ||
      typeof value.after.id !== 'string' ||
      !UUID.test(value.after.id)
    )
      invalid();
    return value;
  } catch {
    return invalid();
  }
}

/** Only these GET query fields exist. Omitted client means all current-authorized
 * origins; `general` is the explicit General filter, never an inferred client. */
export function completedReportQuery(input: Record<string, unknown>): Query & { cursor?: string } {
  if (!input || Object.keys(input).some((k) => !['clientId', 'limit', 'cursor'].includes(k)))
    invalid();
  const clientId =
    input.clientId === undefined ? undefined : input.clientId === 'general' ? null : input.clientId;
  if (!(
    clientId === undefined ||
    clientId === null ||
    (typeof clientId === 'string' && UUID.test(clientId))
  ))
    invalid();
  const limit =
    input.limit === undefined
      ? 10
      : typeof input.limit === 'string' && /^(?:[1-9]|1[0-9]|2[0-5])$/.test(input.limit)
        ? Number(input.limit)
        : NaN;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_PAGE ||
    (input.cursor !== undefined && typeof input.cursor !== 'string')
  )
    invalid();
  return {
    clientId,
    limit,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor as string }),
  };
}

/** Bounded candidate windows, including entirely denied pages, retain an opaque
 * continuation. No hidden total, skipped identity or false end-of-history claim. */
export async function completedReportPage({
  ctx,
  query,
  secret,
  now,
  candidates,
  read,
}: {
  ctx: TenantContext;
  query: Query & { cursor?: string };
  secret: string | undefined;
  now: () => number;
  candidates: (
    query: Query & { asOf: string; after: CompletedReportPosition | null; take: number },
  ) => Promise<CompletedReportPosition[]>;
  read: (id: string) => Promise<CompletedReportSummary | null>;
}): Promise<{ reports: CompletedReportSummary[]; nextCursor: string | null }> {
  const start = now(),
    cursor = query.cursor === undefined ? null : decode(query.cursor, secret);
  if (
    cursor &&
    (cursor.owner !== owner(ctx) ||
      cursor.clientId !== (query.clientId ?? null) ||
      cursor.allClients !== (query.clientId === undefined) ||
      cursor.limit !== query.limit ||
      cursor.expiresAt <= start ||
      cursor.expiresAt > start + LIFETIME_MS ||
      Date.parse(cursor.asOf) > start)
  )
    invalid();
  const asOf = cursor?.asOf ?? new Date(start).toISOString();
  // At most limit + 1 metadata rows and 2 * limit current-owner checks per page.
  const rows = await candidates({
    ...query,
    asOf,
    after: cursor?.after ?? null,
    take: query.limit + 1,
  });
  const page = rows.slice(0, query.limit),
    admitted: CompletedReportSummary[] = [];
  for (const row of page) {
    const value = await read(row.id);
    if (value?.id === row.id) admitted.push({ ...value });
  }
  const reports: CompletedReportSummary[] = [];
  for (const row of admitted) {
    const value = await read(row.id);
    if (
      value &&
      value.id === row.id &&
      value.artifactId === row.artifactId &&
      value.clientId === row.clientId
    )
      reports.push(value);
  }
  const last = page.at(-1);
  const nextCursor =
    rows.length > query.limit && last
      ? encode(
          {
            version: 1,
            owner: owner(ctx),
            clientId: query.clientId ?? null,
            allClients: query.clientId === undefined,
            limit: query.limit,
            asOf,
            expiresAt: cursor?.expiresAt ?? start + LIFETIME_MS,
            after: { id: last.id },
          },
          secret,
        )
      : null;
  return { reports, nextCursor };
}
