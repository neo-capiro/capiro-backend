import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { hasVerifiedToolServiceIdentity } from './tool-service-secret.guard.js';

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

export interface MeriFundingReadObservation {
  readonly operationId: FundingReadOperation;
  readonly asOf: string;
}

const storage = new AsyncLocalStorage<MeriFundingReadObservation>();

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

/**
 * The header is a calculation anchor, never an authorization grant. Route,
 * original flat body, native bearer and an actually matched internal-service
 * secret must all be established before the existing producer is called.
 */
export function admitMeriFundingReadObservation(
  name: string,
  rawBody: unknown,
  request: Request,
): MeriFundingReadObservation | undefined {
  const carrier = request.headers[HEADER];
  if (carrier === undefined) return undefined;
  if (!hasVerifiedToolServiceIdentity(request)) {
    throw new ForbiddenException('Funding read observation requires verified service identity');
  }
  if (!isFundingRead(name) || !record(rawBody) || typeof carrier !== 'string') invalid();
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
      !exactKeys(context, ['asOf']) ||
      typeof context.asOf !== 'string' ||
      !/^(?:[0-9]{4}|[+-][0-9]{6})-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u.test(context.asOf) ||
      typeof value.requestSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.requestSha256) ||
      value.requestSha256 !== createHash('sha256').update(canonicalJson(rawBody), 'utf8').digest('hex') ||
      new Date(context.asOf).toISOString() !== context.asOf ||
      !Buffer.from(canonicalJson(value), 'utf8').equals(decoded)
    ) {
      return invalid();
    }
    return Object.freeze({ operationId: name, asOf: context.asOf });
  } catch {
    return invalid();
  }
}

export function withMeriFundingReadObservation<T>(
  observation: MeriFundingReadObservation,
  run: () => T,
): T {
  return storage.run(Object.freeze({ ...observation }), run);
}

/** Pass undefined on the legacy path so the producer retains its own clock. */
export function currentMeriFundingReadAsOf(name: FundingReadOperation): Date | undefined {
  const observation = storage.getStore();
  if (!observation) return undefined;
  if (observation.operationId !== name) {
    throw new ForbiddenException('Funding read observation does not match this operation');
  }
  return new Date(observation.asOf);
}
