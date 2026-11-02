import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { parseSamResponseJson } from './sam-response-json.js';
import type { SamRecord } from './sam-contract-action.js';

export const SAM_SEARCH_URL = 'https://api.sam.gov/contract-awards/v1/search';
export const sha256Bytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export function readCohortFile(path: string): Buffer {
  if (!lstatSync(path).isFile()) throw new Error('FINITE_COHORT_FILE_INVALID');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384) throw new Error('FINITE_COHORT_FILE_INVALID');
    const bytes = Buffer.alloc(16385), count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > 16384) throw new Error('FINITE_COHORT_FILE_TOO_LARGE');
    return bytes.subarray(0, count);
  } finally { closeSync(fd); }
}
export interface FiniteEvidence { write(name: string, bytes: Uint8Array): void }
/** The admitted deployment is POSIX. Windows chmod does not establish owner-only ACLs. */
export function createPrivateEvidenceDirectory(path: string): FiniteEvidence {
  if (process.platform === 'win32' || !isAbsolute(path)) throw new Error('PRIVATE_POSIX_EVIDENCE_DIRECTORY_REQUIRED');
  mkdirSync(path, { mode: 0o700 }); // Exclusive: never reuse/resume an earlier invocation directory.
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid!())
    throw new Error('PRIVATE_EVIDENCE_DIRECTORY_INVALID');
  // Persist the new run-directory entry before any provider/DB effect can depend on its evidence.
  const parent = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  return { write(name, bytes) {
    if (!/^[a-z0-9-]+\.(?:json|bin)$/.test(name)) throw new Error('EVIDENCE_FILENAME_INVALID');
    const fd = openSync(join(path, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
        if (written < 1) throw new Error('EVIDENCE_WRITE_FAILED');
        offset += written;
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const directory = openSync(path, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } };
}
export interface StagedSamPage {
  records: SamRecord[]; bytes: number; sha256: string; totalRecords: number | null;
  historyIncomplete: boolean; observedAt: string; status: number;
}
/** Exactly one HTTP request, including redirects; timer remains active through body streaming. */
export async function stageSamPage(input: {
  apiKey: string; piid: string; file: string; evidence: FiniteEvidence; maxBytes: number;
  responseMs: number; remaining(): number; now(): number; fetch: typeof fetch;
  onResponse?(status: number): void; onBodyComplete?(): void;
}): Promise<StagedSamPage> {
  const controller = new AbortController();
  const pageBudget = Math.min(input.responseMs, input.remaining()), started = performance.now();
  const timer = setTimeout(() => controller.abort(), pageBudget);
  const guard = () => {
    input.remaining();
    if (controller.signal.aborted || performance.now() - started >= pageBudget) throw new Error('SOURCE_RESPONSE_TIMEOUT');
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const chunks: Uint8Array[] = [];
  let bytes = 0, evidenceWritten = false;
  const retain = () => {
    if (!evidenceWritten) { input.evidence.write(input.file, Buffer.concat(chunks)); evidenceWritten = true; }
  };
  try {
    const query = new URLSearchParams({ api_key: input.apiKey, piid: input.piid, limit: '100', offset: '0' });
    const response = await input.fetch(`${SAM_SEARCH_URL}?${query}`, { redirect: 'error',
      headers: { Accept: 'application/json', 'User-Agent': 'capiro-contract-awards/finite-v1' }, signal: controller.signal });
    input.onResponse?.(response.status);
    guard();
    if (response.body) {
      reader = response.body.getReader();
      while (true) {
        const part = await reader.read(); guard();
        if (part.done) break;
        const available = input.maxBytes - bytes;
        if (part.value.byteLength > available) {
          if (available > 0) chunks.push(part.value.subarray(0, available));
          bytes += Math.max(available, 0); retain();
          throw new Error('SOURCE_BODY_LIMIT');
        }
        chunks.push(part.value); bytes += part.value.byteLength;
      }
    }
    retain(); input.onBodyComplete?.(); guard();
    if (!response.ok) throw new Error(`SOURCE_HTTP_${response.status}`);
    const raw = Buffer.concat(chunks);
    const parsed = response.status === 204 ? { awardSummary: [], totalRecords: 0 }
      : parseSamResponseJson(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('SOURCE_ENVELOPE_INVALID');
    const body = parsed as { awardSummary?: unknown; totalRecords?: unknown };
    if (!Array.isArray(body.awardSummary) || body.awardSummary.length > 100
      || body.awardSummary.some((record) => !record || typeof record !== 'object' || Array.isArray(record)))
      throw new Error('SOURCE_RECORD_LIMIT_OR_SHAPE');
    if (body.totalRecords !== undefined && (!Number.isSafeInteger(body.totalRecords) || Number(body.totalRecords) < 0))
      throw new Error('SOURCE_TOTAL_INVALID');
    guard();
    const totalRecords = body.totalRecords === undefined ? null : body.totalRecords as number;
    return { records: body.awardSummary, bytes, sha256: sha256Bytes(raw), totalRecords,
      historyIncomplete: body.awardSummary.length === 100 || (totalRecords !== null && totalRecords > body.awardSummary.length),
      observedAt: new Date(input.now()).toISOString(), status: response.status };
  } catch (error) {
    retain();
    if (error instanceof Error && /^(?:SOURCE_[A-Z0-9_]+|FINITE_DEADLINE_EXCEEDED)$/.test(error.message)) throw error;
    throw new Error(controller.signal.aborted ? 'SOURCE_RESPONSE_TIMEOUT' : 'SOURCE_TRANSPORT_OR_PARSE_FAILURE');
  } finally {
    clearTimeout(timer); controller.abort();
    if (reader) { try { await reader.cancel(); } catch { /* Native transport already failed. */ } reader.releaseLock(); }
  }
}
