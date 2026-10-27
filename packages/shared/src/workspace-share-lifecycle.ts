// Server-only canonical Workspace sharing owner. Do not export from the browser barrel.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type WorkspaceShareKind = 'workspace_document' | 'research_portfolio';
export const RESEARCH_SHARE_LIFETIME_MS = 168 * 60 * 60 * 1000;

export interface WorkspaceShareRecord {
  id: string;
  tenantId: string;
  kind: WorkspaceShareKind;
  resourceId: string;
  tokenHash: string;
  operationKey: string | null;
  requestHash: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

// Adapter boundary shared by the separately generated Core and Workspace Prisma clients.
// Callers supply a transaction delegate; no client or credentials are retained here.
export interface WorkspaceSharePersistence<Row extends WorkspaceShareRecord> {
  findFirst(args: { where: Record<string, unknown>; [key: string]: unknown }): Promise<Row | null>;
  findMany(args: { where: Record<string, unknown>; [key: string]: unknown }): Promise<Row[]>;
  create(args: { data: Record<string, unknown>; [key: string]: unknown }): Promise<Row>;
  update(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
    [key: string]: unknown;
  }): Promise<Row>;
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
}

export class ShareOperationConflict extends Error {
  constructor() {
    super('Share operation belongs to a different immutable request');
  }
}

export function hashWorkspaceShareToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`;
}

export function workspaceShareRequestHash(request: unknown): string {
  return hashWorkspaceShareToken(canonical(request));
}

/** The issuing domain must hold its resource lock and authorize before calling create/revoke. */
export class WorkspaceShareLifecycle<Row extends WorkspaceShareRecord> {
  constructor(
    private readonly store: WorkspaceSharePersistence<Row>,
    readonly kind: WorkspaceShareKind,
  ) {}

  findFirst(args: { where: Record<string, unknown>; [key: string]: unknown }): Promise<Row | null> {
    return this.store.findFirst({ ...args, where: { ...args.where, kind: this.kind } });
  }

  findMany(args: { where: Record<string, unknown>; [key: string]: unknown }): Promise<Row[]> {
    return this.store.findMany({ ...args, where: { ...args.where, kind: this.kind } });
  }

  count(args: { where: Record<string, unknown> }): Promise<number> {
    return this.store.count({ where: { ...args.where, kind: this.kind } });
  }

  update(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
    [key: string]: unknown;
  }): Promise<Row> {
    return this.store.update({ ...args, where: { ...args.where, kind: this.kind } });
  }

  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }> {
    return this.store.updateMany({ ...args, where: { ...args.where, kind: this.kind } });
  }

  revokeAll(
    where: Record<string, unknown>,
    data: Record<string, unknown> = {},
  ): Promise<{ count: number }> {
    return this.store.updateMany({
      where: { ...where, kind: this.kind, revokedAt: null },
      data: { ...data, revokedAt: new Date() },
    });
  }

  async operation(
    tenantId: string,
    resourceId: string,
    operationKey: string,
    request?: unknown,
  ): Promise<Row | null> {
    const row = await this.findFirst({ where: { tenantId, resourceId, operationKey } });
    if (row && request !== undefined && row.requestHash !== workspaceShareRequestHash(request))
      throw new ShareOperationConflict();
    return row;
  }

  async publish(input: {
    tenantId: string;
    resourceId: string;
    createdById: string;
    operationKey?: string;
    request: unknown;
    payload: unknown;
    data?: Record<string, unknown>;
    expiresInDays?: number;
    now?: Date;
    include?: Record<string, unknown>;
  }): Promise<{ row: Row; token: string | null; replayed: boolean }> {
    if (input.operationKey) {
      const prior = await this.operation(
        input.tenantId,
        input.resourceId,
        input.operationKey,
        input.request,
      );
      if (prior) return { row: prior, token: null, replayed: true };
    }
    if (
      input.expiresInDays !== undefined &&
      (!Number.isSafeInteger(input.expiresInDays) ||
        input.expiresInDays < 1 ||
        input.expiresInDays > 3650)
    ) {
      throw new RangeError('Share lifetime must be between 1 and 3650 days');
    }
    const now = input.now ?? new Date();
    const expiresAt =
      this.kind === 'research_portfolio'
        ? new Date(now.getTime() + RESEARCH_SHARE_LIFETIME_MS)
        : input.expiresInDays
          ? new Date(now.getTime() + input.expiresInDays * 86400000)
          : null;
    const token = randomBytes(32).toString('hex');
    const payloadJson = JSON.stringify(input.payload);
    if (Buffer.byteLength(payloadJson, 'utf8') > 8 * 1024 * 1024)
      throw new RangeError('The complete shared content exceeds the 8 MiB publication limit');
    const row = await this.store.create({
      data: {
        ...input.data,
        tenantId: input.tenantId,
        kind: this.kind,
        resourceId: input.resourceId,
        createdById: input.createdById,
        operationKey: input.operationKey ?? null,
        requestHash: workspaceShareRequestHash(input.request),
        tokenHash: hashWorkspaceShareToken(token),
        payload: input.payload,
        payloadHash: hashWorkspaceShareToken(payloadJson),
        createdAt: now,
        expiresAt,
      },
      ...(input.include ? { include: input.include } : {}),
    });
    return { row, token, replayed: false };
  }

  async byToken(token: string): Promise<Row | null> {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
    const tokenHash = hashWorkspaceShareToken(token);
    const row = await this.findFirst({ where: { tokenHash } });
    if (!row || !/^[0-9a-f]{64}$/.test(row.tokenHash)) return null;
    return timingSafeEqual(Buffer.from(row.tokenHash, 'hex'), Buffer.from(tokenHash, 'hex'))
      ? row
      : null;
  }

  isLive(row: Row, now = Date.now()): boolean {
    return !row.revokedAt && (!row.expiresAt || row.expiresAt.getTime() > now);
  }

  async revoke(
    row: Row,
    data: Record<string, unknown> = {},
    include?: Record<string, unknown>,
  ): Promise<Row> {
    if (row.revokedAt) return row;
    return this.update({
      where: { id: row.id, tenantId: row.tenantId, resourceId: row.resourceId },
      data: { ...data, revokedAt: new Date() },
      ...(include ? { include } : {}),
    });
  }
}
