import { types } from 'node:util';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { parseApplicationAuthorityCurrentBody } from '../auth/application-authority.js';
import { authorizeResearchPortfolioConversation } from './research-portfolio-artifact-authority.js';
import { loadAuthorizedResearchPortfolioCurrentFacts } from './research-portfolio-access.js';
import { readResearchPortfolioResourceRevision } from './research-portfolio-current-authority.js';

/** A source selector, never a portfolio selector or a permission claim. */
export function parseResearchPortfolioCurrentBody(raw: unknown) {
  const invalid = () => new BadRequestException('Invalid Research current request');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || types.isProxy(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw invalid();
  const fields = Object.getOwnPropertyDescriptors(raw);
  const keys = Reflect.ownKeys(raw);
  if (keys.some(key => typeof key !== 'string' ||
      !['scopeKind', 'conversationId', 'clientId', 'expect'].includes(key)) ||
      !['scopeKind', 'conversationId', 'clientId'].every(key => Object.hasOwn(fields, key)) ||
      Object.values(fields).some(field => !field.enumerable || !Object.hasOwn(field, 'value')) ||
      fields.scopeKind?.value !== 'research_portfolio' || fields.clientId?.value !== null) throw invalid();
  return parseApplicationAuthorityCurrentBody({
    conversationId: fields.conversationId?.value,
    clientId: null,
    ...(fields.expect ? { expect: fields.expect.value } : {}),
  });
}

/** Runs inside the current owner's read-only consistent snapshot. The stored
 * conversation supplies the immutable capture; existing domain owners supply
 * membership, current grant and resource revision. It never accepts a model ID. */
export async function readResearchPortfolioSqlScope(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  conversation: unknown,
  checkpoint: () => void,
) {
  checkpoint();
  const captured = await authorizeResearchPortfolioConversation(tx, ctx, conversation, { lock: false });
  checkpoint();
  if (!captured || !Number.isSafeInteger(captured.researchPortfolioRevision) ||
      captured.researchPortfolioName.length > 400 || Array.from(captured.researchPortfolioName).length > 200)
    throw new ForbiddenException('Research Portfolio scope is unavailable');
  const observed = await readResearchPortfolioResourceRevision(
    tx, ctx, captured.researchPortfolioId, 'get_research_portfolio', checkpoint,
  );
  const current = await loadAuthorizedResearchPortfolioCurrentFacts(tx, ctx, captured.researchPortfolioId, true);
  checkpoint();
  // Resource revision validates the same facts on this snapshot. Do not return
  // the mutable "current" fields that happened to be saved in old metadata.
  if (current.id !== observed.portfolioId || current.tenantId !== ctx.tenantId ||
      typeof current.name !== 'string' || !current.name.trim() || current.name.length > 400 || Array.from(current.name).length > 200 ||
      !Number.isSafeInteger(current.revision) || current.revision < 0 ||
      !['active', 'archived'].includes(current.lifecycle))
    throw new ForbiddenException('Research Portfolio scope is unavailable');
  return Object.freeze({
    kind: 'research_portfolio' as const,
    researchPortfolioId: captured.researchPortfolioId,
    researchPortfolioName: captured.researchPortfolioName,
    researchPortfolioRevision: captured.researchPortfolioRevision,
    scopeVersion: captured.scopeVersion,
    currentResearchPortfolioName: current.name,
    currentResearchPortfolioRevision: current.revision as number,
    stale: current.name !== captured.researchPortfolioName || current.revision !== captured.researchPortfolioRevision,
    resourceRevision: observed.resourceRevision,
  });
}
