import { createHash } from 'node:crypto';

export const RESEARCH_SAFE_READ_ARTIFACT_KIND = 'internal_research_safe_read_result';
export const RESEARCH_SAFE_READ_RESULT_VERSION = 1 as const;
export const MAX_RESEARCH_SAFE_READ_RESULT_BYTES = 1_000_000;

export type QualifiedReadClassifier = 'complete' | 'empty';

export interface DurableResearchResultEnvelope {
  version: 1;
  executionId: string;
  providerCallId: string;
  runId: string;
  leaseEpoch: number;
  tool: string;
  toolVersion: string;
  inputSha256: string;
  resultSha256: string;
  classifier: QualifiedReadClassifier;
  input: Record<string, unknown>;
  result: unknown;
  completedAt: string;
}

function normalizeJson(value: unknown, path = '$'): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Durable safe-read JSON contains a non-finite number at ${path}.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalizeJson(item, `${path}[${index}]`));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => {
          const child = record[key];
          if (child === undefined || typeof child === 'function' || typeof child === 'symbol' || typeof child === 'bigint') {
            throw new Error(`Durable safe-read JSON contains an unsupported value at ${path}.${key}.`);
          }
          return [key, normalizeJson(child, `${path}.${key}`)];
        }),
    );
  }
  throw new Error(`Durable safe-read JSON contains an unsupported value at ${path}.`);
}

export function canonicalResearchJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function researchJsonSha256(value: unknown): string {
  return createHash('sha256').update(canonicalResearchJson(value)).digest('hex');
}

export function researchToolVersion(inputSchema: unknown): string {
  return `sha256:${researchJsonSha256(inputSchema)}`;
}

export function sealDurableResearchResult(
  input: Omit<DurableResearchResultEnvelope, 'version' | 'inputSha256' | 'resultSha256'>,
): { envelope: DurableResearchResultEnvelope; body: string; bodySha256: string; byteSize: number } {
  const envelope: DurableResearchResultEnvelope = {
    version: RESEARCH_SAFE_READ_RESULT_VERSION,
    ...input,
    inputSha256: researchJsonSha256(input.input),
    resultSha256: researchJsonSha256(input.result),
  };
  const body = canonicalResearchJson(envelope);
  const byteSize = Buffer.byteLength(body, 'utf8');
  if (byteSize > MAX_RESEARCH_SAFE_READ_RESULT_BYTES) {
    throw new Error(
      `Qualified safe-read result is ${byteSize} bytes; the durable replay limit is ${MAX_RESEARCH_SAFE_READ_RESULT_BYTES} bytes.`,
    );
  }
  return {
    envelope,
    body,
    bodySha256: createHash('sha256').update(body).digest('hex'),
    byteSize,
  };
}

export function openDurableResearchResult(
  body: unknown,
  expectedBodySha256: string,
): DurableResearchResultEnvelope {
  if (typeof body !== 'string') throw new Error('Durable safe-read result body is unavailable.');
  const actualBodySha256 = createHash('sha256').update(body).digest('hex');
  if (actualBodySha256 !== expectedBodySha256) throw new Error('Durable safe-read result hash mismatch.');
  const value = JSON.parse(body) as DurableResearchResultEnvelope;
  if (
    value?.version !== RESEARCH_SAFE_READ_RESULT_VERSION ||
    typeof value.executionId !== 'string' ||
    typeof value.providerCallId !== 'string' ||
    typeof value.runId !== 'string' ||
    !Number.isSafeInteger(value.leaseEpoch) ||
    typeof value.tool !== 'string' ||
    typeof value.toolVersion !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.inputSha256) ||
    !/^[a-f0-9]{64}$/.test(value.resultSha256) ||
    !['complete', 'empty'].includes(value.classifier) ||
    !value.input ||
    typeof value.input !== 'object' ||
    Array.isArray(value.input) ||
    typeof value.completedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    researchJsonSha256(value.input) !== value.inputSha256 ||
    researchJsonSha256(value.result) !== value.resultSha256
  ) {
    throw new Error('Durable safe-read result envelope is invalid.');
  }
  return value;
}
