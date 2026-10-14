import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { types as nodeTypes } from 'node:util';

export const PORTFOLIO_LAYOUT_MAX_CLIENTS = 2000;
export const PORTFOLIO_LAYOUT_MAX_VERSION = 2147483647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CARD_ID = /^client:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PortfolioLayoutInput {
  contractVersion: 1;
  expectedVersion: number;
  order: string[];
}

export interface PortfolioLayoutReceipt {
  contractVersion: 1;
  tenantId: string;
  userId: string;
  version: number;
  updatedAt: string | null;
  order: string[];
}

export interface SavedPortfolioLayout {
  tenantId: string;
  userId: string;
  version: number;
  clientOrder: string[];
  updatedAt: Date;
}

export interface PortfolioLayoutReadPlan {
  changed: boolean;
  clientOrder: string[];
  version: number;
}

function invalidInput(): never {
  throw new BadRequestException({ code: 'PORTFOLIO_LAYOUT_INPUT_INVALID', message: 'Invalid saved layout request' });
}

function unavailable(code = 'PORTFOLIO_LAYOUT_UNAVAILABLE'): never {
  throw new ServiceUnavailableException({ code, message: 'Saved layout is unavailable' });
}

function record(value: unknown, keys: readonly string[], invalid: () => never): Record<string, unknown> {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key))) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
    result[key] = descriptor.value;
  }
  return result;
}

/** Snapshot own data elements; neither accessors nor proxy traps are evaluated. */
function array(value: unknown, max: number, invalid: () => never): unknown[] {
  if (nodeTypes.isProxy(value) || !Array.isArray(value) || value.length > max) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== value.length + 1 || own.some((key) =>
    key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) invalid();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
    result.push(descriptor.value);
  }
  return result;
}

/** Wire grammar only. Resource membership is checked by the transaction owner. */
export function parsePortfolioLayoutInput(body: unknown): PortfolioLayoutInput {
  const parsed = record(body, ['contractVersion', 'expectedVersion', 'order'], invalidInput);
  if (parsed.contractVersion !== 1 || typeof parsed.expectedVersion !== 'number' ||
      !Number.isSafeInteger(parsed.expectedVersion) || parsed.expectedVersion < 0 ||
      parsed.expectedVersion >= PORTFOLIO_LAYOUT_MAX_VERSION) invalidInput();
  const values = array(parsed.order, PORTFOLIO_LAYOUT_MAX_CLIENTS, invalidInput);
  const order: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || value.length !== 43 || !CARD_ID.test(value) || seen.has(value)) invalidInput();
    seen.add(value);
    order.push(value);
  }
  return { contractVersion: 1, expectedVersion: parsed.expectedVersion, order };
}

/** This accepts native catalog UUIDs, not a caller-provided authority list. */
export function normalizePortfolioLayoutCatalog(ids: unknown): string[] {
  if (Array.isArray(ids) && !nodeTypes.isProxy(ids) && ids.length > PORTFOLIO_LAYOUT_MAX_CLIENTS)
    unavailable('PORTFOLIO_LAYOUT_CATALOG_CAPACITY');
  return uuidArray(ids, () => unavailable('PORTFOLIO_LAYOUT_CATALOG_INVALID')).sort();
}

function uuidArray(value: unknown, invalid: () => never): string[] {
  const values = array(value, PORTFOLIO_LAYOUT_MAX_CLIENTS, invalid);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of values) {
    if (typeof id !== 'string' || id.length !== 36 || !UUID.test(id) || seen.has(id)) invalid();
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** Reject malformed persistence rather than manufacturing a virtual version zero. */
export function decodeSavedPortfolioLayout(value: unknown, tenantId: string, userId: string): SavedPortfolioLayout {
  const parsed = record(value, ['tenantId', 'userId', 'version', 'clientOrder', 'updatedAt'], unavailable);
  if (tenantId.length !== 36 || userId.length !== 36 || !UUID.test(tenantId) || !UUID.test(userId) ||
      parsed.tenantId !== tenantId || parsed.userId !== userId ||
      typeof parsed.version !== 'number' || !Number.isSafeInteger(parsed.version) || parsed.version < 1 ||
      parsed.version > PORTFOLIO_LAYOUT_MAX_VERSION || nodeTypes.isProxy(parsed.updatedAt)) unavailable();
  let milliseconds: number;
  try { milliseconds = Date.prototype.getTime.call(parsed.updatedAt); } catch { unavailable(); }
  if (!Number.isFinite(milliseconds)) unavailable();
  return { tenantId, userId, version: parsed.version, clientOrder: uuidArray(parsed.clientOrder, unavailable),
    updatedAt: new Date(milliseconds) };
}

/** Stable surviving order, followed by new catalog UUIDs in lexicographic order. */
export function planPortfolioLayoutRead(saved: SavedPortfolioLayout | null, catalog: readonly string[]): PortfolioLayoutReadPlan {
  const ids = normalizePortfolioLayoutCatalog(catalog);
  if (!saved) return { changed: false, clientOrder: ids, version: 0 };
  const current = new Set(ids);
  const clientOrder = saved.clientOrder.filter((id) => current.has(id));
  const retained = new Set(clientOrder);
  clientOrder.push(...ids.filter((id) => !retained.has(id)));
  const changed = !sameOrder(saved.clientOrder, clientOrder);
  if (changed && saved.version === PORTFOLIO_LAYOUT_MAX_VERSION) unavailable('PORTFOLIO_LAYOUT_VERSION_EXHAUSTED');
  return { changed, clientOrder, version: saved.version + (changed ? 1 : 0) };
}

/** Every accepted write increments, even when the submitted order is unchanged. */
export function planPortfolioLayoutWrite(
  saved: SavedPortfolioLayout | null, input: PortfolioLayoutInput, catalog: readonly string[],
): { clientOrder: string[]; version: number } {
  input = parsePortfolioLayoutInput(input);
  const ids = normalizePortfolioLayoutCatalog(catalog);
  if (saved?.version === PORTFOLIO_LAYOUT_MAX_VERSION) unavailable('PORTFOLIO_LAYOUT_VERSION_EXHAUSTED');
  if (input.expectedVersion !== (saved?.version ?? 0)) {
    throw new ConflictException({ code: 'PORTFOLIO_LAYOUT_VERSION_CONFLICT', message: 'Saved layout changed. Reload before saving.' });
  }
  const clientOrder = input.order.map((token) => token.slice(7));
  const current = new Set(ids);
  if (clientOrder.length !== current.size || new Set(clientOrder).size !== clientOrder.length ||
      clientOrder.some((id) => !current.has(id))) {
    throw new ConflictException({ code: 'PORTFOLIO_LAYOUT_CATALOG_CONFLICT', message: 'Profile catalog changed. Reload before saving.' });
  }
  return { clientOrder, version: input.expectedVersion + 1 };
}

export function portfolioLayoutReceipt(
  tenantId: string, userId: string, saved: SavedPortfolioLayout | null, catalog: readonly string[],
): PortfolioLayoutReceipt {
  const ids = normalizePortfolioLayoutCatalog(catalog);
  if (tenantId.length !== 36 || userId.length !== 36 || !UUID.test(tenantId) || !UUID.test(userId)) unavailable();
  if (!saved) return { contractVersion: 1, tenantId, userId, version: 0, updatedAt: null, order: ids.map(card) };
  const decoded = decodeSavedPortfolioLayout(saved, tenantId, userId);
  const catalogSet = new Set(ids);
  if (decoded.clientOrder.length !== ids.length || decoded.clientOrder.some((id) => !catalogSet.has(id))) unavailable();
  return { contractVersion: 1, tenantId, userId, version: decoded.version,
    updatedAt: decoded.updatedAt.toISOString(), order: decoded.clientOrder.map(card) };
}

function card(id: string): string { return `client:${id}`; }
function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
