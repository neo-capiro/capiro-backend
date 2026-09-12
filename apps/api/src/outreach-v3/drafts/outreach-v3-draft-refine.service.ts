/**
 * "Refine with Meri" — a natural-language edit of ONE already-persisted draft
 * slot, run through the governed generation gateway in revision mode.
 *
 * Same authority shape as representative sample generation
 * (OutreachV3SampleGenerationService): the gateway is the only path to a model,
 * `plan.eligible` is the gate, and every target/context snapshot is
 * reauthorized by prepareSlot() before the model is called. Refine differs in
 * exactly two ways — it operates on the single plan slot that owns this
 * artifact, and it hands the gateway the draft's CURRENT subject/body plus the
 * user's instruction so the model edits that text rather than writing new text.
 *
 * WHY THE MODEL OUTPUT IS PERSISTED THROUGH createEditedVersion():
 *
 * The regeneration entry point (upsertGeneratedVersionOrCandidate) returns a
 * non-advancing CANDIDATE whenever the current version is `manually_authored`,
 * and createEditedVersion() stamps `manually_authored` for every editKind —
 * including 'improve'. In Outreach V2 those two facts meet and break the
 * feature: an Improve that follows a hand edit (or follows an earlier Improve)
 * persists a candidate nobody accepts, so the user sees nothing change.
 *
 * Refine therefore never touches the generated/candidate path. createEditedVersion
 * is append-only and ALWAYS advances `currentVersion` under the artifact row
 * lock, so a refine lands as the new current version whether the base version
 * was generated or hand-authored. It also gives us the two properties this
 * action needs for free: `sourceVersionId` lineage back to the exact text the
 * model was shown, and a stale `baseVersionId` surfacing as the existing
 * OUTREACH_DRAFT_VERSION_STALE 409 instead of a silent overwrite.
 *
 * The cost of that choice is deliberate: createEditedVersion has no
 * `verifierFindings` seam, so the gateway's deterministic government-affairs
 * verdict on the refined text cannot be merged into the new version's audit
 * findings. Rather than drop a blocking verdict, a non-'ready' outcome is
 * refused outright and no version is written — a refine that cannot be recorded
 * with its verdict must not become the current draft.
 */
import { ConflictException, Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { GenerationGatewayService } from '../../engagement/generation/generation-gateway.service.js';
import {
  OutreachDraftService,
  type OutreachDraftArtifactDto,
  type OutreachDraftVersionDto,
} from '../../engagement/outreach-draft.service.js';
import { buildOutreachV3GenerationPlan } from '../generation/outreach-v3-generation-plan.js';
import { OutreachV3GenerationPreparationService } from '../generation/outreach-v3-generation-preparation.service.js';
import { buildOutreachV3GatewayUnit } from '../generation/outreach-v3-generation-request.js';
import { OutreachSessionService } from '../services/outreach-session.service.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import { OutreachV3ArtifactRootService } from './outreach-v3-artifact-root.service.js';

export interface OutreachV3DraftRefineInput {
  /** The version the user was looking at. Must still be the current one. */
  baseVersionId: string;
  /** The user's natural-language edit instruction. */
  instruction: string;
}

@Injectable()
export class OutreachV3DraftRefineService {
  constructor(
    private readonly sessions: OutreachSessionService,
    private readonly preparation: OutreachV3GenerationPreparationService,
    private readonly roots: OutreachV3ArtifactRootService,
    private readonly gateway: GenerationGatewayService,
    private readonly drafts: OutreachDraftService,
  ) {}

  async refine(
    ctx: TenantContext,
    sessionId: string,
    artifactId: string,
    input: OutreachV3DraftRefineInput,
    authHeader?: string,
  ): Promise<OutreachDraftVersionDto> {
    if (!this.gateway.enabled) {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_BLOCKED',
        'Governed generation is not enabled for this runtime.',
        503,
        { reason: 'generation_gateway_disabled' },
      );
    }

    const current = await this.sessions.getSession(ctx, sessionId);
    if (current.session.status !== 'active') {
      throw new OutreachCommandError(
        'OUTREACH_SESSION_ARCHIVED',
        'Archived outreach sessions cannot refine drafts.',
        409,
      );
    }

    // The same gate every other V3 generation action uses. Deliberately
    // plan.eligible, not readiness.sampleGenerationEligible: the latter is a
    // later-phase availability flag and is false even for a complete campaign.
    const plan = buildOutreachV3GenerationPlan({
      sessionId,
      stateVersion: current.currentStateVersion,
      specHash: current.specHash,
      spec: current.spec,
      readiness: current.readiness,
      pendingProposalCount: current.pendingProposalCount,
    });
    if (!plan.eligible) {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_BLOCKED',
        'The campaign is not ready for draft refinement.',
        409,
        {
          reason: 'generation_plan_not_eligible',
          blockers: plan.blockers.length ? plan.blockers.join(',') : null,
        },
      );
    }

    const { outreachRecordId } = await this.roots.ensureRoot(ctx, sessionId);
    const artifact = await this.loadArtifact(ctx, outreachRecordId, artifactId);
    const base = artifact.current;
    if (!base) {
      throw blocked(
        'This draft has no current version to refine. Generate it before refining.',
        'draft_version_missing',
      );
    }
    // The version the user was shown must still be the current one. Checked here
    // as well as under the artifact row lock inside createEditedVersion, so an
    // edit race that is already lost costs no model spend — and both paths
    // return the same OUTREACH_DRAFT_VERSION_STALE contract.
    if (base.id !== input.baseVersionId) {
      throw new ConflictException({
        statusCode: 409,
        error: 'OUTREACH_DRAFT_VERSION_STALE',
        message:
          'A newer version of this draft exists. Load the latest version before refining again.',
        currentVersionId: base.id,
        currentVersion: base.version,
      });
    }
    // Revision mode in the governed prompt turns on `existingBody` alone. An
    // empty body would silently downgrade this action into a fresh generation
    // that discards the draft, so it is refused instead.
    if (!base.body.trim()) {
      throw blocked(
        'This draft version has no body to refine. Edit it before refining.',
        'draft_body_empty',
      );
    }

    // Refine touches exactly one slot: the plan slot that owns this artifact.
    const slot = plan.slots.find((candidate) => candidate.generationKey === artifact.generationKey);
    if (!slot) {
      throw blocked(
        'This draft does not belong to the current generation plan. Review the campaign before refining.',
        'draft_slot_not_in_plan',
      );
    }

    // Reauthorize the exact target and context snapshots before the model call,
    // exactly as a first-pass generation does. A changed target or an
    // unavailable context blocks the refine rather than grounding it in stale
    // evidence.
    const prepared = await this.preparation.prepareSlot(ctx, current.spec, slot);

    // outreachRecordId is deliberately NOT passed: the gateway persists its own
    // `generated` version whenever it has a parent record, which would both mint
    // a second version for one user action and make our baseVersionId stale.
    // Persistence is this service's job, through createEditedVersion below.
    const unit = buildOutreachV3GatewayUnit({
      plan,
      spec: current.spec,
      prepared,
      ...(authHeader ? { authHeader } : {}),
    });
    unit.request.existingSubject = base.subject;
    unit.request.existingBody = base.body;
    // The gateway promotes this to the authoritative objective directive in
    // revision mode, so what the user asked for outranks the campaign template.
    unit.request.reviseInstruction = input.instruction;

    const resolved = await this.gateway.resolvePinnedIdentity(ctx, {
      runtimeAction: unit.request.runtimeAction,
    });
    if (!resolved) {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_BLOCKED',
        'Drafting is not configured for this workspace.',
        503,
        { reason: 'ai_not_configured' },
      );
    }
    unit.request.pinned = resolved.pinned;

    const generated = await this.gateway.generate(
      ctx,
      unit.request,
      {
        channels: unit.enrichments,
        clientBrief: null,
        clientName: null,
        // topicTerms only feeds the relevant-mail ranker, and that expansion is
        // off here for the same reason it is off for samples: it would create
        // factual packet evidence with no matching V3 selected-context decision.
        topicTerms: [],
        auditLedger: unit.auditLedger,
        includeRelevantEmail: false,
      },
      resolved.creds,
    );
    if (generated.outcome !== 'ready' || !generated.body.trim()) {
      throw blocked(
        'The refined draft did not pass governed generation, so the draft was left unchanged.',
        generated.error
          ? `generation_${generated.outcome}:${generated.error}`
          : `generation_${generated.outcome}`,
      );
    }

    // External model work cannot hold a campaign-state lock. If Campaign Spec
    // moved while the model was running, the refined text was grounded in a plan
    // that no longer exists, so it is never recorded as the current draft.
    const after = await this.sessions.getSession(ctx, sessionId);
    if (after.currentStateVersion !== plan.stateVersion || after.specHash !== plan.specHash) {
      throw new OutreachCommandError(
        'OUTREACH_STATE_CONFLICT',
        'The campaign changed while this draft was being refined. Review the updated plan before refining again.',
        409,
        { currentStateVersion: after.currentStateVersion },
      );
    }

    // Append-only and always advancing — never the generated/candidate path.
    return this.drafts.createEditedVersion(ctx, artifactId, {
      baseVersionId: input.baseVersionId,
      subject: generated.subject,
      body: generated.body,
      editKind: 'improve',
    });
  }

  private async loadArtifact(
    ctx: TenantContext,
    outreachRecordId: string,
    artifactId: string,
  ): Promise<OutreachDraftArtifactDto> {
    const artifacts = await this.drafts.listForOutreach(ctx, outreachRecordId);
    const artifact = artifacts.find((candidate) => candidate.id === artifactId);
    // Defence in depth: the controller already rejects an artifact outside this
    // campaign before any model spend. Same code as the approval service uses
    // for a draft that does not belong to the campaign being acted on.
    if (!artifact) {
      throw new OutreachCommandError(
        'OUTREACH_REFERENCE_UNAUTHORIZED',
        'The draft artifact does not belong to this outreach campaign.',
        403,
      );
    }
    if (artifact.outreachRecordId !== outreachRecordId) {
      throw new OutreachCommandError(
        'OUTREACH_STATE_CORRUPT',
        'The draft artifact does not match its campaign artifact root.',
        500,
      );
    }
    return artifact;
  }
}

function blocked(message: string, reason: string): OutreachCommandError {
  return new OutreachCommandError('OUTREACH_COMMAND_BLOCKED', message, 409, { reason });
}
