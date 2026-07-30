import { Prisma } from '@prisma/client';
import { sourceBaseKey } from './source-priority.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function omitUndefined(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.map(omitUndefined).filter((entry) => entry !== undefined);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const cleaned = omitUndefined(entry);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return value;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  const cleaned = omitUndefined(value);
  if (cleaned === undefined || cleaned === null) return {};
  return JSON.parse(JSON.stringify(cleaned)) as Prisma.InputJsonValue;
}

function sourcePayloadMap(raw: Record<string, unknown>): Record<string, unknown> {
  return isRecord(raw.sourcePayloads) ? { ...raw.sourcePayloads } : {};
}

/**
 * Preserve all existing enrichment and isolate ordinary payloads by source.
 * P-40 and OP-5 details remain top-level for existing readers.
 */
export function mergeProgramElementRaw(
  existingRaw: unknown,
  incomingRaw: unknown,
  source: string,
): Prisma.InputJsonValue {
  const existing = isRecord(existingRaw) ? { ...existingRaw } : {};
  const incoming = isRecord(incomingRaw) ? incomingRaw : null;
  const sourcePayloads = sourcePayloadMap(existing);
  sourcePayloads[sourceBaseKey(source)] = omitUndefined(incomingRaw) ?? null;

  const merged: Record<string, unknown> = {
    ...existing,
    sourcePayloads,
  };

  if (incoming) {
    if ('pDocDetail' in incoming && incoming.pDocDetail !== undefined) {
      merged.pDocDetail = omitUndefined(incoming.pDocDetail);
    }
    if ('op5Detail' in incoming && incoming.op5Detail !== undefined) {
      merged.op5Detail = omitUndefined(incoming.op5Detail);
    }
  }

  return jsonValue(merged);
}

export function mergeProgramElementYearRaw(
  existingRaw: unknown,
  incomingRaw: unknown,
  source: string,
  fieldSources: Record<string, string>,
  sourceAttribution: Record<string, string>,
  datesAdded: Record<string, string>,
): Prisma.InputJsonValue {
  const merged = mergeProgramElementRaw(existingRaw, incomingRaw, source) as Record<string, unknown>;
  return jsonValue({
    ...merged,
    fieldSources: { ...fieldSources },
    sourceAttribution: { ...sourceAttribution },
    datesAdded: { ...datesAdded },
  });
}
