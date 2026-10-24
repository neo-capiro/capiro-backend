import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { ClientObjectivesService } from '../clients/objectives/objectives.service.js';
import { InstitutionalKnowledgeRetrievalAdapter } from '../retrieval/adapters/institutional-knowledge-retrieval.adapter.js';
import { SemanticDataCatalogService } from '../retrieval/data-catalog/semantic-data-catalog.service.js';
import { MeriToolsService } from './meri-tools.service.js';
import { assertMeriToolRequestActive, meriToolRequestControl } from './meri-tool-request-control.js';
import { projectAutomaticClientContext } from './automatic-client-context.projection.js';

@Injectable()
export class AutomaticClientContextService {
  constructor(
    private readonly tools: MeriToolsService,
    private readonly objectives: ClientObjectivesService,
    private readonly memory: InstitutionalKnowledgeRetrievalAdapter,
    private readonly catalog: SemanticDataCatalogService,
  ) {}

  async read(ctx: TenantContext, body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).sort().join(',') !== 'clientId,schemaVersion') throw new BadRequestException('Invalid automatic context request');
    const input = body as { schemaVersion: unknown; clientId: unknown };
    if (input.schemaVersion !== 1 || typeof input.clientId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.clientId))
      throw new BadRequestException('Explicit client ID required');
    const clientId = input.clientId.toLowerCase(), startedAt = new Date().toISOString();
    assertMeriToolRequestActive();
    await this.objectives.assertContextAccess(ctx, clientId);
    assertMeriToolRequestActive();
    const [profile, objectives, memory] = await Promise.all([
      this.tools.readAutomaticClientProfile(ctx, clientId),
      this.objectives.readContext(ctx, clientId),
      this.memory.retrieve(this.catalog.get('institutional_knowledge'), {
        queryClass: 'lookup', requestedDomains: ['institutional_knowledge'], query: '', pageSize: 16,
        caller: { tenantId: ctx.tenantId, userId: ctx.userId, clientIds: [clientId], authorizedClientIds: [clientId] },
        deadlineAt: meriToolRequestControl()?.deadlineAt,
      }),
    ]);
    assertMeriToolRequestActive();
    if (memory.sourceStatus === 'unauthorized') throw new NotFoundException('Client context not found');
    // A wall change during collection must prevent release, including previously loaded facts.
    await this.objectives.assertContextAccess(ctx, clientId);
    assertMeriToolRequestActive();
    return projectAutomaticClientContext({ tenantId: ctx.tenantId, actorId: ctx.userId, clientId,
      startedAt, completedAt: new Date().toISOString(), profile, objectives, memory });
  }
}
