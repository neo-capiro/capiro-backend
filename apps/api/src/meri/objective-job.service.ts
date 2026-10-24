import { ForbiddenException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { objectiveStrategyJobTenantWithinSystemTx, readObjectiveStrategyJobSubjectWithinTx,
  readObjectiveStrategyJobAcceptanceWithinTx, type ObjectiveStrategyJobSubject } from '@capiro/shared/objective-strategy-intake';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { GovernedMemoryCandidateService } from '../memory/governed-memory-candidate.service.js';
import { hasInternalServiceIdentity } from '../auth/internal-service.guard.js';
import { assertDelegatedToolSelectors, schemaClientSelectors } from '../auth/read-delegation/read-delegation.contract.js';
import type { MeriToolsService } from './meri-tools.service.js';
import { assertMeriToolAllowed } from './meri-tool-allowlist.js';
import { parseRetainedReadContext, retainedReadObject, retainedReadSnapshot,
  assertRetainedReadSelectors, readRetainedReadDeadline, type RetainedReadContext } from './retained-read-context.js';
import { assertRetainedSourceV02Admission, RETAINED_SOURCE_V02_OPERATIONS } from './retained-source-v02/admission.js';
import { readRetainedSourceV02 } from './retained-source-v02/receiver.js';
import { readPassiveMemoryPage } from './memory-receiving/meri-memory-page-source.js';
import { checkPassiveMemoryEligibility, parsePassiveMemoryEligibilityRequest } from './memory-receiving/meri-passive-memory-source.js';
import type { ObjectiveJobReadSources } from './objective-job-read-sources.js';
import { isResearchPortfolioProposalTool } from './meri-rp-proposal-binding.js';
import { receiveMemoryProposalPage, MEMORY_PROPOSAL_OPERATION } from './memory-receiving/meri-memory-proposal-receiver.js';
import { ACTION_QUERY_OWNER, ACTION_QUERY_OPERATION, admitActionQueryAlias, assertActionQueryAliasResult } from './meri-action-query-alias.js';
import { parseMeriReadObservation, withMeriReadObservation } from './meri-funding-read-observation.js';
import { withMeriToolRequestControl, withMeriToolExecutionControl, meriToolRequestControl,
  assertMeriToolRequestActive } from './meri-tool-request-control.js';

const refused = () => new ForbiddenException('Objective job read refused');

/** Existing saved consent supplies the principal; request context only narrows
 * selectors. Database locks end before tool IO and are reacquired for release. */
export class ObjectiveJobService {
  constructor(private readonly prisma: PrismaService, private readonly tools: MeriToolsService,
    private readonly memory: GovernedMemoryCandidateService, private readonly sources: ObjectiveJobReadSources) {}

  private request(raw: unknown, req: Request, read: boolean): Record<string, any> {
    if (!hasInternalServiceIdentity(req)) throw refused();
    const value = retainedReadSnapshot(retainedReadObject(raw, read
      ? ['schemaVersion', 'generationJobId', 'operation', 'input', 'context']
      : ['schemaVersion', 'generationJobId']), 65_536);
    if (value.schemaVersion !== 1 || typeof value.generationJobId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.generationJobId)) throw refused();
    return value;
  }

  private async subject(generationJobId: string, tenant?: string) {
    const tenantId = tenant ?? await this.prisma.withSystem(tx => objectiveStrategyJobTenantWithinSystemTx(tx, generationJobId));
    return this.prisma.withTenant(tenantId, tx => readObjectiveStrategyJobSubjectWithinTx(tx,
      { tenantId, generationJobId, effect: true }));
  }

  async current(raw: unknown, req: Request) {
    const value = this.request(raw, req, false), s = await this.subject(value.generationJobId);
    return { schemaVersion: 1, generationJobId: s.generationJobId, tenantId: s.tenantId, actorId: s.actorUserId,
      clerkUserId: s.clerkUserId, clientId: s.clientId, role: s.role, consentId: s.consentId,
      controlVersion: s.controlVersion, checkedAtMs: s.checkedAtMs, effectExpiresAtMs: s.effectExpiresAtMs };
  }

  async read(raw: unknown, req: Request): Promise<unknown> {
    const v = this.request(raw, req, true), s = await this.subject(v.generationJobId);
    if (s.status !== 'running' || s.attempt !== 2 || typeof v.operation !== 'string' ||
        !/^[a-z][A-Za-z0-9_.]{1,95}$/.test(v.operation)) throw refused();
    const ctx: TenantContext = { tenantId: s.tenantId, tenantSlug: s.tenantSlug, userId: s.actorUserId,
      clerkUserId: s.clerkUserId, role: s.role as TenantContext['role'] };
    const context = parseRetainedReadContext(ctx, v.context, true);
    const accepted = await this.prisma.withTenant(s.tenantId, tx =>
      readObjectiveStrategyJobAcceptanceWithinTx(tx, s.tenantId, s.generationJobId, s.clerkUserId));
    if (!isDeepStrictEqual(context.binding, accepted.sourceBinding) || context.subject.kind !== 'client' ||
        context.subject.entityIds[0] !== s.clientId) throw refused();
    assertRetainedReadSelectors(v.input, context);
    const deadlineMs = Math.min(readRetainedReadDeadline(req), s.effectExpiresAtMs, accepted.effectExpiresAtMs);
    return withMeriToolRequestControl(req, () => withMeriToolExecutionControl(
      { signal: meriToolRequestControl()?.signal, deadlineAt: deadlineMs }, async () => {
        const result = await this.execute(ctx, v.operation, v.input, context, deadlineMs, req);
        // Revoked membership/wall, stopped/replaced consent, changed claim or expiry never releases a result.
        const fresh = await this.subject(s.generationJobId, s.tenantId);
        const stable = (x: ObjectiveStrategyJobSubject) => ({ ...x, checkedAtMs: 0 });
        if (!isDeepStrictEqual(stable(fresh), stable(s))) throw refused();
        assertMeriToolRequestActive();
        return result;
      }));
  }

  private async execute(ctx: TenantContext, operation: string, input: any,
    context: RetainedReadContext, deadlineMs: number, req: Request): Promise<unknown> {
    if (this.sources.handles(operation)) return this.sources.read(ctx, context.subject.entityIds[0]!, operation, input);
    if (operation === 'search_memory_eligibility') {
      const page = parsePassiveMemoryEligibilityRequest(input, ctx, Date.now());
      if (!isDeepStrictEqual(page.binding, context.binding) || !isDeepStrictEqual(page.subject, context.subject) ||
          page.policyRevision !== context.policyRevision ||
          !isDeepStrictEqual(page.normalizationContext, context.normalizationContext) || page.deadlineMs > deadlineMs) throw refused();
      return checkPassiveMemoryEligibility(this.prisma, ctx, page);
    }
    if (operation === MEMORY_PROPOSAL_OPERATION.id) return receiveMemoryProposalPage({
      ctx, raw: input, correlation: context, verifiedServiceIdentity: true,
      deadlineMs, prisma: this.prisma, owner: this.memory,
    });
    if (operation === 'search_memory') {
      assertMeriToolAllowed(operation);
      return readPassiveMemoryPage(ctx, input, context, true, deadlineMs, this.tools);
    }
    if (RETAINED_SOURCE_V02_OPERATIONS.has(operation)) return readRetainedSourceV02(
      assertRetainedSourceV02Admission(ctx, operation, input, context,
        { verifiedServiceIdentity: true, nowMs: Date.now(), deadlineMs }), ctx, this.tools);
    if (operation === ACTION_QUERY_OPERATION.id) {
      const admitted = admitActionQueryAlias(ctx, input, true, context, deadlineMs, Date.now());
      assertMeriToolAllowed(ACTION_QUERY_OWNER);
      if (this.tools.isSideEffecting(ACTION_QUERY_OWNER)) throw refused();
      const result = await this.tools.executeFromAuthenticatedUser(ctx, ACTION_QUERY_OWNER, admitted.ownerBody);
      assertActionQueryAliasResult(result, admitted.clientId);
      return result;
    }
    assertMeriToolAllowed(operation);
    const schema = this.tools.anthropicToolSchemas({ tenantId: ctx.tenantId, surface: 'chat' }).find(t => t.name === operation);
    // These readers require a real interactive conversation/RP grant. A derived
    // Objective conversation is not one and is never substituted for it.
    if (!schema || this.tools.isSideEffecting(operation) || operation === 'search_memory_eligibility' ||
        operation === 'read_chat_attachments' || isResearchPortfolioProposalTool(operation)) throw refused();
    // This existing helper checks only selectors; the pair is the saved job's
    // client plus its accepted native binding, never a delegated capability.
    assertDelegatedToolSelectors(input, { clientId: context.subject.entityIds[0]!,
      conversationId: context.binding.conversationId }, schemaClientSelectors(schema.input_schema));
    const observation = parseMeriReadObservation(operation, input, req.headers['x-meri-read-observation']);
    const execute = () => this.tools.executeFromAuthenticatedUser(ctx, operation, input);
    return observation ? withMeriReadObservation(observation, execute) : execute();
  }
}
