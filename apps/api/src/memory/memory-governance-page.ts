import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';

export interface GovernancePageRow {
  id: string;
  cursorAt: string;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function governancePageBinding(ctx: TenantContext, view: string, query = ''): string {
  return createHash('sha256')
    .update(JSON.stringify([ctx.tenantId, ctx.userId, view, query]))
    .digest('hex');
}

export function encodeGovernancePage(row: GovernancePageRow, binding: string): string {
  return Buffer.from(JSON.stringify({ v: 1, binding, id: row.id, at: row.cursorAt })).toString(
    'base64url',
  );
}

/** A seek position, never authority. Every page applies current access and filters again. */
export function decodeGovernancePage(raw: unknown, binding: string): GovernancePageRow | null {
  if (raw === undefined) return null;
  try {
    if (typeof raw !== 'string' || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw Error();
    const bytes = Buffer.from(raw, 'base64url');
    if (bytes.toString('base64url') !== raw) throw Error();
    const value = JSON.parse(bytes.toString('utf8'));
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'at,binding,id,v' ||
      value.v !== 1 ||
      value.binding !== binding ||
      typeof value.id !== 'string' ||
      !UUID.test(value.id) ||
      typeof value.at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.at)
    )
      throw Error();
    const millis = value.at.slice(0, 23) + 'Z';
    if (new Date(millis).toISOString() !== millis) throw Error();
    return { id: value.id, cursorAt: value.at };
  } catch {
    throw new BadRequestException('Memory governance cursor is invalid for this view.');
  }
}
