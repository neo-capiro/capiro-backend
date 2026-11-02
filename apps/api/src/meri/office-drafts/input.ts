import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { MAX_DOCUMENT_ARTIFACT_BYTES } from '../meri-artifact-integrity.js';

export const DRAFT_TTL_MS = 7 * 86400000;
export const LOCK_TTL_MS = 30 * 60000;
export const EDITOR_TTL_MS = 10 * 60000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
export const invalid = (): never => { throw new BadRequestException('OFFICE_DRAFT_INPUT'); };
export function object(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).length !== keys.length || keys.some(k => !Object.hasOwn(raw, k))) return invalid();
  return raw as Record<string, unknown>;
}
export function uuid(raw: unknown): string { return typeof raw === 'string' && UUID.test(raw) ? raw : invalid(); }
export function sha(raw: unknown): string { return typeof raw === 'string' && SHA.test(raw) ? raw : invalid(); }
export function sequence(raw: unknown): number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw <= 2147483647 ? raw : invalid();
}
export function lockToken(raw: unknown): string {
  return typeof raw === 'string' && /^[\x20-\x7e]{1,1024}$/.test(raw) ? raw : invalid();
}
export const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export type DraftKey = { conversationId: string; draftId: string };
export function key(body: Record<string, unknown>): DraftKey {
  return { conversationId: uuid(body.conversationId), draftId: uuid(body.draftId) };
}
export function parseKey(raw: unknown): DraftKey { return key(object(raw, ['conversationId', 'draftId'])); }
export type EditorProof = { editorId: string; editorEpoch: number };
export function editorProof(b: Record<string, unknown>): EditorProof {
  const editorEpoch = sequence(b.editorEpoch); if (editorEpoch < 1) return invalid();
  return { editorId: uuid(b.editorId), editorEpoch };
}
export function parseEditorRead(raw: unknown) {
  const b = object(raw, ['conversationId', 'draftId', 'editorId', 'editorEpoch']);
  return { ...key(b), ...editorProof(b) };
}
export type DraftSource = { artifactId: string; baseVersionId: string; baseSha256: string;
  format: 'docx' | 'xlsx' | 'pptx'; filename: string };
export function parseOpen(raw: unknown): DraftKey & DraftSource {
  const b = object(raw, ['conversationId', 'draftId', 'artifactId', 'baseVersionId', 'baseSha256', 'format', 'filename']);
  if (!['docx', 'xlsx', 'pptx'].includes(b.format as string) || typeof b.filename !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,190}$/.test(b.filename) || !b.filename.endsWith('.' + b.format)) return invalid();
  return { ...key(b), artifactId: uuid(b.artifactId), baseVersionId: uuid(b.baseVersionId),
    baseSha256: sha(b.baseSha256), format: b.format as DraftSource['format'], filename: b.filename };
}
export function parseSave(raw: unknown) {
  const b = object(raw, ['conversationId', 'draftId', 'editorId', 'editorEpoch', 'lock', 'expectedSequence', 'sha256', 'bytesBase64', 'kind']);
  if (!['autosave', 'explicit', 'exit'].includes(b.kind as string) || typeof b.bytesBase64 !== 'string' ||
      b.bytesBase64.length > 4 * Math.ceil(MAX_DOCUMENT_ARTIFACT_BYTES / 3) || !b.bytesBase64.length) return invalid();
  const bytes = Buffer.from(b.bytesBase64, 'base64');
  if (!bytes.length || bytes.length > MAX_DOCUMENT_ARTIFACT_BYTES || bytes.toString('base64') !== b.bytesBase64 ||
      digest(bytes) !== sha(b.sha256)) return invalid();
  return { ...key(b), ...editorProof(b), lock: lockToken(b.lock), expectedSequence: sequence(b.expectedSequence),
    sha256: sha(b.sha256), bytes };
}
export type LockInput = DraftKey & EditorProof & { operation: 'get' | 'lock' | 'refresh' | 'unlock' | 'relock'; lock?: string; oldLock?: string };
export function parseLock(raw: unknown): LockInput {
  if (!raw || typeof raw !== 'object') return invalid();
  const operation = (raw as Record<string, unknown>).operation;
  if (!['get', 'lock', 'refresh', 'unlock', 'relock'].includes(operation as string)) return invalid();
  const b = object(raw, ['conversationId', 'draftId', 'editorId', 'editorEpoch', 'operation', ...(operation === 'get' ? [] : ['lock']),
    ...(operation === 'relock' ? ['oldLock'] : [])]);
  return { ...key(b), ...editorProof(b), operation: operation as LockInput['operation'],
    ...(operation === 'get' ? {} : { lock: lockToken(b.lock) }), ...(operation === 'relock' ? { oldLock: lockToken(b.oldLock) } : {}) };
}
