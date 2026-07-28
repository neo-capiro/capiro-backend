import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  repairDependencyOrder,
  verifyPlan,
  type VerifierNode,
  type Violation,
} from '@capiro/strategy-verifier';
import { Prisma, SpNodeKind, SpNodeStatus, SpNodeSubject } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import { parseDbDate } from '../strategy/dates.js';
import { loadStrategyDetail } from '../strategy/detail.js';
import { isoDate } from '../strategy/versioning.js';
import { LIVE_NODE_WHERE } from '../strategy/live-node.js';
import { fyOf } from '../fiscal/fiscal.js';
import { withContextRetry } from './context-load.js';
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
  PublicContextGap,
  StewardFactLine,
  StewardHealth,
  StrategyDraftErrorBody,
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
    // Phase 5 §3.2: firm phases + reference calendars are "required to attempt
    // draft" sources — bounded retry on a transient load, never on a genuine
    // absence (an unconfigured tenant's empty list is not an error to retry).
    const [phases, ref] = await Promise.all([
      withContextRetry('firm-phases', () => this.firmPhases.list(tenantId)),
      withContextRetry('reference-calendars', () => this.reference.getCalendars(tenantId)),
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
    // raw read returns 0 and false-negatives every valid client. Phase 5 §3.2:
    // "required to attempt draft" — bounded retry on a transient pool/connection
    // failure, never on a genuinely unknown client (that 400s below, same as today).
    const clientRows = await withContextRetry('client-existence', () =>
      this.prisma.withTenant(tenantId, (tx) =>
        tx.$queryRaw<Array<{ ok: number }>>`
        SELECT 1 AS ok FROM clients WHERE id = ${dto.clientId}::uuid AND tenant_id = ${tenantId}::uuid LIMIT 1`,
      ),
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

    // A7.5 / Phase 5 §4.3: never silently persist an empty draft — typed 422
    // (before the timeline route ever loads) so the Goal flow can show a
    // specific next step instead of a bare "try rephrasing" dead end.
    const rawNodes = (resp.nodes ?? []).slice(0, 60);
    if (rawNodes.length === 0) {
      const body: StrategyDraftErrorBody = {
        code: 'STRATEGY_DRAFT_INPUT_REQUIRED',
        message: 'Meri needs a little more information before it can build this timeline.',
        requiredInputs: [
          {
            code: 'more-detail',
            label: 'more detail in your goal, or a document for Meri to work from',
            canAttach: true,
          },
        ],
      };
      throw new UnprocessableEntityException(body);
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

    // A6 / Phase 5 §4: verify the plan we're about to persist (authoritative —
    // real uuids + grounding). The gate is now UNCONDITIONAL for a draft — no
    // more STRATEGY_VERIFY_BLOCK env check on this path (assistant()/
    // verifyAppliedPlan() keep the existing env-gated behavior; a draft is the
    // one surface the prototype's "no warning stack after generation" contract
    // covers). Before rejecting, try the SAME deterministic dependency-order
    // repair the orchestrator already ran index-side, against the REAL uuid
    // graph — a second, independent pass that never depends on the
    // orchestrator having run it (or having run it correctly).
    let violations = this.verify(dto.type, nodeData, ground);
    let errs = violations.filter((v) => v.severity === 'error');
    if (errs.length > 0) {
      const repair = repairDependencyOrder(toVerifierNodes(nodeData));
      if (!repair.refused && repair.changedIds.length > 0) {
        applyRepairedNodeDates(nodeData, repair.nodes);
        violations = this.verify(dto.type, nodeData, ground);
        errs = violations.filter((v) => v.severity === 'error');
        this.logger.log(
          `strategy draft: deterministic repair retimed ${repair.changedIds.length} node(s), ${errs.length} error(s) remain`,
        );
      }
    }
    if (errs.length > 0) {
      throw new UnprocessableEntityException(draftErrorBody(errs, resp.groundingHealth));
    }

    // Phase 5 §3.3/§6: classify any remaining (advisory, non-blocking) gap
    // BEFORE persisting, so the affected nodes' provenance is stamped in the
    // SAME createMany as everything else — no separate post-create pass for
    // the fresh-draft case (assistant() below handles the resync case, where
    // nodes already exist).
    const nodeIds = nodeData.map((n) => n.id as string);
    const gaps = computeContextGaps(resp.groundingHealth, nodeIds, nodesForFactCitation(nodeData));
    if (gaps.length > 0) {
      const needsByNode = groupGapsByNode(gaps);
      for (const n of nodeData) {
        n.provenance = withContextNeeds(n.provenance, needsByNode.get(n.id as string) ?? []);
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
      // Phase 5 §5: ONE upsert, not append — a fresh draft never has a prior
      // active context_gap row, so this always creates on a real gap (never a
      // duplicate), and no-ops cleanly when there is none. Same upsert path
      // assistant() uses below, so a later edit that resolves/changes the gap
      // set updates this SAME row rather than stacking a second one.
      await this.conversations.syncContextGap(tx, tenantId, strategy.id, gapMessageBody(gaps));
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
        // Phase 5 §5/§6: a pure question can still be the turn that resolves a
        // gap — e.g. the user attaches the missing document and asks a question
        // rather than requesting a plan change. Resync against THIS call's
        // groundingHealth exactly as the edit-bearing branch below does; a
        // clean `resp.groundingHealth` here is otherwise never observed.
        const gaps = computeContextGaps(
          resp.groundingHealth,
          loaded.nodes.map((n) => n.id),
          nodesForFactCitation(loaded.nodes),
        );
        await this.syncNodeContextNeeds(tx, loaded.nodes, gaps);
        const gapSync = await this.conversations.syncContextGap(
          tx,
          tenantId,
          strategyId,
          gapMessageBody(gaps),
        );
        if (gapSync.wasResolved) {
          await this.conversations.appendIn(tx, tenantId, {
            strategyId,
            nodeId: null,
            role: 'meri',
            kind: 'message',
            body: 'The missing context is resolved — I factored it into the plan.',
            createdByUserId: null,
          });
        }
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

      // Phase 5 §5/§6: resync the context-gap message + affected-node markers
      // against THIS call's fresh groundingHealth — this is how an existing
      // degraded/conflicted strategy's gap actually clears (e.g. attaching a
      // document via chat resolves it on the very next assistant call).
      const gaps = computeContextGaps(
        resp.groundingHealth,
        d.nodes.map((n) => n.id),
        nodesForFactCitation(d.nodes),
      );
      await this.syncNodeContextNeeds(tx, d.nodes, gaps);
      const gapSync = await this.conversations.syncContextGap(tx, tenantId, strategyId, gapMessageBody(gaps));
      if (gapSync.wasResolved) {
        await this.conversations.appendIn(tx, tenantId, {
          strategyId,
          nodeId: null,
          role: 'meri',
          kind: 'message',
          body: 'The missing context is resolved — I factored it into the plan.',
          createdByUserId: null,
        });
      }

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
      // Phase 5 §3.2: Steward facts/health are classified sources too — bounded
      // retry sits INSIDE this fail-soft try so a transient hiccup gets its
      // retries before this method's own degraded-fallback gives up on it.
      const [stewardFacts, health] = await Promise.all([
        withContextRetry('steward-facts', () => this.steward.factsForOrchestrator(tenantId, clientId)),
        withContextRetry('steward-health', () => this.steward.health(tenantId, clientId)),
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

  /**
   * Phase 5 §6 — reconcile every LIVE node's provenance.contextNeeds against
   * the current gap set: sets it on newly affected nodes, clears it from
   * nodes whose gap resolved, and writes NOTHING for a node whose status did
   * not change (an unaffected, never-flagged node is never touched).
   */
  private async syncNodeContextNeeds(
    tx: Tx,
    nodes: Array<{ id: string; provenance: unknown }>,
    gaps: PublicContextGap[],
  ): Promise<void> {
    const needsByNode = groupGapsByNode(gaps);
    for (const node of nodes) {
      const current = (node.provenance as { contextNeeds?: Array<{ code: string }> } | null)
        ?.contextNeeds ?? [];
      const next = needsByNode.get(node.id) ?? [];
      const sameKeys =
        current.length === next.length && current.every((c, i) => c.code === next[i]?.code);
      if (sameKeys) continue;
      await tx.spNode.update({
        where: { id: node.id },
        data: { provenance: withContextNeeds(node.provenance, next) },
      });
    }
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
 * Phase 5 §3.3 — classify the current groundingHealth into plain-language,
 * closed-mapped gaps. Never a raw template key, enum identifier, or database
 * column reaches the result. A conflict gap attributes to whichever nodes
 * cite either disputed fact (same citation scan as factCheckProvenance); a
 * missing-required-document gap has no single citation to point at, so it
 * affects every node in `nodeIds` (the whole draft was made without it).
 */
function computeContextGaps(
  health: GroundingHealth | undefined,
  nodeIds: string[],
  citingNodeIds: (factId: string) => string[],
): PublicContextGap[] {
  if (!health) return [];
  if (health.status === 'conflicted') {
    const conflicts = health.openMaterialConflicts ?? [];
    return conflicts.map((c) => {
      const affected = [...new Set([...citingNodeIds(c.factAId), ...citingNodeIds(c.factBId)])];
      return {
        code: `conflict:${c.id}`,
        label: `a disagreement between “${clipFact(c.factA)}” and “${clipFact(c.factB)}”`,
        affectedNodeIds: affected.length ? affected : nodeIds,
        canAttach: false,
      };
    });
  }
  if (health.status === 'degraded') {
    const keys = [...new Set(health.missingRequired ?? [])];
    return keys.map((key) => ({
      code: key,
      label: CONTEXT_GAP_LABELS[key] ?? 'some client context',
      affectedNodeIds: nodeIds,
      canAttach: true,
    }));
  }
  return [];
}

/** Node ids whose provenance cites the given Steward fact id ('fact:<uuid>' —
 *  the same ref shape factCheckProvenance resolves). Pass the current node
 *  list once, get back a cheap repeated lookup — used for both conflict-gap
 *  ids above. */
function nodesForFactCitation(
  nodes: Array<{ id?: string | null; provenance?: unknown }>,
): (factId: string) => string[] {
  const byFact = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.id) continue;
    const prov = node.provenance as { sources?: unknown } | null | undefined;
    const sources = Array.isArray(prov?.sources) ? (prov!.sources as Array<{ ref?: unknown }>) : [];
    for (const s of sources) {
      const m = typeof s?.ref === 'string' ? FACT_REF_RE.exec(s.ref) : null;
      if (!m) continue;
      const list = byFact.get(m[1]!) ?? [];
      list.push(node.id);
      byFact.set(m[1]!, list);
    }
  }
  return (factId: string) => byFact.get(factId) ?? [];
}

/** Invert a gap list into per-node `contextNeeds` entries (plan §6). */
function groupGapsByNode(gaps: PublicContextGap[]): Map<string, Array<{ code: string; label: string }>> {
  const byNode = new Map<string, Array<{ code: string; label: string }>>();
  for (const g of gaps) {
    for (const nodeId of g.affectedNodeIds) {
      const list = byNode.get(nodeId) ?? [];
      list.push({ code: g.code, label: g.label });
      byNode.set(nodeId, list);
    }
  }
  return byNode;
}

/**
 * Phase 5 §6 — merge/clear `contextNeeds` on a node's provenance JSON.
 * Additive to any existing `sources` (a citation is never dropped) and
 * removed ENTIRELY (not left as an empty array) when a node has no current
 * gap, so a resolved node's provenance returns to exactly what it was before
 * this phase touched it — never an unrelated status enum, per the plan.
 */
function withContextNeeds(
  provenance: unknown,
  needs: Array<{ code: string; label: string }>,
): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  const prov = provenance as { sources?: unknown } | null | undefined;
  const sources = Array.isArray(prov?.sources) ? prov!.sources : undefined;
  if (needs.length === 0) {
    return sources ? ({ sources } as Prisma.InputJsonValue) : Prisma.DbNull;
  }
  return { ...(sources ? { sources } : {}), contextNeeds: needs } as Prisma.InputJsonValue;
}

/**
 * The seeded `context_gap` body (plan §5): one sentence on what's missing,
 * then the two paths forward. Null when there are no gaps — no message is
 * better than a reassuring one nobody needs. A conflict names the plain-
 * language disagreement (never raw fact ids) and, per the plan, does NOT link
 * away to the Steward from a chat message — the attach/manual paths cover it.
 */
function gapMessageBody(gaps: PublicContextGap[]): string | null {
  if (gaps.length === 0) return null;
  const conflict = gaps.find((g) => !g.canAttach);
  if (conflict) {
    return `I drafted this with an unresolved conflict in your client context — ${conflict.label}. Resolve which fact controls in the Steward, then ask me to revisit the plan, or adjust the timeline manually.`;
  }
  const labels = [...new Set(gaps.map((g) => g.label))];
  const what =
    labels.length === 1
      ? labels[0]!
      : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]!}`;
  return `I drafted this without ${what}, so those details are my best guess. Attach the missing document here, or adjust the timeline manually.`;
}

/** Phase 5 §4.3 — the typed 422 a draft returns when hard errors survive
 *  deterministic repair. A structural defect (a cycle, or an edge to a step
 *  that was never in the plan) is never something more input fixes — that's
 *  always STRATEGY_DRAFT_INVALID regardless of grounding. Otherwise, if the
 *  context was degraded/conflicted, blame the errors on the missing input
 *  (INPUT_REQUIRED, with the concrete gaps as requiredInputs); a plan that
 *  still fails with CLEAN grounding is a generation defect, not a context gap. */
function draftErrorBody(errs: Violation[], health: GroundingHealth | undefined): StrategyDraftErrorBody {
  const structural = errs.some((e) => e.code === 'dep-cycle' || e.code === 'dep-missing' || e.code === 'dep-self');
  const message = 'Meri needs a little more information before it can build this timeline.';
  if (health && health.status !== 'ok' && !structural) {
    const gaps = computeContextGaps(health, [], () => []);
    return {
      code: 'STRATEGY_DRAFT_INPUT_REQUIRED',
      message,
      requiredInputs: gaps.map((g) => ({ code: g.code, label: g.label, canAttach: g.canAttach })),
      violations: errs.map((e) => ({ message: e.message })),
    };
  }
  return {
    code: 'STRATEGY_DRAFT_INVALID',
    message,
    requiredInputs: [],
    violations: errs.map((e) => ({ message: e.message })),
  };
}

/** Draft nodeData (real uuids, Date fields) -> VerifierNode[] (ISO strings) —
 *  the same shape MeriService.verify() builds internally, exposed here so the
 *  Phase 5 repair pass can run against the identical representation. */
function toVerifierNodes(nodeData: Array<Prisma.SpNodeCreateManyInput>): VerifierNode[] {
  return nodeData.map((n) => ({
    id: String(n.id ?? ''),
    kind: String(n.kind ?? ''),
    subject: String(n.subject ?? ''),
    title: String(n.title ?? ''),
    startsOn: isoDate(n.startsOn as Date) ?? '',
    endsOn: isoDate((n.endsOn as Date | null | undefined) ?? null),
    dependsOnIds: Array.isArray(n.dependsOnIds) ? (n.dependsOnIds as string[]) : [],
  }));
}

/** Write repairDependencyOrder's retimed dates back onto the real nodeData
 *  rows it was computed from (matched by uuid, not array position — repair
 *  returns its own topologically-reordered array). */
function applyRepairedNodeDates(
  nodeData: Array<Prisma.SpNodeCreateManyInput>,
  repaired: VerifierNode[],
): void {
  const byId = new Map(nodeData.map((n) => [String(n.id ?? ''), n]));
  for (const r of repaired) {
    const n = byId.get(r.id);
    if (!n) continue;
    n.startsOn = parseDbDate(r.startsOn, 'repaired startsOn');
    n.endsOn = r.endsOn ? parseDbDate(r.endsOn, 'repaired endsOn') : null;
  }
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
