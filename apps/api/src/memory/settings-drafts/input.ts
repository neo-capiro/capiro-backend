import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import {
  memoryDraftRequestBytes,
  parseMemoryDraftSave,
  type MemoryDraftSave,
} from '@capiro/shared/settings-memory-drafts';
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
export type DraftWrite = MemoryDraftSave;
export function parseDraftWrite(type: string, value: unknown): DraftWrite {
  let body: DraftWrite;
  try {
    body = parseMemoryDraftSave(value);
  } catch {
    throw new BadRequestException('Invalid memory draft request.');
  }
  const allowed = editableSectionKeys(type);
  if (body.sections.some((section) => !allowed.has(section.key)))
    throw new BadRequestException('Invalid memory draft section.');
  return body;
}
export function draftRequestHash(target: DraftTarget, id: string, write: DraftWrite) {
  return createHash('sha256')
    .update(memoryDraftRequestBytes(target, id, write))
    .digest('hex');
}
