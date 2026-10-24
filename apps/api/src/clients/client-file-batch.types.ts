import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { isUUID } from 'class-validator';

export interface FileBatchMoveCommand {
  schemaVersion: 1;
  requestId: string;
  clientId: string;
  folder: string | null;
  files: Array<{ id: string; expectedRevision: number }>;
}
export interface FileBatchMoveReceipt {
  schemaVersion: 1;
  requestId: string;
  clientId: string;
  payloadDigest: string;
  outcome: 'moved';
  committedAt: string;
  files: Array<{ id: string; previousRevision: number; revision: number; folder: string | null }>;
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('Invalid batch move command');
  return value as Record<string, unknown>;
};
const only = (value: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new BadRequestException('Unknown batch move field');
};
/** Internal callers and HTTP use the same strict, bounded command. */
export function parseFileBatchMove(clientId: string, input: unknown): FileBatchMoveCommand {
  const value = record(input);
  only(value, ['schemaVersion', 'requestId', 'clientId', 'folder', 'files']);
  if (
    value.schemaVersion !== 1 ||
    !isUUID(clientId) ||
    clientId !== clientId.toLowerCase() ||
    value.clientId !== clientId ||
    typeof value.requestId !== 'string' ||
    !isUUID(value.requestId) ||
    value.requestId !== value.requestId.toLowerCase() ||
    !(value.folder === null || typeof value.folder === 'string') ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > 100
  )
    throw new BadRequestException('Invalid batch move command');
  const folder = typeof value.folder === 'string' ? value.folder.trim() || null : null;
  if (folder && folder.length > 120) throw new BadRequestException('Folder name is too long');
  const files = value.files
    .map((input) => {
      const item = record(input);
      only(item, ['id', 'expectedRevision']);
      if (
        typeof item.id !== 'string' ||
        !isUUID(item.id) ||
        item.id !== item.id.toLowerCase() ||
        !Number.isSafeInteger(item.expectedRevision) ||
        Number(item.expectedRevision) < 0 ||
        Number(item.expectedRevision) >= 2_147_483_647
      )
        throw new BadRequestException('Every file needs its current revision');
      return { id: item.id, expectedRevision: Number(item.expectedRevision) };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(files.map((file) => file.id)).size !== files.length)
    throw new BadRequestException('Duplicate file in batch');
  return { schemaVersion: 1, requestId: value.requestId, clientId, folder, files };
}
export function fileBatchDigest(command: FileBatchMoveCommand) {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}
