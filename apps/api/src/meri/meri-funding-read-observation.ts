import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { hasVerifiedToolServiceIdentity } from './tool-service-secret.guard.js';
import { resolveEvidenceAccuracyModeForTenant } from '../common/meri-evidence-accuracy-flags.js';
import type { CapabilityRolloutMode } from '@capiro/meriv2-core';
import type { TenantContext } from '@capiro/shared';
import type { MeriReadDelegationGrant } from '../auth/read-delegation/read-delegation-request.js';
import {
  isMeriEvidenceModeRead,
  MERI_EVIDENCE_MODE_READS,
  type MeriEvidenceModeReadOperation,
} from '../auth/meri-evidence-mode-reads.js';

// Compatibility re-exports: the list and predicate are owned by the neutral
// authority module so application authority does not import this directory.
export { isMeriEvidenceModeRead, MERI_EVIDENCE_MODE_READS, type MeriEvidenceModeReadOperation };

const HEADER = 'x-meri-read-observation';
const SCHEMA_VERSION = 'meri-native-read-observation/1';
const MAX_DECODED_BYTES = 2048;
const FUNDING_READS = [
  'search_funding_opportunities',
  'get_funding_opportunity_requirements',
  'get_funding_opportunity',
  'get_opportunity_client_context',
  'get_opportunity_government_landscape',
  'explain_opportunity_match',
  'compare_funding_opportunities',
  'build_opportunity_action_plan',
] as const;

type FundingReadOperation = (typeof FUNDING_READS)[number];
const KB_READ = 'search_client_knowledge' as const;
type ClockReadOperation = FundingReadOperation | typeof KB_READ;
const SECOND_PACKAGE_READS = [
  'get_certification_status', 'get_state_rule_status', 'search_sam_opportunities',
] as const;
type SecondPackageReadOperation = (typeof SECOND_PACKAGE_READS)[number];
type ObservedReadOperation = ClockReadOperation | MeriEvidenceModeReadOperation | SecondPackageReadOperation;

interface MeriClockReadObservation {
  readonly operationId: ClockReadOperation;
  readonly asOf: string;
}
export interface MeriEvidenceModeObservation {
  readonly operationId: Exclude<MeriEvidenceModeReadOperation, 'search_sam_opportunities'>;
  readonly evidenceAccuracyMode: CapabilityRolloutMode;
}
export interface MeriCertificationObservation {
  readonly operationId: 'get_certification_status';
  readonly comparisonLocale: string;
}
export interface MeriRuleStatusObservation {
  readonly operationId: 'get_state_rule_status';
  readonly stageAsOf: string;
  readonly commentAsOf: string;
}
export interface MeriSamObservation {
  readonly operationId: 'search_sam_opportunities';
  readonly asOf: string;
  readonly sourceStatusAsOf: string;
  readonly sourceHealthAsOf: string;
  readonly evidenceAccuracyMode: CapabilityRolloutMode;
}
export type MeriReadObservation = MeriClockReadObservation | MeriEvidenceModeObservation |
  MeriCertificationObservation | MeriRuleStatusObservation | MeriSamObservation;

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

function isSecondPackageRead(name: string): name is SecondPackageReadOperation {
  return (SECOND_PACKAGE_READS as readonly string[]).includes(name);
}

function isObservedRead(name: string): name is ObservedReadOperation {
  return isFundingRead(name) || name === KB_READ || isMeriEvidenceModeRead(name) || isSecondPackageRead(name);
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' ||
      !/^(?:[0-9]{4}|[+-][0-9]{6})-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u.test(value)) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function canonicalSupportedLocale(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 2 || value.length > 128) return false;
  try {
    const canonical = Intl.getCanonicalLocales(value);
    return canonical.length === 1 && canonical[0] === value &&
      Intl.Collator.supportedLocalesOf(canonical, { localeMatcher: 'lookup' }).length === 1;
  } catch { return false; }
}

/** Calculation inputs do not grant access. The existing authenticated Core
 * principal and verified service admit native calls; any actual delegated
 * call must additionally match its original immutable target. */
function assertSecondPackageTarget(
  name: SecondPackageReadOperation,
  request: Request,
  ctx?: Pick<TenantContext, 'tenantId' | 'userId'>,
  grant?: MeriReadDelegationGrant,
): void {
  const target = `/api/clio/tools/${name}`;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  if (!ctx || !uuid.test(ctx.tenantId) || !uuid.test(ctx.userId) || request.method !== 'POST' ||
      request.path !== target || (request.originalUrl ?? request.url) !== target) {
    throw new ForbiddenException('Read observation requires the exact authenticated target');
  }
  if (!grant) {
    if (typeof request.headers.authorization !== 'string' || !/^Bearer \S+$/i.test(request.headers.authorization)) {
      throw new ForbiddenException('Read observation requires native authentication');
    }
    return;
  }
  if (grant.kind !== 'tool' || grant.operation?.id !== name ||
      grant.operation.version !== '0.2.0' || grant.tenantId !== ctx.tenantId || grant.actorId !== ctx.userId ||
      typeof grant.bodySha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(grant.bodySha256) ||
      typeof grant.argumentsSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(grant.argumentsSha256)) {
    throw new ForbiddenException('Read observation requires the exact delegated target');
  }
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
  ctx?: Pick<TenantContext, 'tenantId' | 'userId'>,
  grant?: MeriReadDelegationGrant,
): MeriReadObservation | undefined {
  const carrier = request.headers[HEADER];
  if (carrier === undefined) return undefined;
  if (!hasVerifiedToolServiceIdentity(request)) {
    throw new ForbiddenException('Funding read observation requires verified service identity');
  }
  if (!isObservedRead(name) || !record(rawBody) || typeof carrier !== 'string') invalid();
  if (isSecondPackageRead(name)) assertSecondPackageTarget(name, request, ctx, grant);
  return parseMeriReadObservation(name, rawBody, carrier);
}

/** Calculation inputs only. The calling HTTP owner must establish its own
 * canonical subject and service identity before dispatching any data reader. */
export function parseMeriReadObservation(name: string, rawBody: unknown, carrier: unknown): MeriReadObservation | undefined {
  if (carrier === undefined) return undefined;
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
    if (isMeriEvidenceModeRead(name) && name !== 'search_sam_opportunities') {
      if (!exactKeys(context, ['evidenceAccuracyMode']) ||
          !['off', 'shadow', 'enforce'].includes(context.evidenceAccuracyMode as string)) invalid();
      return Object.freeze({ operationId: name, evidenceAccuracyMode: context.evidenceAccuracyMode as CapabilityRolloutMode });
    }
    if (name === 'get_certification_status') {
      if (!exactKeys(context, ['comparisonLocale']) || !canonicalSupportedLocale(context.comparisonLocale)) invalid();
      return Object.freeze({ operationId: name, comparisonLocale: context.comparisonLocale });
    }
    if (name === 'get_state_rule_status') {
      if (!exactKeys(context, ['stageAsOf', 'commentAsOf']) ||
          !canonicalIso(context.stageAsOf) || !canonicalIso(context.commentAsOf)) invalid();
      return Object.freeze({ operationId: name, stageAsOf: context.stageAsOf, commentAsOf: context.commentAsOf });
    }
    if (name === 'search_sam_opportunities') {
      if (!exactKeys(context, ['asOf', 'sourceStatusAsOf', 'sourceHealthAsOf', 'evidenceAccuracyMode']) ||
          !canonicalIso(context.asOf) || !canonicalIso(context.sourceStatusAsOf) ||
          !canonicalIso(context.sourceHealthAsOf) ||
          !['off', 'shadow', 'enforce'].includes(context.evidenceAccuracyMode as string)) invalid();
      return Object.freeze({
        operationId: name, asOf: context.asOf, sourceStatusAsOf: context.sourceStatusAsOf,
        sourceHealthAsOf: context.sourceHealthAsOf,
        evidenceAccuracyMode: context.evidenceAccuracyMode as CapabilityRolloutMode,
      });
    }
    if (!exactKeys(context, ['asOf']) || !canonicalIso(context.asOf)) invalid();
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

export function currentMeriCertificationComparisonLocale(): string | undefined {
  const observation = storage.getStore();
  if (!observation) return undefined;
  if (observation.operationId !== 'get_certification_status') {
    throw new ForbiddenException('Certification observation does not match this operation');
  }
  return observation.comparisonLocale;
}

export function currentMeriRuleStatusClocks(): Pick<MeriRuleStatusObservation, 'stageAsOf' | 'commentAsOf'> | undefined {
  const observation = storage.getStore();
  if (!observation) return undefined;
  if (observation.operationId !== 'get_state_rule_status') {
    throw new ForbiddenException('Rule observation does not match this operation');
  }
  return { stageAsOf: observation.stageAsOf, commentAsOf: observation.commentAsOf };
}

/** A supplied enum cannot choose Core policy. Re-read the current mode each
 * time this accessor is used, including after awaited owner reads. */
export function currentMeriSamProducerContext(
  tenantId: string | null | undefined,
): Omit<MeriSamObservation, 'operationId'> | undefined {
  const observation = storage.getStore();
  if (!observation) return undefined;
  if (observation.operationId !== 'search_sam_opportunities') {
    throw new ForbiddenException('SAM observation does not match this operation');
  }
  const actual = resolveEvidenceAccuracyModeForTenant(tenantId, 'chat');
  if (actual !== observation.evidenceAccuracyMode) {
    throw new ForbiddenException('Current SAM evidence mode changed; reload');
  }
  return {
    asOf: observation.asOf,
    sourceStatusAsOf: observation.sourceStatusAsOf,
    sourceHealthAsOf: observation.sourceHealthAsOf,
    evidenceAccuracyMode: actual,
  };
}

/** Pass undefined on the legacy path so the producer retains its own clock. */
export function currentMeriFundingReadAsOf(name: FundingReadOperation): Date | undefined {
  const asOf = currentMeriReadAsOf(name);
  return asOf ? new Date(asOf) : undefined;
}
