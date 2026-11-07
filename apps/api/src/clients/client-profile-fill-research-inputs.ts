import { readPortfolioResearchScope, type PortfolioResearchScope } from './portfolio-research-scope.js';
import { readResearchBusinessUnit, type ResearchBusinessUnit } from './profile-capability-discovery-input.js';
import { BadRequestException } from '@nestjs/common';
import { normalizeWebsite } from './client-profile-fill.helpers.js';
import { fingerprintName, sharesDistinctiveToken } from '../intelligence/entity-resolution.service.js';

/** Research selections are run inputs, never confirmed client identities. */
export type ResearchLdaIdentity = { id: number; name: string; confidence: number };
export type ResearchInputs = { portfolioScope?: PortfolioResearchScope; businessUnit?: ResearchBusinessUnit; website?: string | null; ldaIdentities?: ResearchLdaIdentity[]; ldaCandidates?: ResearchLdaIdentity[] };

/** Discovery proposes a bounded subset; these IDs never become selected history inputs. */
export function discoverResearchLdaCandidates(name: string, offered: ResearchLdaIdentity[], selectedIds: number[]) {
  const fingerprint = fingerprintName(name);
  if (!fingerprint) return [];
  return offered.filter(candidate => !selectedIds.includes(candidate.id) &&
    candidate.confidence >= 0.7 && sharesDistinctiveToken(fingerprint, fingerprintName(candidate.name)))
    .sort((a, b) => b.confidence - a.confidence || a.id - b.id).slice(0, 3)
    .map(({id, name, confidence}) => ({id, name, confidence}));
}

export function researchWebsite(value?: string | null): string | null {
  if (!value?.trim()) return null;
  const normalized = normalizeWebsite(value);
  if (!normalized) throw new BadRequestException('Enter a valid http(s) company website');
  return normalized;
}

export function researchTaskInput(
  type: string, website: string | null, ldaIdentities: ResearchLdaIdentity[], businessUnit?: ResearchBusinessUnit, portfolioScope?: PortfolioResearchScope, ldaCandidates?: ResearchLdaIdentity[],
): Record<string, unknown> {
  if (type === 'public_web') return { researchInputVersion: 1, website, ...(businessUnit ? {businessUnit} : {}), ...(portfolioScope ? {portfolioScope} : {}) };
  if (type === 'client_document' && (businessUnit || portfolioScope)) return {researchInputVersion: 1, ...(businessUnit ? {businessUnit} : {}), ...(portfolioScope ? {portfolioScope} : {})};
  if (type === 'lda') return { researchInputVersion: 1, ldaIdentities, ...(ldaCandidates ? {ldaCandidates} : {}) };
  return {};
}

/** Old tasks retain their recorded source behavior; malformed new inputs never fall back. */
export function readResearchInputs(input: Record<string, unknown>, taskType: string): ResearchInputs {
  if (input.researchInputVersion === undefined) return {};
  if (input.researchInputVersion !== 1)
    throw new BadRequestException('Unsupported research input version');
  const expected = taskType === 'public_web' ? 'website' : taskType === 'lda' ? 'ldaIdentities' : taskType === 'client_document' && input.businessUnit ? 'businessUnit' : taskType === 'client_document' && input.portfolioScope ? 'portfolioScope' : null;
  if (!expected || !Object.hasOwn(input, expected))
    throw new BadRequestException('Saved research input does not match its task');
  const result: ResearchInputs = {};
  if (input.portfolioScope !== undefined) {
    if (!['public_web', 'client_document'].includes(taskType)) throw new BadRequestException('Portfolio scope is not valid for this source task');
    result.portfolioScope = readPortfolioResearchScope(input.portfolioScope);
  }
  if (input.businessUnit !== undefined) {
    if (!['public_web', 'client_document'].includes(taskType)) throw new BadRequestException('Business unit is not valid for this source task');
    result.businessUnit = readResearchBusinessUnit(input.businessUnit);
  }
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
  if ('ldaCandidates' in input) {
    if (taskType !== 'lda' || !Array.isArray(input.ldaCandidates) || input.ldaCandidates.length > 3)
      throw new BadRequestException('Invalid saved LDA candidates');
    // Use the same recorded identity validation; candidates cannot be history selections.
    result.ldaCandidates = readResearchInputs({researchInputVersion: 1, ldaIdentities: input.ldaCandidates}, 'lda').ldaIdentities;
    if (result.ldaCandidates?.some(candidate => result.ldaIdentities?.some(identity => identity.id === candidate.id)))
      throw new BadRequestException('An LDA candidate is already selected');
  }
  return result;
}
