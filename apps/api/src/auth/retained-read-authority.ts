import { createHash } from 'node:crypto';
import { types } from 'node:util';
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';

export const RETAINED_READ_SCHEMA_VERSION = 1 as const;
export const RETAINED_READ_SOURCE_ENABLED = Symbol(
  'retained-read-source-enabled',
);
export const RETAINED_FLORIDA_AUTHORITY = Symbol('retained-florida-authority');
export type RetainedReadOperation =
  | 'get_research_portfolio'
  | 'get_research_portfolio_changes'
  | 'get_florida_budget_project';
export interface RetainedPortfolioSelector {
  schemaVersion: 1;
  portfolioId: string;
}
export interface RetainedFloridaSelector {
  schemaVersion: 1;
  sessionKey: string;
  folderId: string | null;
  clientSelector: string | null;
}
export interface RetainedFloridaScope {
  jurisdiction: 'FL';
  sessionKey: string;
  folderId: string | null;
  clientId: string | null;
}
export type RetainedClientResolution = {
  selector: string;
  clientId: string;
} | null;
export interface RetainedFloridaAuthorityFacts {
  resourceRevision: string;
  effectiveScope: RetainedFloridaScope;
  clientResolution: RetainedClientResolution;
}
export interface RetainedReadReceiptBase {
  schemaVersion: 1;
  operation: RetainedReadOperation;
  principal: { tenantId: string; actorId: string };
  identityRevision: string;
  resourceRevision: string;
  selectorSha256: string;
  checkedAtMs: number;
  expiresAtMs: number;
}

export const RETAINED_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RETAINED_SHA256 = /^[0-9a-f]{64}$/;
const invalid = () =>
  new BadRequestException('Invalid retained authority request');

/** Admit inert fixed selectors before reading any user properties. */
function closed(
  raw: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    types.isProxy(raw) ||
    Array.isArray(raw) ||
    (Object.getPrototypeOf(raw) !== Object.prototype &&
      Object.getPrototypeOf(raw) !== null)
  )
    throw invalid();
  const own = Reflect.ownKeys(raw);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    throw invalid();
  const record: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
      throw invalid();
    record[key] = descriptor.value;
  }
  return record;
}

export function parseRetainedPortfolioSelector(
  raw: unknown,
): RetainedPortfolioSelector {
  const value = closed(raw, ['schemaVersion', 'portfolioId']);
  if (
    value.schemaVersion !== 1 ||
    typeof value.portfolioId !== 'string' ||
    !RETAINED_UUID.test(value.portfolioId)
  )
    throw invalid();
  return { schemaVersion: 1, portfolioId: value.portfolioId };
}

export function parseRetainedFloridaSelector(
  raw: unknown,
): RetainedFloridaSelector {
  const value = closed(raw, [
    'schemaVersion',
    'sessionKey',
    'folderId',
    'clientSelector',
  ]);
  if (
    value.schemaVersion !== 1 ||
    typeof value.sessionKey !== 'string' ||
    value.sessionKey.length > 256 ||
    (value.folderId !== null &&
      (typeof value.folderId !== 'string' ||
        !RETAINED_UUID.test(value.folderId))) ||
    (value.clientSelector !== null &&
      (typeof value.clientSelector !== 'string' ||
        value.clientSelector.length === 0 ||
        value.clientSelector.length > 256 ||
        value.clientSelector.trim() !== value.clientSelector))
  )
    throw invalid();
  // Canonical Phase8/READS preserves an empty session key and its exact bytes.
  return {
    schemaVersion: 1,
    sessionKey: value.sessionKey,
    folderId: value.folderId as string | null,
    clientSelector: value.clientSelector as string | null,
  };
}

/** Canonical sorted fixed-body keys, including version and explicit nulls. */
export function retainedSelectorSha256(
  selector: RetainedPortfolioSelector | RetainedFloridaSelector,
): string {
  const canonical =
    'portfolioId' in selector
      ? {
          portfolioId: selector.portfolioId,
          schemaVersion: selector.schemaVersion,
        }
      : {
          clientSelector: selector.clientSelector,
          folderId: selector.folderId,
          schemaVersion: selector.schemaVersion,
          sessionKey: selector.sessionKey,
        };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Copy the exact closed producer facts; never spread unknown source fields into a receipt. */
export function parseRetainedFloridaFacts(
  raw: unknown,
  selector: RetainedFloridaSelector,
): RetainedFloridaAuthorityFacts {
  try {
    const value = closed(raw, [
      'resourceRevision',
      'effectiveScope',
      'clientResolution',
    ]);
    const scope = closed(value.effectiveScope, [
      'jurisdiction',
      'sessionKey',
      'folderId',
      'clientId',
    ]);
    if (
      typeof value.resourceRevision !== 'string' ||
      !RETAINED_SHA256.test(value.resourceRevision) ||
      scope.jurisdiction !== 'FL' ||
      scope.sessionKey !== selector.sessionKey ||
      scope.folderId !== selector.folderId ||
      (scope.clientId !== null &&
        (typeof scope.clientId !== 'string' ||
          !RETAINED_UUID.test(scope.clientId)))
    )
      throw invalid();
    let resolution: RetainedClientResolution = null;
    if (value.clientResolution !== null) {
      const current = closed(value.clientResolution, ['selector', 'clientId']);
      if (
        current.selector !== selector.clientSelector ||
        typeof current.selector !== 'string' ||
        typeof current.clientId !== 'string' ||
        !RETAINED_UUID.test(current.clientId) ||
        current.clientId !== scope.clientId
      )
        throw invalid();
      if (
        RETAINED_UUID.test(current.selector.toLowerCase()) &&
        current.selector.toLowerCase() !== current.clientId
      )
        throw invalid();
      resolution = { selector: current.selector, clientId: current.clientId };
    }
    if (
      (selector.clientSelector === null) !== (resolution === null) ||
      (selector.folderId === null &&
        resolution === null &&
        scope.clientId !== null)
    )
      throw invalid();
    return {
      resourceRevision: value.resourceRevision,
      effectiveScope: {
        jurisdiction: 'FL',
        sessionKey: selector.sessionKey,
        folderId: selector.folderId,
        clientId: scope.clientId as string | null,
      },
      clientResolution: resolution,
    };
  } catch {
    throw new ServiceUnavailableException(
      'Retained Florida authority source unavailable',
    );
  }
}
