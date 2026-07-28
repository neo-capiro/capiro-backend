import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { verifyPlan, type VerifierNode, type Violation } from '@capiro/strategy-verifier';
import { Prisma, SpNodeKind, SpNodeStatus, SpNodeSubject } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import { parseDbDate } from '../strategy/dates.js';
import { loadStrategyDetail } from '../strategy/detail.js';
import { isoDate } from '../strategy/versioning.js';
import { LIVE_NODE_WHERE } from '../strategy/live-node.js';
import { fyOf } from '../fiscal/fiscal.js';
import { NODE_KINDS, NODE_SUBJECTS, NODE_STATUSES } from '../strategy/dto/node.dto.js';
import type { StrategyTypeValue } from '../strategy/dto/create-strategy.dto.js';
import { FirmPhasesService } from '../firm-phases/firm-phases.service.js';
import { ReferenceService, type ReferenceRow } from '../reference/reference.service.js';
import { StewardService } from '../context/steward.service.js';
import { StrategyAiCredentialResolver } from './strategy-ai-credential.resolver.js';
import { StrategyAttachmentResolver } from './strategy-attachment.resolver.js';
import { StrategyOrchestratorClient } from './strategy-orchestrator.client.js';
import {
  StrategyConversationService,
  type ChatAttachmentSnapshot,
  type ChatOpenNodeAction,
} from './strategy-conversation.service.js';
import type {
  DraftNode,
  GroundingHealth,
  NodeDocumentDraftResponse,
  PlanEdit,
  StewardFactLine,
  StewardHealth,
} from './meri.types.js';
import type { AssistantDto, DraftStrategyDto, ReferenceAssistDto } from './dto/meri.dto.js';

type Tx = Prisma.TransactionClient;

interface RefRowLite {
  label: string;
  fy: number | null;
  startsOn: string | null;
  endsOn: string | null;
}
/** The grounding api-strategy forwards to the orchestrator AND feeds the verifier. */
export interface Grounding {
  fiscal: { today: string | null; fys: number[]; fyLabels: string[]; focalFy: string | undefined };
  firmPhases: Array<{ label: string; startFy: number; startQ: number; endFy: number; endQ: number }>;
  reference: { congress: RefRowLite[]; ppbeLanes: RefRowLite[]; ppbeCurrentPhases: RefRowLite[] };
}
/** Loose node shape the verifier mapper accepts (both pre-persist create-inputs
 *  and persisted rows). */
type VerifierNodeSource = {
  id?: string | null;
  kind: unknown;
  subject: unknown;
  title: unknown;
  startsOn: Date | string;
  endsOn?: Date | string | null;
  // string[] (persisted rows) OR Prisma's scalar-list create form ({ set: [] }).
  dependsOnIds?: unknown;
};

/** Runtime mirror of PlanEditOp (meri.types.ts) — ops arrive untyped from the
 *  orchestrator AND from Stage C change-set replay (CreateChangeSetDto defers
 *  op validation to this pipeline), so the discriminator itself must be
 *  validated here. */
const PLAN_EDIT_OPS = ['add', 'update', 'remove', 'retime'] as const;

/** Stage E: node provenance refs of this shape cite a Steward fact. */
const FACT_REF_RE = /^fact:(.+)$/;
/** sp_context_fact.id is uuid-typed — a non-UUID citation is unknown by definition
 *  (and would P2023 the `in` query if passed through). */
const FACT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Phase 2: plain-language names for the Steward's REQUIRED_TEMPLATE_KEYS, used
 * in the seeded `context_gap` conversation message.
 *
 * `groundingHealth.missingRequired` carries INTERNAL template keys
 * ('strategy_brief', 'client_constraints'). The page banner this message
 * replaces printed them raw; a chat line from Meri must not. Unknown keys fall
 * back to a generic phrase rather than leaking the key — and
 * meri.service.spec.ts asserts every REQUIRED_TEMPLATE_KEYS entry has an entry
 * here, so adding a required doc without a label fails the build, not prod.
 */
export const CONTEXT_GAP_LABELS: Record<string, string> = {
  strategy_brief: 'the strategy brief',
  client_constraints: "this client's constraints",
};

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
  private readonly logger = new Logger(MeriService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly versioning: VersioningService,
    private readonly resolver: StrategyAiCredentialResolver,
    private readonly orchestrator: StrategyOrchestratorClient,
    private readonly firmPhases: FirmPhasesService,
    private readonly reference: ReferenceService,
    private readonly attachments: StrategyAttachmentResolver,
    private readonly steward: StewardService,
    private readonly conversations: StrategyConversationService,
  ) {}

  /**
   * Grounding the orchestrator can't fetch itself (it lives in api-strategy's
   * sp_* tables): the live 3-FY window, the firm phases, and the merged
   * reference calendars. Forwarded in the draft/assistant request body.
   */
  /** The live 3-FY window (no DB) — grounds date reasoning in every Meri call. */
  private fiscalWindow() {
    const now = new Date();
    const curFy = fyOf(now);
    const fys = [curFy, curFy + 1, curFy + 2];
    const fyLabels = fys.map((y) => `FY${String(y).slice(2)}`);
    return { today: isoDate(now), fys, fyLabels, focalFy: fyLabels[1] };
  }

  // Public: Stage C change-set apply pre-fetches this (OUTSIDE its tx) to feed
  // verifyAppliedPlan — the reads below open their own withTenant txs.
  async grounding(tenantId: string): Promise<Grounding> {
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
      fiscal: this.fiscalWindow(),
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
    // capiro_app is NOT RLS-bypass on `clients`; read inside withTenant (sets
    // app.current_tenant) so the clients RLS exposes this tenant's rows — a bare
    // raw read returns 0 and false-negatives every valid client.
    const clientRows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<Array<{ ok: number }>>`
        SELECT 1 AS ok FROM clients WHERE id = ${dto.clientId}::uuid AND tenant_id = ${tenantId}::uuid LIMIT 1`,
    );
    if (clientRows.length === 0) {
      throw new BadRequestException('Unknown client for this tenant');
    }

    const [aiProvider, ground, docs, stewardCtx] = await Promise.all([
      this.resolver.resolve(tenantId),
      this.grounding(tenantId),
      this.attachments.resolve(bearer, dto.attachmentIds),
      this.stewardContext(tenantId, dto.clientId),
    ]);
    const resp = await this.orchestrator.draft(
      {
        clientId: dto.clientId,
        type: dto.type,
        goal: dto.goal ?? null,
        meriContext: dto.meriContext ?? null,
        targetDate: dto.targetDate ?? null,
        attachmentIds: dto.attachmentIds ?? [],
        attachments: docs,
        ...ground,
        ...stewardCtx,
      },
      bearer,
      aiProvider,
    );

    // A7.5: never silently persist an empty draft — 422 so the goal can be rephrased.
    const rawNodes = (resp.nodes ?? []).slice(0, 60);
    if (rawNodes.length === 0) {
      throw new UnprocessableEntityException(
        "Meri couldn't produce a plan from that — try rephrasing the goal or attaching a document.",
      );
    }
    // A3: pre-generate ids so dependsOn INDEXES map to real uuids; createMany with
    // explicit ids keeps the edges valid. draftNode validates each (throws pre-write).
    const ids = rawNodes.map(() => randomUUID());
    const nodeData = rawNodes.map((n, idx) => {
      const deps = Array.isArray(n.dependsOn)
        ? [...new Set(n.dependsOn)]
            .filter((d) => Number.isInteger(d) && d >= 0 && d < rawNodes.length && d !== idx)
            .map((d) => ids[d]!)
        : [];
      return this.draftNode(n, tenantId, clerkUserId, ids[idx]!, deps);
    });
    const title = deriveTitle(dto.goal, dto.type);
    const targetDate = dto.targetDate ? parseDbDate(dto.targetDate, 'targetDate') : null;
    const owner = dto.ownerUserId?.trim() || clerkUserId;

    // A6: verify the plan we're about to persist (authoritative — real uuids + grounding).
    const violations = this.verify(dto.type, nodeData, ground);
    // A6 fail branch (dark by default — flip STRATEGY_VERIFY_BLOCK at activation
    // once the web renders the override flow): an impossible plan is not persisted.
    if (this.blockOnErrors()) {
      const errs = violations.filter((v) => v.severity === 'error');
      if (errs.length) {
        throw new UnprocessableEntityException(
          `This plan can't be saved yet — ${errs.map((e) => e.message).join('; ')}`,
        );
      }
    }

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
          draftedByMeri: true,
          targetDate,
          ownerUserId: owner,
          createdByUserId: clerkUserId,
          lastEditedByUserId: clerkUserId,
          lastEditedAt: new Date(),
        },
      });
      await tx.spNode.createMany({
        data: nodeData.map((n) => ({ ...n, strategyId: strategy.id })),
      });
      await this.versioning.cutVersion(tx, {
        tenantId,
        strategyId: strategy.id,
        authorKind: 'meri',
        authorUserId: clerkUserId,
        note: `Drafted ${nodeData.length} step${nodeData.length === 1 ? '' : 's'} from goal${
          docs.length ? ` and ${docs.length} document${docs.length === 1 ? '' : 's'}` : ''
        }`,
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
      const detail = await loadStrategyDetail(tx, strategy.id);
      // Stage E provenance fact-check: 'fact:<id>' citations on the PERSISTED
      // plan must reference real, active, same-client facts (warnings appended
      // to the violations plan.verified logs below).
      violations.push(...(await this.factCheckProvenance(tx, detail.nodes, dto.clientId)));
      await this.logVerification(tx, tenantId, clerkUserId, strategy.id, violations);

      // Phase 2: seed the strategy thread so a drafted plan opens with Meri's
      // own account of it rather than an empty panel. Same tx as the plan
      // itself — a strategy that exists always has its opening message.
      await this.conversations.appendIn(tx, tenantId, {
        strategyId: strategy.id,
        nodeId: null,
        role: 'meri',
        kind: 'message',
        body:
          resp.summary?.trim() ||
          `Drafted ${nodeData.length} step${nodeData.length === 1 ? '' : 's'} from your goal.`,
        createdByUserId: null,
      });
      // ONE gap message, not one per missing field — a list of five bullet
      // points reads as a system dump, and the user's next action is the same
      // either way. Phase 5 adds the repair/retry affordance on top of it.
      const gap = contextGapBody(resp.groundingHealth);
      if (gap) {
        await this.conversations.appendIn(tx, tenantId, {
          strategyId: strategy.id,
          nodeId: null,
          role: 'meri',
          kind: 'context_gap',
          body: gap,
          createdByUserId: null,
        });
      }
      return { ...detail, violations, groundingHealth: resp.groundingHealth };
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
        // P0-1: LIVE plan only — the assistant must not see (or edit) nodes a
        // restore archived.
        include: {
          nodes: { where: { ...LIVE_NODE_WHERE }, orderBy: [{ startsOn: 'asc' }, { createdAt: 'asc' }] },
        },
      }),
    );
    if (!strategy) throw new NotFoundException('Strategy not found');
    if (dto.scope === 'node' && !dto.nodeId) {
      throw new BadRequestException('nodeId is required for node-scope assist');
    }

    // Phase 2: which conversation this send belongs to. A node-scoped send lives
    // in that step's thread; a strategy-scoped send lives in the strategy thread.
    // The two are never merged.
    const contextNodeId = dto.scope === 'node' ? (dto.nodeId ?? null) : null;

    // Persist the user's message BEFORE the model call, keyed on the client's
    // idempotency id. Two things fall out of that ordering: what the user typed
    // survives an orchestrator failure, and a retried POST (dropped response,
    // double-click) reuses the stored row instead of posting a second bubble.
    const userMessage = await this.conversations.appendUserMessage(tenantId, clerkUserId, {
      strategyId,
      nodeId: contextNodeId,
      body: dto.instruction,
      attachments: snapshotAttachments(dto),
      clientMessageId: dto.clientMessageId,
    });

    // Declared out here because the post-apply verifier (`ground`) and the
    // version note (`docs.length`) both need them AFTER the try block.
    let ground: Grounding;
    let docs: Awaited<ReturnType<StrategyAttachmentResolver['resolve']>>;
    let resp: Awaited<ReturnType<StrategyOrchestratorClient['assistant']>>;
    try {
      const [aiProvider, g, d, stewardCtx] = await Promise.all([
        this.resolver.resolve(tenantId),
        this.grounding(tenantId),
        this.attachments.resolve(bearer, dto.attachmentIds),
        this.stewardContext(tenantId, strategy.clientId),
      ]);
      ground = g;
      docs = d;
      resp = await this.orchestrator.assistant(
        {
          scope: dto.scope,
          nodeId: dto.nodeId ?? null,
          instruction: dto.instruction,
          attachmentIds: dto.attachmentIds ?? [],
          attachments: docs,
          clientId: strategy.clientId,
          strategy: serializeStrategy(strategy),
          ...ground,
          ...stewardCtx,
        },
        bearer,
        aiProvider,
      );
    } catch (err) {
      // The user's message is already stored, so the thread must say what
      // happened to it. Plain copy only — no stack trace, no provider name.
      // The plan is NOT mutated on this path.
      await this.recordAssistantError(tenantId, strategyId, contextNodeId, err);
      throw err;
    }
    const edits = (resp.edits ?? []).slice(0, 60);

    // A pure question / no-op (empty edit-set) is NOT a mutation batch: do not
    // cut a version, bump lastEdited, or log a mutation (plan §4/§7 — one version
    // per applied set). Return the reply against the current, unchanged state.
    if (edits.length === 0) {
      const { current, meriMessage } = await this.prisma.withTenant(tenantId, async (tx) => {
        const loaded = await loadStrategyDetail(tx, strategyId);
        const msg = await this.conversations.appendIn(tx, tenantId, {
          strategyId,
          nodeId: contextNodeId,
          role: 'meri',
          kind: 'message',
          body: replyBody(resp.reply, dto.scope, 0),
        });
        return { current: loaded, meriMessage: msg };
      });
      return {
        reply: resp.reply ?? '',
        summary: strategy.meriSummary ?? null,
        strategy: { ...current, groundingHealth: resp.groundingHealth },
        messages: [userMessage, meriMessage],
      };
    }

    // Step 4: which steps this edit-set CREATED. Compared against the pre-edit
    // LIVE ids, so a revived (un-archived) node does not read as new.
    const beforeNodeIds = new Set(strategy.nodes.map((n) => n.id));

    const { detail, violations, meriMessage } = await this.prisma.withTenantUser(tenantId, clerkUserId, async (tx) => {
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
        note: versionNote(resp.reply, resp.summary, dto.scope, docs.length),
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
      const d = await loadStrategyDetail(tx, strategyId);
      // A6: verify the resulting persisted plan; annotate + log (additive — the
      // edit-set already applied; hard-blocking is the flagged web phase).
      const v = this.verify(strategy.type, d.nodes, ground);
      // Stage E provenance fact-check (WARNING-only — never trips the A6 gate).
      v.push(...(await this.factCheckProvenance(tx, d.nodes, strategy.clientId)));
      if (this.blockOnErrors() && v.some((x) => x.severity === 'error')) {
        // Roll back the whole edit-set — the assistant may not leave the plan broken.
        throw new UnprocessableEntityException(
          `This change would break the plan — ${v
            .filter((x) => x.severity === 'error')
            .map((x) => x.message)
            .join('; ')}`,
        );
      }
      await this.logVerification(tx, tenantId, clerkUserId, strategyId, v);

      // Phase 2: Meri's reply commits in the SAME transaction as the plan edit.
      // If the edit-set rolls back (a verifier error, a malformed op), the reply
      // claiming it happened rolls back with it — the thread can never assert a
      // change the plan does not have.
      const created = d.nodes.filter((n) => !beforeNodeIds.has(n.id));
      const msg = await this.conversations.appendIn(tx, tenantId, {
        strategyId,
        nodeId: contextNodeId,
        role: 'meri',
        kind: 'message',
        body: replyBody(resp.reply, dto.scope, edits.length),
        // Exactly one new step gets the prototype's `Open "<step>"` affordance.
        // Zero or several: reply text only — a list here would be a UI this
        // phase does not have, and picking one arbitrarily would be a guess.
        action: openNodeAction(created),
      });
      return { detail: d, violations: v, meriMessage: msg };
    });

    return {
      reply: resp.reply ?? '',
      summary: resp.summary ?? null,
      strategy: { ...detail, violations, groundingHealth: resp.groundingHealth },
      messages: [userMessage, meriMessage],
    };
  }

  /**
   * Append the one plain-language failure line after the orchestrator/model
   * threw. Deliberately swallows its own errors: this runs on an already-failing
   * path, and a write failure here must not replace the real cause the caller is
   * about to throw. The correlation stays in the server log.
   */
  private async recordAssistantError(
    tenantId: string,
    strategyId: string,
    nodeId: string | null,
    cause: unknown,
  ): Promise<void> {
    this.logger.warn(
      `assistant failed for strategy ${strategyId}: ${(cause as Error)?.message ?? String(cause)}`,
    );
    try {
      await this.conversations.append(tenantId, {
        strategyId,
        nodeId,
        role: 'meri',
        kind: 'assistant_error',
        body: "I couldn't complete that change. Your message is saved—try again.",
      });
    } catch (err) {
      this.logger.warn(`could not record the assistant error message: ${(err as Error).message}`);
    }
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
      // Fiscal window lets Meri map the working rows' quarter indices to real
      // FY/quarters when reasoning about "shift a quarter later" etc.
      { kind, instruction: dto.instruction, rows: dto.rows, fiscal: this.fiscalWindow() },
      bearer,
      aiProvider,
    );
  }

  /**
   * Stage C: ChangeSet apply reuses the assistant apply pipeline VERBATIM —
   * each op is re-validated + applied by the same private applyEdit the
   * assistant uses, inside the CALLER's tx (the change-set service owns the
   * lastEdited bump, the version cut and the audit rows). A malformed op throws
   * → the caller's whole tx rolls back (no partial apply).
   */
  async applyEditSet(
    tx: Tx,
    tenantId: string,
    strategyId: string,
    actorUserId: string,
    edits: PlanEdit[],
  ): Promise<void> {
    for (const edit of edits) {
      await this.applyEdit(tx, tenantId, strategyId, actorUserId, edit);
    }
  }

  /**
   * Stage C: the SAME A6 plan-level verification the assistant runs after an
   * edit-set (see assistant()) — load the persisted plan, verify it against the
   * tenant's grounding, hard-block via STRATEGY_VERIFY_BLOCK (the 422 rolls the
   * CALLER's whole tx back) and record plan.verified on the audit trail in the
   * same tx. `ground` MUST be fetched via grounding() BEFORE the caller opens
   * its tx — grounding reads run their own withTenant txs, and nesting them
   * inside a held tx stacks pool connections. Returns the loaded detail (and
   * violations) so the caller doesn't re-read post-apply state.
   */
  async verifyAppliedPlan(
    tx: Tx,
    tenantId: string,
    actorUserId: string,
    strategyId: string,
    ground: Grounding,
  ) {
    const detail = await loadStrategyDetail(tx, strategyId);
    const violations = this.verify(detail.type, detail.nodes, ground);
    if (this.blockOnErrors() && violations.some((v) => v.severity === 'error')) {
      throw new UnprocessableEntityException(
        `This change would break the plan — ${violations
          .filter((v) => v.severity === 'error')
          .map((v) => v.message)
          .join('; ')}`,
      );
    }
    await this.logVerification(tx, tenantId, actorUserId, strategyId, violations);
    return { detail, violations };
  }

  // ---- apply helpers ----

  private draftNode(
    n: DraftNode,
    tenantId: string,
    clerkUserId: string,
    id: string,
    dependsOnIds: string[],
  ): Prisma.SpNodeCreateManyInput {
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
      id, // explicit so dependsOn cross-references resolve (A3)
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
      // 'Ongoing' is a risk-only concept (parity with NodeService.add): a
      // non-risk node can never be created open-ended, even if Meri proposes it.
      openEnded: kind === 'risk' ? (n.openEnded ?? false) : false,
      dependsOnIds,
      provenance:
        n.sources && n.sources.length ? ({ sources: n.sources } as Prisma.InputJsonValue) : undefined,
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
    // An unknown op (typo'd / future kind) must throw, never fall through to
    // the update|retime branch below and silently mutate the node.
    vEnum(edit.op, PLAN_EDIT_OPS, 'edit op');
    if (edit.op === 'add') {
      const id = randomUUID();
      const deps = await this.resolveEditDeps(tx, strategyId, id, edit.dependsOn);
      const data = this.draftNode(edit as unknown as DraftNode, tenantId, clerkUserId, id, deps);
      await tx.spNode.create({ data: { ...data, strategyId } });
      return;
    }
    if (!edit.nodeId) {
      throw new BadRequestException(`Meri ${edit.op} edit is missing nodeId`);
    }
    // P0-1: an archived node is not addressable by an edit op — it reads as
    // unknown, so a change-set replay can never resurrect or mutate history.
    const node = await tx.spNode.findFirst({
      where: { id: edit.nodeId, strategyId, ...LIVE_NODE_WHERE },
    });
    if (!node) {
      throw new BadRequestException(`Meri referenced an unknown node ${edit.nodeId}`);
    }
    if (edit.op === 'remove') {
      await tx.spNode.delete({ where: { id: edit.nodeId } });
      // Strip the removed id from sibling edges (parity with NodeService.remove).
      await tx.$executeRaw`
        UPDATE sp_node
           SET depends_on_ids = array_remove(depends_on_ids, ${edit.nodeId}::uuid)
         WHERE strategy_id = ${strategyId}::uuid
           AND tenant_id = ${tenantId}::uuid
           AND ${edit.nodeId}::uuid = ANY (depends_on_ids)`;
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
    if (edit.dependsOn !== undefined) {
      data.dependsOnIds = await this.resolveEditDeps(tx, strategyId, edit.nodeId, edit.dependsOn);
    }
    if (edit.sources !== undefined) {
      data.provenance = edit.sources.length
        ? ({ sources: edit.sources } as Prisma.InputJsonValue)
        : Prisma.DbNull;
    }

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

  /**
   * Validate Meri's edit-op dependency ids against the strategy. Best-effort:
   * drops self + unknown ids so a bad Meri reference can't roll back the whole
   * edit-set (deps are advisory; the verifier surfaces real problems).
   */
  private async resolveEditDeps(
    tx: Tx,
    strategyId: string,
    selfId: string | null,
    dependsOn: string[] | undefined,
  ): Promise<string[]> {
    if (!Array.isArray(dependsOn) || dependsOn.length === 0) return [];
    const unique = [...new Set(dependsOn)].filter((d) => typeof d === 'string' && d !== selfId);
    if (unique.length === 0) return [];
    // P0-1: archived nodes are not valid dependency targets (parity with
    // NodeService.resolveDependsOn).
    const rows = await tx.spNode.findMany({
      where: { strategyId, id: { in: unique }, ...LIVE_NODE_WHERE },
      select: { id: true },
    });
    const found = new Set(rows.map((r) => r.id));
    return unique.filter((id) => found.has(id));
  }

  /** Degraded stewardContext fallback — status 'degraded' is honest (we don't
   *  know the real fact/conflict state), never 'ok' (which would assert a
   *  clean bill of health we haven't actually checked). */
  private static readonly STEWARD_CONTEXT_FALLBACK: {
    stewardFacts: StewardFactLine[];
    stewardHealth: StewardHealth;
  } = { stewardFacts: [], stewardHealth: { status: 'degraded', missingRequired: [], openMaterialConflicts: [] } };

  /**
   * Stage E wire-contract (2): the Steward pack forwarded in every draft/
   * assistant orchestrator body — `stewardFacts` (active facts for the client,
   * 120 newest) + `stewardHealth` (fact-level health; the orchestrator renders
   * the '# Client context facts (Steward)' section and, when 'conflicted',
   * names factA vs factB verbatim in the health note).
   *
   * Fails SOFT (mirrors StrategyAttachmentResolver.resolve): the base Stage A/B
   * draft/assistant path must never go down because Stage E's context data is
   * unavailable (a fact-store hiccup, a bad row, a lagging migration) — this is
   * read-only grounding for a prompt, not part of the mutation's audit trail
   * (unlike VersioningService.logActivity's outbox write, which is correctly
   * unconditional).
   */
  private async stewardContext(
    tenantId: string,
    clientId: string | null,
  ): Promise<{ stewardFacts: StewardFactLine[]; stewardHealth: StewardHealth }> {
    try {
      const [stewardFacts, health] = await Promise.all([
        this.steward.factsForOrchestrator(tenantId, clientId),
        this.steward.health(tenantId, clientId),
      ]);
      return {
        stewardFacts,
        stewardHealth: {
          status: health.status,
          missingRequired: health.missingRequired,
          openMaterialConflicts: health.openMaterialConflicts,
        },
      };
    } catch (err) {
      this.logger.warn(
        `steward context unavailable; drafting without it: ${(err as Error).message}`,
      );
      return MeriService.STEWARD_CONTEXT_FALLBACK;
    }
  }

  /**
   * Stage-G grounded content generation: draft the FULL body of one Execution
   * Agent artifact (a Workspace document or an Outreach message) for a single
   * plan node, via the orchestrator's strategy-document-draft endpoint. Reuses
   * the exact grounding assembly (fiscal/firm-phases/reference + Steward
   * facts/health) the draft()/assistant() paths already build — the caller
   * (ExecutionService) passes it in pre-computed rather than this method
   * re-fetching it, since the caller already fetched it for its own G0 gate.
   *
   * Fails SOFT (mirrors stewardContext/StrategyAttachmentResolver): ANY error —
   * missing clientId, orchestrator unavailable, malformed response — returns
   * `null` so the caller falls back to the deterministic placeholder. This is
   * read-only prompt content for an artifact body, never part of a run's
   * state/eligibility decision, so it must never fail the run.
   *
   * `tenantId` then `bearer` — BOTH are plain strings, so a swapped call site
   * would NOT be caught by tsc; it would silently auth-fail against the
   * orchestrator (wrong bearer) and permanently fall back to the placeholder.
   * Keep this order at every call site.
   */
  async draftExecutionDocument(
    tenantId: string,
    bearer: string,
    input: {
      kind: 'workspace_draft' | 'outreach_record';
      clientId: string | null;
      strategyType: string;
      goal: string | null;
      node: {
        id: string;
        kind: string;
        subject: string;
        title: string;
        note: string | null;
        startsOn: string | null;
        endsOn: string | null;
      };
      grounding: Grounding;
      stewardFacts: StewardFactLine[];
      stewardHealth: StewardHealth;
    },
  ): Promise<NodeDocumentDraftResponse | null> {
    // The pack + prompt are client-anchored — a client-less node (workspace
    // nodes, unlike outreach, don't require one) never reaches the orchestrator;
    // skip straight to the caller's placeholder rather than forwarding an
    // ungroundable request.
    if (!input.clientId) return null;
    try {
      const aiProvider = await this.resolver.resolve(tenantId);
      const body = {
        clientId: input.clientId,
        kind: input.kind,
        type: input.strategyType,
        goal: input.goal,
        node: input.node,
        ...input.grounding,
        stewardFacts: input.stewardFacts,
        stewardHealth: input.stewardHealth,
        attachments: [],
      };
      return await this.orchestrator.nodeDocumentDraft(body, bearer, aiProvider);
    } catch (err) {
      this.logger.warn(
        `execution document draft unavailable (${input.kind}); staging the deterministic placeholder: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Stage E provenance fact-check (runs AFTER the realism verifier): collect
   * every node provenance source ref of the form 'fact:<id>' from the persisted
   * plan, resolve them in ONE tenant-scoped findMany, and append WARNING
   * violations for citations that are unknown, not active, or belong to another
   * client — each naming the fact id + node title. Warnings only: a bad
   * citation annotates, it never blocks the write.
   */
  private async factCheckProvenance(
    tx: Tx,
    nodes: Array<{ id?: string | null; title: unknown; provenance?: unknown }>,
    clientId: string | null,
  ): Promise<Violation[]> {
    const citations: Array<{ factId: string; nodeId: string | null; nodeTitle: string }> = [];
    for (const node of nodes) {
      const prov = node.provenance as { sources?: unknown } | null | undefined;
      const sources = Array.isArray(prov?.sources)
        ? (prov.sources as Array<{ ref?: unknown }>)
        : [];
      for (const s of sources) {
        const m = typeof s?.ref === 'string' ? FACT_REF_RE.exec(s.ref) : null;
        if (!m) continue;
        citations.push({
          factId: m[1]!,
          nodeId: node.id ?? null,
          nodeTitle: String(node.title ?? ''),
        });
      }
    }
    if (citations.length === 0) return [];

    const queryIds = [
      ...new Set(citations.map((c) => c.factId).filter((id) => FACT_UUID_RE.test(id))),
    ];
    const rows = queryIds.length
      ? await tx.spContextFact.findMany({ where: { id: { in: queryIds } } })
      : [];
    const byId = new Map(rows.map((r) => [r.id, r] as const));

    const violations: Violation[] = [];
    const warn = (code: string, nodeId: string | null, message: string) =>
      violations.push({ code, severity: 'warning', nodeIds: nodeId ? [nodeId] : [], message });
    for (const { factId, nodeId, nodeTitle } of citations) {
      const fact = byId.get(factId);
      if (!fact) {
        warn('fact-unknown', nodeId, `'${nodeTitle}' cites a fact that does not exist (fact:${factId})`);
      } else if (fact.state !== 'active') {
        warn('fact-not-active', nodeId, `'${nodeTitle}' cites a ${fact.state} fact (fact:${factId})`);
      } else if (fact.clientId !== null && fact.clientId !== clientId) {
        warn('fact-client-mismatch', nodeId, `'${nodeTitle}' cites another client's fact (fact:${factId})`);
      }
    }
    return violations;
  }

  /** A6: run the shared realism verifier over a plan against this call's grounding. */
  private verify(strategyType: string, nodes: VerifierNodeSource[], ground: Grounding): Violation[] {
    const vnodes: VerifierNode[] = nodes.map((n) => ({
      id: String(n.id ?? ''),
      kind: String(n.kind ?? ''),
      subject: String(n.subject ?? ''),
      title: String(n.title ?? ''),
      startsOn: isoDate(n.startsOn) ?? '',
      endsOn: isoDate(n.endsOn ?? null),
      dependsOnIds: Array.isArray(n.dependsOnIds) ? (n.dependsOnIds as string[]) : [],
    }));
    return verifyPlan({
      strategyType,
      nodes: vnodes,
      fiscal: {
        today: ground.fiscal.today ?? null,
        fys: ground.fiscal.fys ?? [],
        fyLabels: ground.fiscal.fyLabels ?? [],
        focalFy: ground.fiscal.focalFy ?? '',
      },
      congress: ground.reference.congress,
      ppbeCurrentPhases: ground.reference.ppbeCurrentPhases,
    }).violations;
  }

  /** A6 gate — hard verifier errors block a draft/assistant write when enabled.
   *  Dark by default (annotate-only); flipped via STRATEGY_VERIFY_BLOCK at
   *  activation once the web renders the override flow. */
  private blockOnErrors(): boolean {
    return process.env.STRATEGY_VERIFY_BLOCK === 'true';
  }

  /** A6: record the verification outcome on the audit trail (plan.verified). */
  private async logVerification(
    tx: Tx,
    tenantId: string,
    actorUserId: string,
    strategyId: string,
    violations: Violation[],
  ): Promise<void> {
    const errorCount = violations.filter((v) => v.severity === 'error').length;
    await this.versioning.logActivity(tx, {
      tenantId,
      actorUserId,
      authorKind: 'meri',
      action: 'plan.verified',
      entityType: 'strategy',
      entityId: strategyId,
      after: { errorCount, warningCount: violations.length - errorCount, violations },
    });
  }
}

/**
 * The DISPLAY snapshots to store on the user's chat message. `attachmentIds` is
 * the authority for what Meri actually grounded on, so a snapshot whose id is
 * not in that list is dropped — the bubble can never claim a document the model
 * never saw. When the client sends ids but no snapshots (an older web build),
 * the ids are still recorded so the chip count stays truthful.
 */
function snapshotAttachments(dto: AssistantDto): ChatAttachmentSnapshot[] {
  const ids = dto.attachmentIds ?? [];
  if (ids.length === 0) return [];
  const allowed = new Set(ids);
  const provided = new Map(
    (dto.attachments ?? [])
      .filter((a) => allowed.has(a.id))
      .map((a) => [a.id, a] as const),
  );
  return ids.map((id) => {
    const snap = provided.get(id);
    return {
      id,
      filename: snap?.filename ?? 'Attachment',
      kind: snap?.kind ?? 'unsupported',
      status: snap?.status ?? 'attached',
    };
  });
}

/**
 * The bubble text for a Meri reply. The orchestrator's `reply` is normally
 * present; when it is blank the fallback states only what the server itself
 * knows happened, rather than inventing a sentence Meri did not say.
 */
function replyBody(reply: string | undefined, scope: string, editCount: number): string {
  const text = reply?.trim();
  if (text) return text;
  if (editCount === 0) return 'No changes were needed.';
  return scope === 'node' ? 'Updated this step.' : 'Updated the plan.';
}

/** Step 4: exactly one created step earns an `open_node` action; otherwise none. */
function openNodeAction(created: Array<{ id: string; title: string }>): ChatOpenNodeAction | null {
  if (created.length !== 1) return null;
  const node = created[0]!;
  return { type: 'open_node', nodeId: node.id, title: node.title };
}

/**
 * The seeded `context_gap` body for a degraded/conflicted draft, in the user's
 * language. Returns null when grounding was clean — no message is better than a
 * reassuring one nobody needs.
 *
 * 'conflicted' names the two disagreeing facts verbatim (clipped), matching what
 * the page banner said; that banner stays until Phase 5 ships the repair flow.
 */
function contextGapBody(health: GroundingHealth | undefined): string | null {
  if (!health) return null;
  if (health.status === 'conflicted') {
    const first = health.openMaterialConflicts?.[0];
    const detail = first
      ? `“${clipFact(first.factA)}” and “${clipFact(first.factB)}” disagree.`
      : 'Some facts in this client’s context materially disagree.';
    return `I drafted this with unresolved conflicts in your client context. ${detail} Resolve which one controls, then ask me to revisit the plan.`;
  }
  if (health.status === 'degraded') {
    const labels = (health.missingRequired ?? []).map(
      (key) => CONTEXT_GAP_LABELS[key] ?? 'some client context',
    );
    const missing = [...new Set(labels)];
    const what =
      missing.length === 0
        ? 'some client context'
        : missing.length === 1
          ? missing[0]!
          : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]!}`;
    return `I drafted this without ${what}, so the client-specific details are my best guess. Check them before you rely on this plan.`;
  }
  return null;
}

/** Keep a quoted fact short enough to read inside a chat bubble. */
function clipFact(text: string, max = 120): string {
  const t = (text ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function deriveTitle(goal: string | undefined, type: StrategyTypeValue): string {
  const g = goal?.trim();
  if (g) return g.length > 120 ? `${g.slice(0, 117)}…` : g;
  return `${TYPE_LABEL[type]} strategy`;
}

function versionNote(
  reply: string | undefined,
  summary: string | null | undefined,
  scope: string,
  attachmentCount = 0,
): string {
  const s = summary?.trim();
  const base = s
    ? `Meri: ${s.length > 160 ? s.slice(0, 157) + '…' : s}`
    : scope === 'node'
      ? 'Meri edited this step'
      : 'Meri updated the plan';
  // MRI-7: reference the grounding attachment(s) in the version note.
  return attachmentCount
    ? `${base} (from your ${attachmentCount === 1 ? 'attachment' : 'attachments'})`
    : base;
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
    dependsOnIds: string[];
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
      dependsOnIds: n.dependsOnIds,
      meriAuthored: n.meriAuthored,
    })),
  };
}
