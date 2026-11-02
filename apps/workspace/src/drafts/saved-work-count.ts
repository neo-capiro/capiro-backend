import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import type { PrismaService } from '../prisma/prisma.service.js';
import { WorkspaceReadBudget, workspaceReadTimedOut } from '../prisma/workspace-read-budget.js';
import type { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { canRead } from '../collaborators/role-policy.js';
import { assertProspectDraft } from '../prospect-resources/prospect-draft-access.js';
import { requireDraftClient } from './draft-client-access.js';
import type { SavedWorkCount, SavedWorkCountQueryDto } from './dto/saved-work-count.dto.js';

const incomplete = () => new ServiceUnavailableException({ code: 'WORKSPACE_SAVED_WORK_INCOMPLETE' });

/** The canonical Drafts access owners qualify every parent, without a list-page
 * or document/version join. Differing population/access observations withhold
 * the count, as do unfinished scans and uncertain source responses. */
export async function savedWorkCount(
  prisma: PrismaService, collaborators: CollaboratorsService,
  tenantId: string, actorId: string, query: SavedWorkCountQueryDto,
): Promise<SavedWorkCount> {
  if (Object.keys(query).some(key => key !== 'clientId') ||
      (query.clientId !== undefined && (typeof query.clientId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(query.clientId))))
    throw new BadRequestException({ code: 'WORKSPACE_SAVED_WORK_QUERY' });
  const clientId = query.clientId?.toLowerCase() ?? null;
  const started = Date.now(), signal = AbortSignal.timeout(10_000);
  const monotonicStarted = performance.now();
  const check = () => {
    const clockElapsed = Date.now() - started;
    const elapsed = Math.max(clockElapsed, performance.now() - monotonicStarted);
    if (signal.aborted || clockElapsed < 0 || elapsed >= 10_000) throw incomplete();
    return Math.max(1, Math.floor(10_000 - elapsed));
  };
  const budget = new WorkspaceReadBudget(check);
  const scope = async () => {
    check();
    try {
      await budget.transaction(prisma, async tx => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant',${tenantId},true)`;
        await requireDraftClient(prisma, tx, tenantId, actorId, clientId, budget);
      });
    } catch (error) {
      if (error instanceof NotFoundException)
        throw new ForbiddenException({ code: 'WORKSPACE_SAVED_WORK_ACCESS_DENIED' });
      throw error;
    }
    check();
  };
  const candidates = async () => {
    check();
    const rows = await budget.transaction(prisma, tx => tx.wsDraft.findMany({
      where: { tenantId, status: { in: ['draft', 'complete'] }, ...(clientId ? { clientId } : {}),
        OR: [{ ownerId: actorId }, { collaborators: { some: { tenantId, subjectId: actorId, status: 'active' } } }] },
      select: { id: true, tenantId: true, ownerId: true, clientId: true, prospectId: true, status: true, updatedAt: true },
      orderBy: { id: 'asc' },
    }));
    check();
    return rows;
  };
  const observe = async (rows: Awaited<ReturnType<typeof candidates>>) => {
    const readable = new Set<string>();
    for (const row of rows) {
      check();
      if (row.tenantId !== tenantId || (clientId !== null && row.clientId !== clientId)) throw incomplete();
      const role = await collaborators.resolveRole(tenantId, row.id, actorId, signal, true, budget);
      check();
      if (!canRead(role)) continue;
      try { await assertProspectDraft(prisma, row, actorId, canRead, budget); }
      catch (error) { if (!(error instanceof NotFoundException)) throw error; else continue; }
      check(); readable.add(row.id);
    }
    return [...readable].sort();
  };
  try {
    await scope();
    const before = await candidates(), first = await observe(before);
    const middle = await candidates();
    if (!isDeepStrictEqual(before, middle)) throw incomplete();
    const last = await observe(middle);
    if (!isDeepStrictEqual(first, last) || !isDeepStrictEqual(middle, await candidates())) throw incomplete();
    await scope(); check();
    if (!Number.isSafeInteger(last.length)) throw incomplete();
    return { metric: 'workspace.saved-work-products', version: 1,
      scope: clientId === null ? { kind: 'actor', clientId: null } : { kind: 'client', clientId },
      count: last.length, observationStartedAt: new Date(started).toISOString(), observedAt: new Date(Date.now()).toISOString(),
      complete: true, capped: false };
  } catch (error) {
    if (workspaceReadTimedOut(error)) throw incomplete();
    if (error instanceof ForbiddenException || error instanceof ServiceUnavailableException) throw error;
    throw new ServiceUnavailableException({ code: 'WORKSPACE_SAVED_WORK_UNAVAILABLE' });
  }
}
