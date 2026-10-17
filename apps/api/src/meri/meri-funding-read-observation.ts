import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { hasVerifiedToolServiceIdentity } from './tool-service-secret.guard.js';
import { resolveEvidenceAccuracyModeForTenant } from '../common/meri-evidence-accuracy-flags.js';
import type { CapabilityRolloutMode } from '@capiro/meriv2-core';

const HEADER = 'x-meri-read-observation';
const SCHEMA_VERSION = 'meri-native-read-observation/1';
const MAX_DECODED_BYTES = 2048;
const FUNDING_READS = [
  'search_funding_opportunities',
  'get_funding_opportunity_requirements',
  'get_funding_opportunity',
  'get_opportunity_client_context',
  'get_opportunity_government_landscape',
] as const;

type FundingReadOperation = (typeof FUNDING_READS)[number];
const KB_READ = 'search_client_knowledge' as const;
type ClockReadOperation = FundingReadOperation | typeof KB_READ;
export const MERI_EVIDENCE_MODE_READS = [
  'search_federal_grants',
  'search_federal_awards',
  'search_program_elements',
  'get_program_element',
  'get_pe_budget_timeline',
] as const;
export type MeriEvidenceModeReadOperation = (typeof MERI_EVIDENCE_MODE_READS)[number];
type ObservedReadOperation = ClockReadOperation | MeriEvidenceModeReadOperation;

interface MeriClockReadObservation {
  readonly operationId: ClockReadOperation;
  readonly asOf: string;
}
export interface MeriEvidenceModeObservation {
  readonly operationId: MeriEvidenceModeReadOperation;
  readonly evidenceAccuracyMode: CapabilityRolloutMode;
}
export type MeriReadObservation = MeriClockReadObservation | MeriEvidenceModeObservation;

export interface MeriFundingReadObservation {
  readonly operationId: FundingReadOperation;
  readonly asOf: string;
}

const storage = new AsyncLocalStorage<MeriReadObservation>();

function invalid(): never {
  throw new BadRequestException('Funding read observation is invalid');
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      invalid();
    }
  }
}

/** JSON-only equivalent of the private Meri contract's canonicalize(request). */
function canonicalJson(value: unknown): string {
  if (typeof value === 'string') {
    assertWellFormedUnicode(value);
    return JSON.stringify(value);
  }
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return invalid();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!record(value)) return invalid();
  return `{${Object.keys(value)
    .sort()
    .map((key) => {
      assertWellFormedUnicode(key);
      return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
    })
    .join(',')}}`;
}

function isFundingRead(name: string): name is FundingReadOperation {
  return (FUNDING_READS as readonly string[]).includes(name);
}

function isObservedRead(name: string): name is ObservedReadOperation {
  return isFundingRead(name) || name === KB_READ || isMeriEvidenceModeRead(name);
}

export function isMeriEvidenceModeRead(name: string): name is MeriEvidenceModeReadOperation {
  return (MERI_EVIDENCE_MODE_READS as readonly string[]).includes(name);
}

function assertKnowledgeBody(body: Record<string, unknown>): void {
  if (
    typeof body.query !== 'string' ||
    Object.keys(body).some((key) => !['query', 'clientId', 'kind', 'limit'].includes(key)) ||
    ('clientId' in body && body.clientId !== null && typeof body.clientId !== 'string') ||
    ('kind' in body && body.kind !== null && typeof body.kind !== 'string') ||
    ('limit' in body && body.limit !== null &&
      typeof body.limit !== 'string' && typeof body.limit !== 'number')
  ) invalid();
}

/**
 * The header is a calculation anchor, never an authorization grant. Route,
 * original flat body, native bearer and an actually matched internal-service
 * secret must all be established before the existing producer is called.
 */
export function admitMeriReadObservation(
  name: string,
  rawBody: unknown,
  request: Request,
): MeriReadObservation | undefined {
  const carrier = request.headers[HEADER];
  if (carrier === undefined) return undefined;
  if (!hasVerifiedToolServiceIdentity(request)) {
    throw new ForbiddenException('Funding read observation requires verified service identity');
  }
  if (!isObservedRead(name) || !record(rawBody) || typeof carrier !== 'string') invalid();
  if (name === KB_READ) assertKnowledgeBody(rawBody);
  if (
    carrier.length === 0 ||
    carrier.length > Math.ceil((MAX_DECODED_BYTES * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/u.test(carrier)
  ) invalid();

  try {
    const decoded = Buffer.from(carrier, 'base64url');
    if (decoded.byteLength > MAX_DECODED_BYTES || decoded.toString('base64url') !== carrier) {
      return invalid();
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(decoded);
    const value: unknown = JSON.parse(text);
    if (!record(value) || !exactKeys(value, ['schemaVersion', 'operation', 'requestSha256', 'context'])) {
      return invalid();
    }
    const operation = value.operation;
    const context = value.context;
    if (
      value.schemaVersion !== SCHEMA_VERSION ||
      !record(operation) ||
      !exactKeys(operation, ['id', 'version']) ||
      operation.id !== name ||
      operation.version !== '0.2.0' ||
      !record(context) ||
      typeof value.requestSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.requestSha256) ||
      value.requestSha256 !== createHash('sha256').update(canonicalJson(rawBody), 'utf8').digest('hex') ||
      !Buffer.from(canonicalJson(value), 'utf8').equals(decoded)
    ) {
      return invalid();
    }
    if (isMeriEvidenceModeRead(name)) {
      if (!exactKeys(context, ['evidenceAccuracyMode']) ||
          !['off', 'shadow', 'enforce'].includes(context.evidenceAccuracyMode as string)) invalid();
      return Object.freeze({ operationId: name, evidenceAccuracyMode: context.evidenceAccuracyMode as CapabilityRolloutMode });
    }
    if (!exactKeys(context, ['asOf']) || typeof context.asOf !== 'string' ||
        !/^(?:[0-9]{4}|[+-][0-9]{6})-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u.test(context.asOf) ||
        new Date(context.asOf).toISOString() !== context.asOf) invalid();
    return Object.freeze({ operationId: name, asOf: context.asOf });
  } catch {
    return invalid();
  }
}

/** Preserve the original funding-only decoder for existing callers. */
export function admitMeriFundingReadObservation(
  name: string,
  rawBody: unknown,
  request: Request,
): MeriFundingReadObservation | undefined {
  const observation = admitMeriReadObservation(name, rawBody, request);
  if (!observation) return undefined;
  if (!isFundingRead(observation.operationId)) invalid();
  return observation as MeriFundingReadObservation;
}

export function withMeriReadObservation<T>(
  observation: MeriReadObservation,
  run: () => T,
): T {
  return storage.run(Object.freeze({ ...observation }), run);
}

export function withMeriFundingReadObservation<T>(
  observation: MeriFundingReadObservation,
  run: () => T,
): T {
  return withMeriReadObservation(observation, run);
}

export function currentMeriReadAsOf(name: ClockReadOperation): string | undefined {
  const observation = storage.getStore();
  if (!observation) return undefined;
  if (observation.operationId !== name || !('asOf' in observation)) {
    throw new ForbiddenException('Funding read observation does not match this operation');
  }
  return observation.asOf;
}

/** Expected mode cannot select policy: compare the canonical current owner, then consume its actual enum. */
export function currentMeriEvidenceAccuracyMode(
  name: MeriEvidenceModeReadOperation,
  tenantId: string | null | undefined,
): CapabilityRolloutMode | undefined {
  const observation = storage.getStore();
  if (!observation) return undefined;
  if (observation.operationId !== name || !('evidenceAccuracyMode' in observation)) {
    throw new ForbiddenException('Read mode observation does not match this operation');
  }
  const actual = resolveEvidenceAccuracyModeForTenant(tenantId, 'chat');
  if (actual !== observation.evidenceAccuracyMode) {
    throw new ForbiddenException('Current read mode changed; reload');
  }
  return actual;
}

/** Pass undefined on the legacy path so the producer retains its own clock. */
export function currentMeriFundingReadAsOf(name: FundingReadOperation): Date | undefined {
  const asOf = currentMeriReadAsOf(name);
  return asOf ? new Date(asOf) : undefined;
}
