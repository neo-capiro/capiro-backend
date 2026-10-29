import { BadRequestException } from '@nestjs/common';
import { normalizeWebsite } from './client-profile-fill.helpers.js';

/** Research selections are run inputs, never confirmed client identities. */
export type ResearchLdaIdentity = { id: number; name: string; confidence: number };
export type ResearchInputs = { website?: string | null; ldaIdentities?: ResearchLdaIdentity[] };

export function researchWebsite(value?: string | null): string | null {
  if (!value?.trim()) return null;
  const normalized = normalizeWebsite(value);
  if (!normalized) throw new BadRequestException('Enter a valid http(s) company website');
  return normalized;
}

export function researchTaskInput(
  type: string, website: string | null, ldaIdentities: ResearchLdaIdentity[],
): Record<string, unknown> {
  if (type === 'public_web') return { researchInputVersion: 1, website };
  if (type === 'lda') return { researchInputVersion: 1, ldaIdentities };
  return {};
}

/** Old tasks retain their recorded source behavior; malformed new inputs never fall back. */
export function readResearchInputs(input: Record<string, unknown>, taskType: string): ResearchInputs {
  if (input.researchInputVersion === undefined) return {};
  if (input.researchInputVersion !== 1)
    throw new BadRequestException('Unsupported research input version');
  const expected = taskType === 'public_web' ? 'website' : taskType === 'lda' ? 'ldaIdentities' : null;
  if (!expected || !Object.hasOwn(input, expected))
    throw new BadRequestException('Saved research input does not match its task');
  const result: ResearchInputs = {};
  if ('website' in input) {
    if (input.website !== null && typeof input.website !== 'string')
      throw new BadRequestException('Invalid saved research website');
    result.website = researchWebsite(input.website);
  }
  if ('ldaIdentities' in input) {
    if (!Array.isArray(input.ldaIdentities) || input.ldaIdentities.length > 1000)
      throw new BadRequestException('Invalid saved research identities');
    result.ldaIdentities = input.ldaIdentities.map((value: unknown) => {
      const row = value as Partial<ResearchLdaIdentity> | null;
      if (!row || !Number.isSafeInteger(row.id) || row.id! <= 0 ||
        typeof row.name !== 'string' || !row.name.trim() ||
        typeof row.confidence !== 'number' || !Number.isFinite(row.confidence) ||
        row.confidence < 0 || row.confidence > 1)
        throw new BadRequestException('Invalid saved research identity');
      return { id: row.id!, name: row.name, confidence: row.confidence };
    });
    if (new Set(result.ldaIdentities.map(row => row.id)).size !== result.ldaIdentities.length)
      throw new BadRequestException('Duplicate saved research identities');
  }
  return result;
}
