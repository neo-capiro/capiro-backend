import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

export const ownerUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function exactRevision(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value))
    return false;
  const milliseconds = value.slice(0, 23) + 'Z';
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) && date.toISOString() === milliseconds;
}
export interface HistorySeek {
  revision: string;
  createdAt: string;
  id: string;
}
export function ownerReadBinding(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
export function ownerReadLimit(raw: unknown): number {
  if (raw === undefined) return 25;
  if (
    (typeof raw !== 'number' && typeof raw !== 'string') ||
    !/^(?:[1-9]|[1-9][0-9]|100)$/.test(String(raw))
  )
    throw new BadRequestException('Invalid page limit.');
  return Number(raw);
}
/** A seek hint, never an authorization token or snapshot proof. */
export function encodeHistoryCursor(seek: HistorySeek, binding: string): string {
  return Buffer.from(JSON.stringify({ v: 1, binding, ...seek })).toString('base64url');
}
export function decodeHistoryCursor(raw: unknown, binding: string): HistorySeek | null {
  if (raw === undefined) return null;
  try {
    if (typeof raw !== 'string' || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw Error();
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'binding,createdAt,id,revision,v' ||
      value.v !== 1 ||
      value.binding !== binding ||
      !exactRevision(value.revision) ||
      !exactRevision(value.createdAt) ||
      typeof value.id !== 'string' ||
      !ownerUuid.test(value.id)
    )
      throw Error();
    return { revision: value.revision, createdAt: value.createdAt, id: value.id };
  } catch {
    throw new BadRequestException('Invalid memory cursor.');
  }
}
