import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { TwoStepDraftFlagsService } from './two-step-draft-flags.service.js';
import { SourceResolverService } from './source-resolver.service.js';
import { createInitialAgentState } from '../document-agent/document-agent-state.js';
import type { IntakeRequestDto, IntakeResponse } from './dto/intake.dto.js';

/**
 * Aggregate, idempotent intake service (PR #964).
 *
 * The one-screen Max draft flow persists the full intake — draft, generation
 * run, intake snapshot, and primary document — in a single transaction and
 * returns 202 Accepted. No generation is kicked off here; the durable
 * WsGenerationRun is left in `queued` for a worker to claim.
 *
 * Idempotency: the caller supplies an `Idempotency-Key` header (controller
 * passes it through). A repeat call with the same (tenantId, actorId, key)
 * returns the original draftId/runId without re-creating anything.
 */
@Injectable()
export class IntakeService {
  private readonly logger = new Logger(IntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: TwoStepDraftFlagsService,
    private readonly sourceResolver: SourceResolverService,
  ) {}

  async createIntake(
    tenantId: string,
    actorId: string,
    idempotencyKey: string,
    dto: IntakeRequestDto,
  ): Promise<IntakeResponse> {
    // 1. Capability flag gate — reject if the two-step flow is off for this tenant.
    const enabled = await this.flags.isTwoStepDraftEnabled(tenantId);
    if (!enabled) {
      throw new ConflictException(
        'The two-step Max draft flow is not enabled for this tenant',
      );
    }

    // The idempotency key is a header, so the DTO validation can't enforce it.
    if (!idempotencyKey || !idempotencyKey.trim()) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    // 2. Atomically resolve idempotency + validate + persist. Everything below
    //    runs inside one transaction so a repeat key, a bad blueprint, or a bad
    //    client never leaves a half-written draft behind.
    return this.prisma.$transaction(async (tx) => {
      // Set the RLS tenant context for the raw client lookup (matches the
      // context-compiler pattern).
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;

      // a. Idempotency: look up an existing intake by the unique
      //    (tenantId, actorId, idempotencyKey) tuple. A hit returns the original
      //    draftId/runId — the caller gets the same 202 it got the first time.
      const existing = await tx.wsIntake.findUnique({
        where: {
          tenantId_actorId_idempotencyKey: {
            tenantId,
            actorId,
            idempotencyKey,
          },
        },
        select: { draftId: true, runId: true },
      });
      if (existing) {
        this.logger.debug(
          `Idempotent intake replay for tenant ${tenantId}, key ${idempotencyKey} → draft ${existing.draftId}`,
        );
        return {
          draftId: existing.draftId,
          runId: existing.runId,
          status: 'queued' as const,
          agentRevision: 0,
        };
      }

      // b. Re-fetch and validate the blueprint version. Must be published and
      //    either global (tenantId null) or scoped to this tenant.
      const blueprintVersion = await tx.wsBlueprintVersion.findFirst({
        where: {
          id: dto.blueprintVersionId,
          status: 'published',
          OR: [{ tenantId: null }, { tenantId }],
        },
        select: {
          id: true,
          version: true,
          definitionHash: true,
          blueprintId: true,
        },
      });
      if (!blueprintVersion) {
        throw new BadRequestException(
          'The selected blueprint version is not published or is no longer available',
        );
      }

      // c. Validate clientId if provided — it must resolve to a real client in
      //    this tenant. The clients table is tenant-scoped; we look it up via a
      //    raw query (RLS context set above) and capture the name for the draft
      //    hot-field + config.client.
      let clientName: string | null = null;
      if (dto.clientId) {
        const clientRows = await tx.$queryRaw<Array<{ id: string; name: string }>>`
          SELECT id, name FROM clients
          WHERE tenant_id = ${tenantId}::uuid AND id = ${dto.clientId}::uuid
          LIMIT 1
        `;
        if (!clientRows[0]) {
          throw new BadRequestException(
            'The selected client could not be found in this tenant',
          );
        }
        clientName = clientRows[0]!.name;
      }

      // Pre-allocate the IDs we need for cross-references. WsIntake references
      // the run via runId; the run's `intake` is a virtual back-reference
      // resolved by Prisma through that FK (no separate intakeId column).
      const draftId = randomUUID();
      const runId = randomUUID();
      const intakeId = randomUUID();

      // d. Server-side source resolution — re-fetch and authorize every
      //    selected source ID. The browser sends only identifiers; the
      //    backend validates tenant scope, object-level permissions, client
      //    memory walls, and factual/sample classification. The resolved
      //    source set (with server-assigned authority, verification,
      //    freshness, and content hashes) is stored in the intake snapshot
      //    — not the raw browser-supplied IDs.
      const resolvedSources = await this.sourceResolver.resolve(
        tenantId,
        actorId,
        draftId,
        dto,
      );

      // The immutable intake snapshot — everything the browser sent, frozen at
      // acceptance time. The worker replays this; it never trusts later config.
      // The resolvedSources contain the server-authorized source set with
      // authority, verification, freshness, and content hashes.
      const intakeSnapshot = {
        schemaVersion: 1,
        goal: dto.goal,
        clientId: dto.clientId ?? null,
        blueprintVersionId: dto.blueprintVersionId,
        factualAttachmentIds: dto.factualAttachmentIds,
        sampleAttachmentIds: dto.sampleAttachmentIds,
        priorWorkspaceDraftIds: dto.priorWorkspaceDraftIds,
        selectedContextItemIds: dto.selectedContextItemIds ?? [],
        selectedContextDomains: dto.selectedContextDomains ?? [],
        pastedContext: dto.pastedContext ?? null,
        pastedSample: dto.pastedSample ?? null,
        title: dto.title ?? null,
        audience: dto.audience ?? null,
        tone: dto.tone ?? null,
        deadline: dto.deadline ?? null,
        lengthInstruction: dto.lengthInstruction ?? null,
        // Server-resolved source set — replaces raw browser IDs with
        // authorized, re-fetched, content-hashed sources.
        resolvedSources,
      };

      // d. Build the draft config. This mirrors the DraftsService.create baseline
      //    (so every downstream reader sees a well-formed engine config) and adds
      //    the two-step-specific fields: the validated clientId, a fresh document
      //    agent state, and a quickDraftIntake linkage block.
      const config: Record<string, unknown> = {
        industry: null,
        product: null,
        client: clientName,
        clientId: dto.clientId ?? null,
        pathways: [],
        committees: [],
        personalize: false,
        officeAssociated: false,
        offices: [],
        clientAssociated: Boolean(dto.clientId),
        clientPersons: [],
        coverLetter: false,
        selectedTemplate: null,
        sections: [],
        pages: 2,
        tone: dto.tone ?? 'Formal',
        toneContext: '',
        linkedData: [],
        anonymize: false,
        letterhead: { custom: false, firmName: '', firmAddr: '' },
        // Document Agent — fresh initial state; the run will advance it.
        documentAgent: createInitialAgentState(),
        // Quick-draft intake linkage — lets the UI and worker trace back to the
        // accepted intake and the pinned blueprint version.
        quickDraftIntake: {
          schemaVersion: 1,
          intakeId,
          runId,
          blueprintVersionId: blueprintVersion.id,
          blueprintVersion: blueprintVersion.version,
          blueprintDefinitionHash: blueprintVersion.definitionHash,
        },
      };

      const draftTitle =
        dto.title?.trim() ||
        (clientName ? `${clientName} draft` : 'Untitled draft');

      await tx.wsDraft.create({
        data: {
          id: draftId,
          tenantId,
          ownerId: actorId,
          lastEditedById: actorId,
          docTitle: draftTitle,
          industry: null,
          product: null,
          client: clientName,
          config: config as never,
          ask: 'n/a',
          isPacket: false,
          docCount: 1,
        },
      });

      // e. Create the generation run in `queued`. No lease, no provider yet —
      //    the worker claims and fills those. The intake back-reference is
      //    resolved automatically through WsIntake.runId.
      await tx.wsGenerationRun.create({
        data: {
          id: runId,
          tenantId,
          draftId,
          actorId,
          status: 'queued',
          stage: 'queued',
          agentRevision: 0,
          sectionStates: {} as never,
          stages: [] as never,
        },
      });

      // f. Create the intake row linking draft + run + the frozen snapshot.
      await tx.wsIntake.create({
        data: {
          id: intakeId,
          tenantId,
          actorId,
          idempotencyKey,
          draftId,
          runId,
          blueprintVersionId: blueprintVersion.id,
          intakeSnapshot: intakeSnapshot as never,
          status: 'accepted',
        },
      });

      // g. Create the primary document tab — same shape as DraftsService.create.
      //    Every draft starts with exactly one document the editor can render.
      await tx.wsDocument.create({
        data: {
          tenantId,
          draftId,
          name: 'Document',
          ordinal: 0,
          body: { blocks: [] } as never,
        },
      });

      return {
        draftId,
        runId,
        status: 'queued' as const,
        agentRevision: 0,
      };
    });
  }
}
