import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SpNodeKind, SpNodeStatus, SpNodeSubject } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import { parseDbDate } from '../strategy/dates.js';
import { loadStrategyDetail } from '../strategy/detail.js';
import { isoDate } from '../strategy/versioning.js';
import { fyOf } from '../fiscal/fiscal.js';
import { NODE_KINDS, NODE_SUBJECTS, NODE_STATUSES } from '../strategy/dto/node.dto.js';
import type { StrategyTypeValue } from '../strategy/dto/create-strategy.dto.js';
import { FirmPhasesService } from '../firm-phases/firm-phases.service.js';
import { ReferenceService, type ReferenceRow } from '../reference/reference.service.js';
import { StrategyAiCredentialResolver } from './strategy-ai-credential.resolver.js';
import { StrategyOrchestratorClient } from './strategy-orchestrator.client.js';
import type { DraftNode, PlanEdit } from './meri.types.js';
import type { AssistantDto, DraftStrategyDto, ReferenceAssistDto } from './dto/meri.dto.js';

type Tx = Prisma.TransactionClient;

const TYPE_LABEL: Record<StrategyTypeValue, string> = {
  appropriations: 'Appropriations',
  authorization: 'Authorization',
  regulatory: 'Regulatory / policy',
  coalition: 'Coalition / positioning',
  procurement: 'Contract / procurement',
  earmark: 'Grant / earmark',
};

/** Validate one enum-ish value from (semi-trusted) LLM output; 400 on mismatch. */
function vEnum<T extends readonly string[]>(val: unknown, allowed: T, field: string): T[number] {
  if (typeof val !== 'string' || !allowed.includes(val)) {
    throw new BadRequestException(`Meri returned an invalid ${field}: ${String(val)}`);
  }
  return val as T[number];
}

/**
 * Strategy Planner Meri — proxies the orchestrator and APPLIES its typed output
 * to sp_* under withTenantUser. Draft creates the strategy+nodes+v1(meri).
 * Assistant applies an edit-set as ONE meri version. All LLM output is
 * re-validated here (defense-in-depth): a malformed node/edit throws inside the
 * tx → full rollback, never a partial write (plan §9.3). The tenant's key +
 * caller bearer are forwarded to the orchestrator, never persisted.
 */
@Injectable()
export class MeriService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly versioning: VersioningService,
    private readonly resolver: StrategyAiCredentialResolver,
    private readonly orchestrator: StrategyOrchestratorClient,
    private readonly firmPhases: FirmPhasesService,
    private readonly reference: ReferenceService,
  ) {}

  /**
   * Grounding the orchestrator can't fetch itself (it lives in api-strategy's
   * sp_* tables): the live 3-FY window, the firm phases, and the merged
   * reference calendars. Forwarded in the draft/assistant request body.
   */
  private async grounding(tenantId: string) {
    const now = new Date();
    const curFy = fyOf(now);
    const fys = [curFy, curFy + 1, curFy + 2];
    const fyLabels = fys.map((y) => `FY${String(y).slice(2)}`);
    const [phases, ref] = await Promise.all([
      this.firmPhases.list(tenantId),
      this.reference.getCalendars(tenantId),
    ]);
    const lite = (rows: ReferenceRow[]) =>
      rows.map((r) => ({
        label: r.label,
        fy: r.fy ?? null,
        startsOn: isoDate(r.startsOn),
        endsOn: isoDate(r.endsOn),
      }));
    return {
      fiscal: { today: isoDate(now), fys, fyLabels, focalFy: fyLabels[1] },
      firmPhases: phases.map((p) => ({
        label: p.label,
        startFy: p.startFy,
        startQ: p.startQ,
        endFy: p.endFy,
        endQ: p.endQ,
      })),
      reference: {
        congress: lite(ref.congress),
        ppbeLanes: lite(ref.ppbeLanes),
        ppbeCurrentPhases: lite(ref.ppbeCurrentPhases),
      },
    };
  }

  async draft(tenantId: string, clerkUserId: string, bearer: string | undefined, dto: DraftStrategyDto) {
    const clientRows = await this.prisma.$queryRaw<Array<{ ok: number }>>`
      SELECT 1 AS ok FROM clients WHERE id = ${dto.clientId}::uuid AND tenant_id = ${tenantId}::uuid LIMIT 1`;
    if (clientRows.length === 0) {
      throw new BadRequestException('Unknown client for this tenant');
    }

    const [aiProvider, ground] = await Promise.all([
      this.resolver.resolve(tenantId),
      this.grounding(tenantId),
    ]);
    const resp = await this.orchestrator.draft(
      {
        clientId: dto.clientId,
        type: dto.type,
        goal: dto.goal ?? null,
        meriContext: dto.meriContext ?? null,
        targetDate: dto.targetDate ?? null,
        attachmentIds: dto.attachmentIds ?? [],
        ...ground,
      },
      bearer,
      aiProvider,
    );

    // Validate the proposed nodes up front (throws before any write).
    const nodeData = (resp.nodes ?? []).slice(0, 60).map((n) => this.draftNode(n, tenantId, clerkUserId));
    const title = deriveTitle(dto.goal, dto.type);
    const targetDate = dto.targetDate ? parseDbDate(dto.targetDate, 'targetDate') : null;
    const owner = dto.ownerUserId?.trim() || clerkUserId;

    return this.prisma.withTenantUser(tenantId, clerkUserId, async (tx) => {
      const strategy = await tx.spStrategy.create({
        data: {
          tenantId,
          clientId: dto.clientId,
          title,
          type: dto.type,
          goal: dto.goal?.trim() || null,
          meriContext: dto.meriContext?.trim() || null,
          meriSummary: resp.summary?.trim() || null,
          targetDate,
          ownerUserId: owner,
          createdByUserId: clerkUserId,
          lastEditedByUserId: clerkUserId,
          lastEditedAt: new Date(),
        },
      });
      if (nodeData.length) {
        await tx.spNode.createMany({
          data: nodeData.map((n) => ({ ...n, strategyId: strategy.id })),
        });
      }
      await this.versioning.cutVersion(tx, {
        tenantId,
        strategyId: strategy.id,
        authorKind: 'meri',
        authorUserId: clerkUserId,
        note: `Drafted ${nodeData.length} step${nodeData.length === 1 ? '' : 's'} from goal`,
        coalesce: false,
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: clerkUserId,
        authorKind: 'meri',
        action: 'strategy.drafted',
        entityType: 'strategy',
        entityId: strategy.id,
        after: { title, nodeCount: nodeData.length, provenance: resp.provenance ?? null },
      });
      return loadStrategyDetail(tx, strategy.id);
    });
  }

  async assistant(
    tenantId: string,
    clerkUserId: string,
    bearer: string | undefined,
    strategyId: string,
    dto: AssistantDto,
  ) {
    const strategy = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spStrategy.findFirst({
        where: { id: strategyId },
        include: { nodes: { orderBy: [{ startsOn: 'asc' }, { createdAt: 'asc' }] } },
      }),
    );
    if (!strategy) throw new NotFoundException('Strategy not found');
    if (dto.scope === 'node' && !dto.nodeId) {
      throw new BadRequestException('nodeId is required for node-scope assist');
    }

    const [aiProvider, ground] = await Promise.all([
      this.resolver.resolve(tenantId),
      this.grounding(tenantId),
    ]);
    const resp = await this.orchestrator.assistant(
      {
        scope: dto.scope,
        nodeId: dto.nodeId ?? null,
        instruction: dto.instruction,
        attachmentIds: dto.attachmentIds ?? [],
        clientId: strategy.clientId,
        strategy: serializeStrategy(strategy),
        ...ground,
      },
      bearer,
      aiProvider,
    );
    const edits = (resp.edits ?? []).slice(0, 60);

    const detail = await this.prisma.withTenantUser(tenantId, clerkUserId, async (tx) => {
      for (const edit of edits) {
        await this.applyEdit(tx, tenantId, strategyId, clerkUserId, edit);
      }
      const data: Record<string, unknown> = {
        lastEditedByUserId: clerkUserId,
        lastEditedAt: new Date(),
      };
      if (resp.summary != null) data.meriSummary = resp.summary.trim() || null;
      await tx.spStrategy.update({
        where: { id: strategyId },
        data: data as Prisma.SpStrategyUpdateInput,
      });
      await this.versioning.cutVersion(tx, {
        tenantId,
        strategyId,
        authorKind: 'meri',
        authorUserId: clerkUserId,
        note: versionNote(resp.reply, resp.summary, dto.scope),
        coalesce: false,
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: clerkUserId,
        authorKind: 'meri',
        action: 'strategy.assisted',
        entityType: 'strategy',
        entityId: strategyId,
        after: { scope: dto.scope, editCount: edits.length, provenance: resp.provenance ?? null },
      });
      return loadStrategyDetail(tx, strategyId);
    });

    return { reply: resp.reply ?? '', summary: resp.summary ?? null, strategy: detail };
  }

  /** REF-4: Meri edits the reference editor's working rows — returned, NOT persisted. */
  async referenceAssist(
    tenantId: string,
    bearer: string | undefined,
    kind: string,
    dto: ReferenceAssistDto,
  ) {
    const aiProvider = await this.resolver.resolve(tenantId);
    return this.orchestrator.referenceAssist(
      { kind, instruction: dto.instruction, rows: dto.rows },
      bearer,
      aiProvider,
    );
  }

  // ---- apply helpers ----

  private draftNode(n: DraftNode, tenantId: string, clerkUserId: string): Prisma.SpNodeCreateManyInput {
    const kind = vEnum(n.kind, NODE_KINDS, 'node kind') as SpNodeKind;
    const subject = vEnum(n.subject, NODE_SUBJECTS, 'node subject') as SpNodeSubject;
    if (typeof n.title !== 'string' || !n.title.trim()) {
      throw new BadRequestException('Meri returned a node with no title');
    }
    const status = (n.status ? vEnum(n.status, NODE_STATUSES, 'node status') : 'suggested') as SpNodeStatus;
    const startsOn = parseDbDate(String(n.startsOn), 'node startsOn');
    const endsOn = n.endsOn ? parseDbDate(String(n.endsOn), 'node endsOn') : null;
    if (endsOn && endsOn < startsOn) {
      throw new BadRequestException('Meri returned a node whose end precedes its start');
    }
    return {
      tenantId,
      strategyId: '', // filled in by the caller after strategy create
      kind,
      subject,
      title: n.title.trim().slice(0, 300),
      note: n.note ?? null,
      ownerUserId: n.ownerUserId ?? null,
      status,
      startsOn,
      endsOn,
      openEnded: n.openEnded ?? false,
      meriAuthored: true,
      createdByUserId: clerkUserId,
    };
  }

  private async applyEdit(
    tx: Tx,
    tenantId: string,
    strategyId: string,
    clerkUserId: string,
    edit: PlanEdit,
  ): Promise<void> {
    if (edit.op === 'add') {
      const data = this.draftNode(edit as DraftNode, tenantId, clerkUserId);
      await tx.spNode.create({ data: { ...data, strategyId } });
      return;
    }
    if (!edit.nodeId) {
      throw new BadRequestException(`Meri ${edit.op} edit is missing nodeId`);
    }
    const node = await tx.spNode.findFirst({ where: { id: edit.nodeId, strategyId } });
    if (!node) {
      throw new BadRequestException(`Meri referenced an unknown node ${edit.nodeId}`);
    }
    if (edit.op === 'remove') {
      await tx.spNode.delete({ where: { id: edit.nodeId } });
      return;
    }
    // update | retime
    const data: Record<string, unknown> = {};
    if (edit.kind !== undefined) data.kind = vEnum(edit.kind, NODE_KINDS, 'node kind');
    if (edit.subject !== undefined) data.subject = vEnum(edit.subject, NODE_SUBJECTS, 'node subject');
    if (edit.title !== undefined) {
      if (typeof edit.title !== 'string' || !edit.title.trim()) {
        throw new BadRequestException('Meri returned an empty node title');
      }
      data.title = edit.title.trim().slice(0, 300);
    }
    if (edit.note !== undefined) data.note = edit.note;
    if (edit.ownerUserId !== undefined) data.ownerUserId = edit.ownerUserId;
    if (edit.status !== undefined) data.status = vEnum(edit.status, NODE_STATUSES, 'node status');
    if (edit.openEnded !== undefined) data.openEnded = edit.openEnded;

    const newStarts = edit.startsOn !== undefined ? parseDbDate(edit.startsOn, 'startsOn') : node.startsOn;
    let newEnds: Date | null = node.endsOn;
    if (edit.endsOn !== undefined) newEnds = edit.endsOn === null ? null : parseDbDate(edit.endsOn, 'endsOn');
    if (edit.startsOn !== undefined) data.startsOn = newStarts;
    if (edit.endsOn !== undefined) data.endsOn = newEnds;
    if (newEnds && newEnds < newStarts) {
      throw new BadRequestException('Meri retimed a node so its end precedes its start');
    }
    // Converting away from risk clears the ongoing flag (parity with NodeService).
    const resultingKind = (edit.kind ?? node.kind) as string;
    if (resultingKind !== 'risk' && node.openEnded && data.openEnded === undefined) {
      data.openEnded = false;
    }
    if (Object.keys(data).length === 0) return;
    await tx.spNode.update({ where: { id: edit.nodeId }, data: data as Prisma.SpNodeUpdateInput });
  }
}

function deriveTitle(goal: string | undefined, type: StrategyTypeValue): string {
  const g = goal?.trim();
  if (g) return g.length > 120 ? `${g.slice(0, 117)}…` : g;
  return `${TYPE_LABEL[type]} strategy`;
}

function versionNote(reply: string | undefined, summary: string | null | undefined, scope: string): string {
  const s = summary?.trim();
  if (s) return `Meri: ${s.length > 160 ? s.slice(0, 157) + '…' : s}`;
  return scope === 'node' ? 'Meri edited this step' : 'Meri updated the plan';
}

/** The strategy snapshot handed to the orchestrator (dates → YYYY-MM-DD). */
function serializeStrategy(strategy: {
  id: string;
  title: string;
  type: string;
  goal: string | null;
  meriContext: string | null;
  targetDate: Date | null;
  nodes: Array<{
    id: string;
    kind: string;
    subject: string;
    title: string;
    note: string | null;
    ownerUserId: string | null;
    status: string;
    startsOn: Date;
    endsOn: Date | null;
    openEnded: boolean;
    meriAuthored: boolean;
  }>;
}) {
  return {
    id: strategy.id,
    title: strategy.title,
    type: strategy.type,
    goal: strategy.goal,
    meriContext: strategy.meriContext,
    targetDate: isoDate(strategy.targetDate),
    nodes: strategy.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      subject: n.subject,
      title: n.title,
      note: n.note,
      ownerUserId: n.ownerUserId,
      status: n.status,
      startsOn: isoDate(n.startsOn),
      endsOn: isoDate(n.endsOn),
      openEnded: n.openEnded,
      meriAuthored: n.meriAuthored,
    })),
  };
}
