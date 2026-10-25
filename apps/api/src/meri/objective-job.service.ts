import { RetainedReadDispatcher } from './retained-read-dispatch.js';
import { ForbiddenException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { objectiveStrategyJobTenantWithinSystemTx, readObjectiveStrategyJobSubjectWithinTx,
  readObjectiveStrategyJobAcceptanceWithinTx, type ObjectiveStrategyJobSubject } from '@capiro/shared/objective-strategy-intake';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { GovernedMemoryCandidateService } from '../memory/governed-memory-candidate.service.js';
import { hasInternalServiceIdentity } from '../auth/internal-service.guard.js';
import type { MeriToolsService } from './meri-tools.service.js';
import { parseRetainedReadContext, retainedReadObject, retainedReadSnapshot,
  assertRetainedReadSelectors, readRetainedReadDeadline } from './retained-read-context.js';
import type { ObjectiveJobReadSources } from './objective-job-read-sources.js';
import { withMeriToolRequestControl, withMeriToolExecutionControl, meriToolRequestControl,
  assertMeriToolRequestActive } from './meri-tool-request-control.js';

const refused = () => new ForbiddenException('Objective job read refused');

/** Existing saved consent supplies the principal; request context only narrows
 * selectors. Database locks end before tool IO and are reacquired for release. */
export class ObjectiveJobService {
  private readonly reads: RetainedReadDispatcher;
  constructor(private readonly prisma: PrismaService, tools: MeriToolsService,
    memory: GovernedMemoryCandidateService, sources: ObjectiveJobReadSources) {
    this.reads = new RetainedReadDispatcher(prisma, tools, memory, sources);
  }

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
        const result = await this.reads.execute(ctx, v.operation, v.input, context, deadlineMs, req);
        // Revoked membership/wall, stopped/replaced consent, changed claim or expiry never releases a result.
        const fresh = await this.subject(s.generationJobId, s.tenantId);
        const stable = (x: ObjectiveStrategyJobSubject) => ({ ...x, checkedAtMs: 0 });
        if (!isDeepStrictEqual(stable(fresh), stable(s))) throw refused();
        assertMeriToolRequestActive();
        return result;
      }));
  }

}
