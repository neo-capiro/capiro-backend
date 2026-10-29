import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { ApplicationCurrentService } from '../auth/application-current.service.js';
import { CLIENT_QUERY_RELATIONS } from '../clients/client-query-projections.js';
import { CLIENT_BUSINESS_QUERY_RELATIONS } from '../clients/client-business-query-projections.js';
import { CLIENT_PROFILE_QUERY_RELATIONS } from '../clients/client-profile-query-projections.js';
import { ENGAGEMENT_WORK_QUERY_RELATIONS } from '../engagement/engagement-work-query-projections.js';
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
  ) {
    this.queries = createPrivateSqlQueries(
      [...CLIENT_QUERY_RELATIONS, ...CLIENT_BUSINESS_QUERY_RELATIONS, ...CLIENT_PROFILE_QUERY_RELATIONS, ...ENGAGEMENT_WORK_QUERY_RELATIONS],
      db,
    );
  }

  async read(ctx: TenantContext, req: Request, operation: Operation, rawInput: unknown) {
    assertMeriToolRequestActive();
    if (!['describe_capiro_data', 'query_capiro_data'].includes(operation)) throw refused();
    const input = retainedReadSnapshot(rawInput, 52_000) as Record<string, unknown>;
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
}
