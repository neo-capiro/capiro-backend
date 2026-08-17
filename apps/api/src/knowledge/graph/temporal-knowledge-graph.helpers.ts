import { BadRequestException } from '@nestjs/common';
import {
  normalizeJsonObject,
  normalizeRefs,
  requireDate,
  requireToken,
  requireUuid,
} from '../knowledge.helpers.js';
import type { KnowledgeRef } from '../knowledge.types.js';
import type {
  NormalizedTemporalKnowledgeGraphHistoryInput,
  NormalizedTemporalKnowledgeGraphWalkInput,
  TemporalKnowledgeGraphDirection,
  TemporalKnowledgeGraphHistoryInput,
  TemporalKnowledgeGraphWalkInput,
} from './temporal-knowledge-graph.types.js';

export function canonicalTemporalClientRefKeys(refs: readonly KnowledgeRef[]): string[] {
  const normalized = normalizeRefs([...refs], 'partition.clientRefs');
  const keys = new Set<string>();
  for (const ref of normalized) keys.add(`${ref.type}:${ref.id}`);
  return [...keys].sort();
}

export function normalizeTemporalGraphWalkInput(
  input: TemporalKnowledgeGraphWalkInput,
): NormalizedTemporalKnowledgeGraphWalkInput {
  const tenantId = requireUuid(input.tenantId, 'tenantId');
  const canonicalEntityId = requireUuid(input.canonicalEntityId, 'canonicalEntityId');
  const sensitivity = requireToken(input.partition.sensitivity, 'partition.sensitivity');
  const accessScope = normalizeJsonObject(
    input.partition.accessScope,
    'partition.accessScope',
    {},
  );
  if (Object.keys(accessScope).length === 0) {
    throw new BadRequestException('partition.accessScope must not be empty.');
  }

  return {
    tenantId,
    canonicalEntityId,
    asOf: requireDate(input.asOf, 'asOf'),
    sensitivity,
    accessScope,
    clientRefKeys: canonicalTemporalClientRefKeys(input.partition.clientRefs),
    maxDepth: boundedInteger(input.maxDepth, 2, 1, 5, 'maxDepth'),
    edgeTypes: normalizeEdgeTypes(input.edgeTypes),
    fanout: boundedInteger(input.fanout, 25, 1, 100, 'fanout'),
    rowBudget: boundedInteger(input.rowBudget, 500, 1, 5000, 'rowBudget'),
    direction: normalizeDirection(input.direction),
  };
}

export function normalizeTemporalGraphHistoryInput(
  input: TemporalKnowledgeGraphHistoryInput,
): NormalizedTemporalKnowledgeGraphHistoryInput {
  const tenantId = requireUuid(input.tenantId, 'tenantId');
  const canonicalEntityId = requireUuid(input.canonicalEntityId, 'canonicalEntityId');
  const sensitivity = requireToken(input.partition.sensitivity, 'partition.sensitivity');
  const accessScope = normalizeJsonObject(
    input.partition.accessScope,
    'partition.accessScope',
    {},
  );
  if (Object.keys(accessScope).length === 0) {
    throw new BadRequestException('partition.accessScope must not be empty.');
  }

  const windowStart = requireDate(input.windowStart, 'windowStart');
  const windowEnd = requireDate(input.windowEnd, 'windowEnd');
  const observedThrough = requireDate(input.observedThrough, 'observedThrough');
  if (windowEnd.getTime() <= windowStart.getTime()) {
    throw new BadRequestException('windowEnd must be after windowStart.');
  }

  return {
    tenantId,
    canonicalEntityId,
    windowStart,
    windowEnd,
    observedThrough,
    sensitivity,
    accessScope,
    clientRefKeys: canonicalTemporalClientRefKeys(input.partition.clientRefs),
    edgeTypes: normalizeEdgeTypes(input.edgeTypes),
    rowBudget: boundedInteger(input.rowBudget, 500, 1, 5000, 'rowBudget'),
    direction: normalizeDirection(input.direction),
  };
}

function normalizeEdgeTypes(values: readonly string[] | undefined): string[] | null {
  if (values === undefined) return null;
  if (!Array.isArray(values)) throw new BadRequestException('edgeTypes must be an array.');
  const normalized = new Set<string>();
  for (const [index, value] of values.entries()) {
    normalized.add(requireToken(value, `edgeTypes[${index}]`));
  }
  return [...normalized].sort();
}

function normalizeDirection(
  value: TemporalKnowledgeGraphDirection | undefined,
): TemporalKnowledgeGraphDirection {
  const normalized = value ?? 'both';
  if (normalized !== 'out' && normalized !== 'in' && normalized !== 'both') {
    throw new BadRequestException('direction must be out, in, or both.');
  }
  return normalized;
}

function boundedInteger(
  raw: number | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  const value = raw ?? fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new BadRequestException(`${field} must be an integer between ${min} and ${max}.`);
  }
  return value;
}
