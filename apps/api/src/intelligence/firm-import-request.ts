import { BadRequestException } from '@nestjs/common';
import { normalizeWebsite } from '../clients/client-profile-fill.helpers.js';
import { validateUrlBeforeRequest } from '../meri/hardenedWebTransport.js';

export type ImportWebsites = Record<string, string>;

/** Provisional import inputs only. Future fetches must still resolve and pin DNS. */
export function normalizeImportWebsites(value: unknown, ids: readonly number[]): ImportWebsites {
  if (value === undefined) return {};
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.prototype.toString.call(value) !== '[object Object]'
  )
    throw new BadRequestException(
      'Import websites must be an object keyed by selected LDA client IDs',
    );
  const entries = Object.entries(value);
  if (entries.length > ids.length)
    throw new BadRequestException('Websites must belong to the selected LDA clients');
  const selected = new Set(ids);
  const result: ImportWebsites = {};
  for (const [key, raw] of entries.sort(([a], [b]) => Number(a) - Number(b))) {
    if (!/^[1-9]\d*$/.test(key) || !Number.isSafeInteger(Number(key)) || !selected.has(Number(key)))
      throw new BadRequestException('Websites must belong to the selected LDA clients');
    if (
      typeof raw !== 'string' ||
      raw.length > 500 ||
      !raw.trim() ||
      /[\u0000-\u001f\u007f]/.test(raw)
    )
      throw new BadRequestException('Enter a company website of at most 500 characters');
    const normalized = normalizeWebsite(raw);
    if (!normalized || normalized.length > 500)
      throw new BadRequestException('Enter a valid company website');
    const url = validateUrlBeforeRequest(normalized);
    if (url.port || /(^|\.)(test|invalid|lan|home)$/.test(url.hostname.replace(/\.$/, '')))
      throw new BadRequestException('Enter a public company website using a standard HTTP(S) port');
    result[key] = url.href;
  }
  return result;
}

/** A missing payload is the legacy contract. Malformed saved inputs never silently fall back. */
export function readImportWebsites(value: unknown, ids: readonly number[]): ImportWebsites {
  if (value === null || value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('Invalid saved import inputs');
  const input = value as Record<string, unknown>;
  if (
    input.schemaVersion !== 1 ||
    !Object.hasOwn(input, 'websites') ||
    Object.keys(input).some((key) => !['schemaVersion', 'websites'].includes(key))
  )
    throw new BadRequestException('Unsupported saved import inputs');
  return normalizeImportWebsites(input.websites, ids);
}
