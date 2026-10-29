import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { editableSectionKeys, fileDefForType } from '../memory-catalog.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function draftId(value: string): string {
  if (!UUID.test(value)) throw new BadRequestException('Invalid draft identity.');
  return value;
}
export function draftTarget(type: string, slug: string, userId: string) {
  const def = fileDefForType(type);
  if (!def || (def.scope === 'firm' && slug !== 'firm'))
    throw new BadRequestException('Unknown memory file.');
  return {
    type,
    slug: def.scope === 'user' ? userId : def.scope === 'client' ? draftId(slug) : slug,
    scope: def.scope,
    clientId: def.scope === 'client' ? slug : null,
  };
}
export type DraftTarget = ReturnType<typeof draftTarget>;
export interface DraftWrite {
  requestId: string;
  expectedRevision: number;
  action: 'save' | 'discard';
  baseItemId: string | null;
  baseVersion: string | null;
  sections: Array<{ key: string; body: string }>;
}
export function parseDraftWrite(type: string, value: unknown): DraftWrite {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  const keys = ['requestId', 'expectedRevision', 'action', 'baseItemId', 'baseVersion', 'sections'];
  if (Object.keys(body).length !== keys.length || Object.keys(body).some((k) => !keys.includes(k)))
    invalid();
  if (typeof body.requestId !== 'string') invalid();
  draftId(body.requestId);
  if (
    !Number.isSafeInteger(body.expectedRevision) ||
    (body.expectedRevision as number) < 0 ||
    (body.expectedRevision as number) >= 2147483647
  )
    invalid();
  if (body.action !== 'save' && body.action !== 'discard') invalid();
  if (
    body.baseItemId !== null &&
    (typeof body.baseItemId !== 'string' || !UUID.test(body.baseItemId))
  )
    invalid();
  if (
    body.baseVersion !== null &&
    (typeof body.baseVersion !== 'string' || !/^[a-f0-9]{64}$/.test(body.baseVersion))
  )
    invalid();
  if ((body.baseItemId === null) !== (body.baseVersion === null)) invalid();
  if (!Array.isArray(body.sections) || body.sections.length > 64) invalid();
  const allowed = editableSectionKeys(type),
    seen = new Set<string>();
  for (const section of body.sections) {
    if (
      !section ||
      typeof section !== 'object' ||
      Array.isArray(section) ||
      Object.keys(section).length !== 2 ||
      typeof section.key !== 'string' ||
      typeof section.body !== 'string' ||
      !allowed.has(section.key) ||
      seen.has(section.key)
    )
      invalid();
    seen.add(section.key);
  }
  if (body.action === 'discard' && body.sections.length !== 0) invalid();
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 128 * 1024) invalid();
  return {
    requestId: body.requestId,
    expectedRevision: body.expectedRevision as number,
    action: body.action,
    baseItemId: body.baseItemId as string | null,
    baseVersion: body.baseVersion as string | null,
    sections: body.sections
      .map((s) => ({ key: s.key as string, body: s.body as string }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
}
export function draftRequestHash(target: DraftTarget, id: string, write: DraftWrite) {
  return createHash('sha256')
    .update(JSON.stringify({ schema: 1, target, id, ...write }))
    .digest('hex');
}
function invalid(): never {
  throw new BadRequestException('Invalid memory draft request.');
}
