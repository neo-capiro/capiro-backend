import { ForbiddenException, Injectable, Optional } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { ApplicationCurrentService } from '../auth/application-current.service.js';
import {
  PrivateSqlDbService,
  type PrivateSqlExecutionContext,
} from './analytics/private-sql-db.service.js';
import { createPrivateSqlQueries } from './analytics/private-sql-query.js';
import { MeriToolsService } from './meri-tools.service.js';
import { assertMeriToolRequestActive } from './meri-tool-request-control.js';
import {
  parseRetainedReadContext,
  readRetainedReadDeadline,
  readRetainedReadHeader,
  retainedReadObject,
  retainedReadSnapshot,
} from './retained-read-context.js';
import { hasVerifiedToolServiceIdentity } from './tool-service-secret.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { withClassicOutreachEligibleIds } from '../engagement/classic-outreach-authority.js';
import { SQL_QUERY_LIMITS } from './analytics/sql-statement-gate.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const refused = () => new ForbiddenException('Private query access unavailable');
type Operation = 'describe_capiro_data' | 'query_capiro_data';

/** Interactive binding to the existing current owner. Correlation and selectors grant nothing. */
@Injectable()
export class MeriPrivateSqlService {
  private readonly queries;

  constructor(
    private readonly current: ApplicationCurrentService,
    db: PrivateSqlDbService,
    private readonly tools: MeriToolsService,
    @Optional() private readonly prisma?: PrismaService,
  ) {
    this.queries = createPrivateSqlQueries(db);
  }

  async read(ctx: TenantContext, req: Request, operation: Operation, rawInput: unknown) {
    assertMeriToolRequestActive();
    if (!['describe_capiro_data', 'query_capiro_data'].includes(operation)) throw refused();
    const input = retainedReadSnapshot(rawInput, 52_000) as Record<string, unknown>;
    if (input?.source === 'research_portfolio' || input?.source === 'classic_outreach')
      return this.readDomain(ctx, req, operation, input);
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      input.source !== 'client_records'
    )
      throw refused();
    const requested = input.clientId;
    if (
      Object.hasOwn(input, 'clientId') &&
      (typeof requested !== 'string' || !UUID.test(requested))
    )
      throw refused();
    const context = parseRetainedReadContext(
      ctx,
      readRetainedReadHeader(req),
      hasVerifiedToolServiceIdentity(req),
    );
    const deadlineMs = readRetainedReadDeadline(req);
    const normalization = retainedReadObject(context.normalizationContext, ['capiroDataScope']);
    const scope = retainedReadObject(normalization.capiroDataScope, [
      'clientId',
      'identityRevision',
      'membershipRevision',
    ]);
    if (
      ![scope.identityRevision, scope.membershipRevision].every(
        (value) => typeof value === 'string' && SHA.test(value),
      )
    )
      throw refused();
    // A General query may narrow its rows without changing the actual conversation's null clientId.
    const conversationClientId =
      context.subject.kind === 'client' ? context.subject.entityIds[0]! : null;
    if (
      conversationClientId !== null &&
      requested !== undefined &&
      requested !== conversationClientId
    )
      throw refused();
    const clientId = (requested as string | undefined) ?? conversationClientId;
    if (scope.clientId !== clientId) throw refused();
    const selection = {
      conversationId: context.binding.conversationId,
      clientId: conversationClientId,
    };
    const first = await this.current.read(ctx, req, selection);
    assertMeriToolRequestActive();
    if (
      first.identityRevision !== scope.identityRevision ||
      first.membershipRevision !== scope.membershipRevision ||
      (clientId !== null && !first.clientIds.includes(clientId))
    )
      throw refused();
    const expect = {
      identityRevision: first.identityRevision,
      membershipRevision: first.membershipRevision,
      contextRevision: first.contextRevision,
    };
    const assertCurrent = async () => {
      assertMeriToolRequestActive();
      if (Date.now() >= deadlineMs) throw refused();
      await this.current.read(ctx, req, { ...selection, expect });
      assertMeriToolRequestActive();
      if (Date.now() >= deadlineMs) throw refused();
    };
    const execution: PrivateSqlExecutionContext = {
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      deadlineMs,
      assertCurrent,
      ...(clientId === null
        ? { scopeKind: 'general' as const, clientId: null }
        : { scopeKind: 'client' as const, clientId }),
    };
    const { source: _source, clientId: _clientId, ...query } = input;
    const started = Date.now();
    const result =
      operation === 'describe_capiro_data'
        ? await this.queries.describe(query, execution)
        : await this.queries.query(query, execution);
    if (operation === 'query_capiro_data') {
      await this.tools.recordPrivateSqlQuery(ctx, {
        relations: result.ok && 'relationsUsed' in result ? result.relationsUsed : [],
        rowCount: result.ok && 'rowCount' in result ? result.rowCount : null,
        durationMs: Date.now() - started,
        outcome: result.ok ? 'ok' : result.error.code,
      });
    }
    // Covers envelope/audit awaits too; the DB owner independently checks before and after its transaction.
    await assertCurrent();
    return result;
  }

  /** Explicit source admission. A private-user storage namespace never turns a
   * Research conversation into General, and model input never supplies its capture. */
  private async readDomain(
    ctx: TenantContext,
    req: Request,
    operation: Operation,
    input: Record<string, unknown>,
  ) {
    if (Object.hasOwn(input, 'clientId')) throw refused();
    const source = input.source as 'research_portfolio' | 'classic_outreach';
    const context = parseRetainedReadContext(
      ctx,
      readRetainedReadHeader(req),
      hasVerifiedToolServiceIdentity(req),
    );
    const normalization = retainedReadObject(context.normalizationContext, ['capiroDataScope']);
    const scope = retainedReadObject(
      normalization.capiroDataScope,
      source === 'research_portfolio'
        ? [
            'source',
            'identityRevision',
            'membershipRevision',
            'contextRevision',
            'researchPortfolio',
          ]
        : ['source', 'clientId', 'identityRevision', 'membershipRevision', 'contextRevision'],
    );
    if (
      scope.source !== source ||
      ![scope.identityRevision, scope.membershipRevision, scope.contextRevision].every(
        (value) => typeof value === 'string' && SHA.test(value),
      )
    )
      throw refused();
    const deadlineMs = readRetainedReadDeadline(req);
    const assertActive = () => {
      assertMeriToolRequestActive();
      if (Date.now() >= deadlineMs) throw refused();
    };
    const conversationId = context.binding.conversationId;
    const clientId = context.subject.kind === 'client' ? context.subject.entityIds[0]! : null;
    if (
      (source === 'research_portfolio' && clientId !== null) ||
      (source === 'classic_outreach' && scope.clientId !== clientId)
    )
      throw refused();
    const selection =
      source === 'research_portfolio'
        ? { conversationId, clientId: null, scopeKind: 'research_portfolio' as const }
        : { conversationId, clientId };
    const researchReceipt =
      source === 'research_portfolio'
        ? await this.current.readResearch(ctx, req, selection)
        : undefined;
    const first = researchReceipt ?? (await this.current.read(ctx, req, selection));
    assertActive();
    if (
      first.identityRevision !== scope.identityRevision ||
      first.membershipRevision !== scope.membershipRevision ||
      first.contextRevision !== scope.contextRevision
    )
      throw refused();
    const research = researchReceipt?.researchPortfolio;
    if (
      source === 'research_portfolio' &&
      (!research ||
        JSON.stringify(retainedReadSnapshot(scope.researchPortfolio, 8192)) !==
          JSON.stringify(retainedReadSnapshot(research, 8192)))
    )
      throw refused();
    const expect = {
      identityRevision: first.identityRevision,
      membershipRevision: first.membershipRevision,
      contextRevision: first.contextRevision,
    };
    const assertCurrent = async () => {
      assertActive();
      if (source === 'research_portfolio')
        await this.current.readResearch(ctx, req, { ...selection, expect });
      else await this.current.read(ctx, req, { ...selection, expect });
      assertActive();
    };
    const { source: _source, ...query } = input;
    const common = { tenantId: ctx.tenantId, actorId: ctx.userId, deadlineMs, assertCurrent };
    const started = Date.now();
    const run = async (execution: PrivateSqlExecutionContext) => {
      const result =
        operation === 'describe_capiro_data'
          ? await this.queries.describe(query, execution, research)
          : await this.queries.query(query, execution, research);
      if (operation === 'query_capiro_data')
        await this.tools.recordPrivateSqlQuery(ctx, {
          relations: result.ok && 'relationsUsed' in result ? result.relationsUsed : [],
          rowCount: result.ok && 'rowCount' in result ? result.rowCount : null,
          durationMs: Date.now() - started,
          outcome: result.ok ? 'ok' : result.error.code,
        });
      await assertCurrent();
      return result;
    };
    let result: Awaited<ReturnType<typeof run>>;
    if (source === 'research_portfolio') {
      if (!research) throw refused();
      result = await run({
        ...common,
        scopeKind: 'research_portfolio',
        clientId: null,
        researchPortfolioId: research.researchPortfolioId,
      });
    } else {
      if (!this.prisma) throw refused();
      result = await withClassicOutreachEligibleIds(
        this.prisma,
        ctx,
        clientId === null ? { kind: 'personal_classic' } : { kind: 'client', clientId },
        { maxCandidates: 100, assertActive },
        async (ids) => {
          const buffered = await run({
            ...common,
            scopeKind: 'classic_outreach',
            clientId,
            classicOutreachIds: ids,
          });
          assertActive();
          return retainedReadSnapshot(buffered, SQL_QUERY_LIMITS.maxOutputBytes);
        },
      );
      // The observer's final domain transaction is another awaited boundary.
      // Recheck conversation capture/identity/context before publishing its buffer.
      await assertCurrent();
    }
    return result;
  }
}
