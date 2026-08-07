import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { CompiledContextPacket } from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AppConfig } from '../config/config.schema.js';
import { FundingOpportunitiesService } from './funding-opportunities.service.js';
import { GovernmentLandscapeService } from './government-landscape.service.js';
import {
  MeriOpportunityToolsAdapter,
  asOpportunitySource,
  isDeniedPacket,
  type MeriToolEnvelope,
} from './meri-opportunity-tools.adapter.js';
import { explainOpportunity } from './opportunity-explanation.js';
import {
  ASSESSMENT_POLICY_VERSION,
  ASSESSMENT_PROMPT_VERSION,
  assessmentSystemPrompt,
  buildAssessment,
  parseModelJson,
  quoteUntrusted,
  type AssessmentProvenance,
  type DeterministicPacket,
  type EvidenceRef,
  type MeriOpportunityAssessment,
  type ModelState,
} from './meri-opportunity-assessment.schema.js';

/**
 * Governed executive assessment for one opportunity (P38).
 *
 * ── The same packet the UI shows ─────────────────────────────────────────────
 *
 * The deterministic half is assembled from the SAME reads the detail surface
 * renders — P06's recommendation, P09's explanation, P23's acquisition
 * position, P33's landscape, P34's action plan. Not a parallel gather written
 * for the model: a user who disagrees with the assessment has to be able to
 * find the disagreement on screen, and two gathers would eventually differ.
 *
 * ── The model is the last step, and the least load-bearing ───────────────────
 *
 * Everything above is computed before the model is called and survives it
 * failing. `modelState: 'unavailable'` is a normal result: the deterministic
 * assessment is still returned, still restates the recommendation, and still
 * names the next action. P38's own acceptance line — "model failure leaves
 * deterministic assessment available" — is therefore the DEFAULT path rather
 * than a handled exception.
 *
 * ── Gate reuse, not gate copy ────────────────────────────────────────────────
 *
 * The flag/role/wall check is P37's, called through the adapter rather than
 * reimplemented here. Two copies of an ethical wall is how one of them ends up
 * a version behind.
 *
 * ── Nothing here writes to the product ───────────────────────────────────────
 *
 * Three persistence targets, all of them audit surfaces: a `clio_artifacts`
 * row (the assessment itself, versioned through the table's own
 * parentArtifactId chain), claim/evidence rows via the existing claim writer,
 * and one `compliance_check` row. No task, no workflow, no memory, no send. The
 * drafts this returns are proposals with no side effect until a person acts on
 * them elsewhere.
 */

/** Anything the caller needs to render, including the refusals. */
export type AssessmentResult =
  | { state: 'available'; assessment: MeriOpportunityAssessment; provenance: AssessmentProvenance }
  | { state: 'disabled' | 'denied' | 'not_found' | 'unsupported_source' | 'invalid_request'; explanation: string };

interface AssessActor {
  tenantId: string;
  userId: string;
  role: TenantContext['role'];
}

export interface AssessInput {
  clientId: string;
  source: string;
  sourceRecordId: string;
  /**
   * The Meri conversation this assessment belongs to.
   *
   * Required, and that is a design choice rather than a schema accident:
   * `clio_artifacts.conversation_id` is NOT NULL, and rather than add a
   * migration to loosen it, the assessment is scoped to the conversation that
   * asked for it. That also gives artifact VERSIONING for free — a re-run
   * chains through the table's existing parentArtifactId, which is exactly the
   * "reopening preserves the prior version" shape P36 will need too.
   */
  conversationId: string;
}

const ARTIFACT_KIND = 'funding_opportunity_assessment';

@Injectable()
export class MeriOpportunityAssessmentService {
  private readonly logger = new Logger(MeriOpportunityAssessmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly tools: MeriOpportunityToolsAdapter,
    private readonly opportunities: FundingOpportunitiesService,
    private readonly landscape: GovernmentLandscapeService,
  ) {}

  /**
   * Optional collaborators, injected by the module when present.
   *
   * Setters rather than constructor parameters so a unit test can exercise the
   * whole assessment path without standing up the context compiler, the claim
   * store and the audit store — and so a missing one degrades to a stated
   * `compilerVersion: null` rather than a boot failure. Every one of the three
   * is an AUDIT surface: none of them can change what the assessment says.
   */
  private contextCompiler: { compile(req: never): Promise<CompiledContextPacket> } | null = null;
  private claimWriter: {
    persistClaimsSafe(
      tenantId: string,
      subject: { subjectType: string; subjectId: string; artifactId?: string | null },
      claims: Array<{ claim: string; supported: boolean; sourceIds: number[] }>,
      sources: Array<{ n: number; type: string; id: string; title: string }>,
    ): Promise<void>;
  } | null = null;
  private auditor: {
    recordSafe(
      ctx: TenantContext,
      rec: {
        trigger: string;
        decision: 'PASS' | 'WARN' | 'BLOCK';
        reason: string;
        ruleSource?: string | null;
        requiredApproval?: boolean;
        entityType?: string | null;
        entityId?: string | null;
      },
    ): Promise<void>;
  } | null = null;

  withCollaborators(deps: {
    contextCompiler?: typeof MeriOpportunityAssessmentService.prototype.contextCompiler;
    claimWriter?: typeof MeriOpportunityAssessmentService.prototype.claimWriter;
    auditor?: typeof MeriOpportunityAssessmentService.prototype.auditor;
  }): this {
    if (deps.contextCompiler !== undefined) this.contextCompiler = deps.contextCompiler;
    if (deps.claimWriter !== undefined) this.claimWriter = deps.claimWriter;
    if (deps.auditor !== undefined) this.auditor = deps.auditor;
    return this;
  }

  /**
   * Model transport. Overridable so the suite never touches the network — the
   * default is a plain Anthropic completion mirroring
   * meri-research.service.ts's own `anthropicComplete`.
   */
  private complete: ((tenantId: string, system: string, user: string) => Promise<string>) | null =
    null;
  /**
   * `tenantId` is a parameter, not a closure capture.
   *
   * BYOK is per tenant in this codebase — `AiCredentialResolverService` resolves
   * a tenant's own Anthropic key and falls back to the platform one. A
   * transport that could not see the tenant would silently spend the platform
   * key on a workspace that brought its own.
   */
  withCompletion(fn: (tenantId: string, system: string, user: string) => Promise<string>): this {
    this.complete = fn;
    return this;
  }

  async assess(
    actor: AssessActor,
    input: AssessInput,
    asOf: Date = new Date(),
  ): Promise<AssessmentResult> {
    // ── Gate. P37's, not a second copy.
    const probe = await this.tools.getFundingOpportunity(
      actor,
      { clientId: input.clientId, source: input.source, sourceRecordId: input.sourceRecordId },
      asOf,
    );
    if (probe.state !== 'available') return refusalFrom(probe);

    const source = asOpportunitySource(input.source);
    if (!source) {
      return { state: 'unsupported_source', explanation: probe.explanation };
    }

    // ── The deterministic half. Computed BEFORE the model and independent of it.
    const packet = await this.buildPacket(actor, source, input, asOf);

    // ── Context Packet v2. Best-effort: its absence lowers provenance detail,
    // never the assessment's own correctness.
    const compiled = await this.compileContext(actor, input, asOf);

    // ── The model. Last, and optional.
    const { raw, modelState, explanation, model } = await this.runModel(actor, packet, compiled);

    const assessment = buildAssessment(packet, raw, modelState, explanation);
    const provenance: AssessmentProvenance = {
      promptVersion: ASSESSMENT_PROMPT_VERSION,
      policyVersion: ASSESSMENT_POLICY_VERSION,
      compilerVersion: compilerVersionOf(compiled),
      contextPacketId: packetIdOf(compiled),
      model,
      artifactVersion: 1,
      assessedAt: asOf.toISOString(),
    };

    provenance.artifactVersion = await this.persist(actor, input, assessment, provenance);
    await this.recordClaims(actor, packet, assessment);
    await this.audit(actor, input, assessment);

    return { state: 'available', assessment, provenance };
  }

  // ── The deterministic packet ──────────────────────────────────────────────

  private async buildPacket(
    actor: AssessActor,
    source: 'grants_gov' | 'sam_gov',
    input: AssessInput,
    asOf: Date,
  ): Promise<DeterministicPacket> {
    const row = await this.opportunities.getOpportunity(
      actor.tenantId,
      source,
      input.sourceRecordId,
      input.clientId,
    );
    const explained = explainOpportunity(row.matchedSignals);

    // P33 and P34 are SAM-only and may legitimately refuse. A refusal lowers
    // coverage and is reported as such by `incompletenessOf`; it never becomes
    // a claim that the opportunity has no context.
    const landscape =
      source === 'sam_gov'
        ? await this.landscape
            .compose(actor.tenantId, actor.userId, input.clientId, 'sam_gov', input.sourceRecordId, asOf)
            .catch(() => null)
        : null;
    const plan = await this.landscape
      .composeActionPlan(actor.tenantId, actor.userId, input.clientId, source, input.sourceRecordId, asOf)
      .catch(() => null);

    const visibleLandscape = landscape && !isDeniedPacket(landscape) ? landscape : null;

    const evidence: EvidenceRef[] = [];
    for (const item of visibleLandscape?.items ?? []) {
      // An item with no evidenceRef is not citable, so it is not offered as a
      // citation. Dropping it here rather than synthesizing a ref: a made-up
      // handle would resolve to nothing the moment a reviewer clicked it, and
      // the item still counted toward the packet's coverage upstream.
      if (!item.evidenceRef) continue;
      evidence.push({ ref: item.evidenceRef, label: item.label, basis: item.basis });
    }
    // The source record is always citable. Without it a grant assessment — for
    // which no landscape is ever composed — would have an empty evidence set
    // and every statement in it would be held, which reads as a broken model
    // rather than as a thin packet.
    evidence.push({
      ref: `${source}:${row.sourceRecordId}`,
      label: `${row.title}${row.agency ? ` (${row.agency})` : ''}`,
      basis: 'source_backed',
    });

    return {
      clientId: input.clientId,
      source,
      sourceRecordId: row.sourceRecordId,
      title: row.title,
      recommendation: row.recommendation?.machineRecommendation ?? null,
      recommendationReason: row.recommendation?.primaryReason ?? null,
      recommendationRisk: row.recommendation?.primaryRisk ?? null,
      recommendedNextAction: row.recommendation?.recommendedNextAction ?? null,
      fitBand: explained.fitBand,
      relevanceScore: row.relevanceScore,
      eligibility: row.eligibility,
      acquisitionPosition: row.acquisitionPosition?.state ?? null,
      landscapeFingerprint: visibleLandscape?.fingerprint ?? null,
      planStage: plan?.plan?.stage ?? null,
      planActions: (plan?.plan?.actions ?? []).map((a) => ({ title: a.title, intent: a.intent })),
      evidence,
      missingProfileFields: row.missingProfileFields.map((f) => f.label),
      // The notice's own synopsis is third-party text. Fenced even though it is
      // Capiro's own stored copy: the bytes came from an agency, and where they
      // are stored does not make them trusted.
      untrustedExcerpts:
        row.summary && !row.summaryIsLink
          ? [{ label: 'Source synopsis', quoted: quoteUntrusted('Source synopsis', row.summary) }]
          : [],
    };
  }

  // ── Context Packet v2 ─────────────────────────────────────────────────────

  private async compileContext(
    actor: AssessActor,
    input: AssessInput,
    asOf: Date,
  ): Promise<CompiledContextPacket | null> {
    if (!this.contextCompiler) return null;
    try {
      return await this.contextCompiler.compile({
        tenantId: actor.tenantId,
        userId: actor.userId,
        actorUserId: actor.userId,
        clientId: input.clientId,
        surface: 'tool-invoke',
        layers: ['client-steering', 'firm-playbook', 'user-voice'],
        ref: {
          conversationId: input.conversationId,
          opportunity: `${input.source}:${input.sourceRecordId}`,
        },
        // BEST-EFFORT, deliberately. `required` would make a context-store
        // outage fail an assessment whose deterministic half is already
        // complete and correct.
        persistence: 'best-effort',
        promptVersion: ASSESSMENT_PROMPT_VERSION,
        policyVersion: ASSESSMENT_POLICY_VERSION,
        traceId: `fo-assessment:${input.sourceRecordId}:${asOf.toISOString()}`,
      } as never);
    } catch (error) {
      this.logger.warn(
        `context packet compile failed for assessment; continuing without it: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  // ── The model ─────────────────────────────────────────────────────────────

  private async runModel(
    actor: AssessActor,
    packet: DeterministicPacket,
    compiled: CompiledContextPacket | null,
  ): Promise<{
    raw: ReturnType<typeof parseModelJson>;
    modelState: ModelState;
    explanation: string;
    model: string | null;
  }> {
    const model = this.modelName();
    if (!this.complete) {
      return {
        raw: null,
        modelState: 'unavailable',
        explanation:
          'No model transport is configured for this workspace, so only the deterministic assessment is shown. Nothing here is a finding about the opportunity.',
        model: null,
      };
    }
    try {
      const text = await this.complete(
        actor.tenantId,
        assessmentSystemPrompt(),
        this.userPrompt(packet, compiled),
      );
      const raw = parseModelJson(text);
      if (!raw) {
        return {
          raw: null,
          // `rejected`, not `unavailable`: the model answered and the answer was
          // unusable. A reviewer deciding whether to re-run needs those apart.
          modelState: 'rejected',
          explanation:
            'The model returned nothing Capiro could parse as a structured assessment, so its output was discarded. The deterministic assessment below is unaffected.',
          model,
        };
      }
      return {
        raw,
        modelState: 'applied',
        explanation:
          'Narrative sections are model analysis over the packet below. Statements that could not be tied to packet evidence are marked held.',
        model,
      };
    } catch (error) {
      this.logger.warn(
        `assessment model call failed for tenant ${actor.tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        raw: null,
        modelState: 'unavailable',
        explanation:
          'The model was unreachable, so only the deterministic assessment is shown. Nothing here is a finding about the opportunity.',
        model,
      };
    }
  }

  /** The packet, rendered for the model. Evidence refs are the citable set. */
  private userPrompt(packet: DeterministicPacket, compiled: CompiledContextPacket | null): string {
    const lines: string[] = [];
    if (compiled?.rendered?.length) {
      lines.push('## Steering context');
      for (const item of compiled.rendered) lines.push(item.body);
      lines.push('');
    }
    lines.push('## Opportunity (Capiro local record)');
    lines.push(JSON.stringify({ ...packet, untrustedExcerpts: undefined }, null, 2));
    lines.push('');
    lines.push('## Citable evidence refs');
    for (const e of packet.evidence) lines.push(`- ${e.ref} (${e.basis}) — ${e.label}`);
    if (packet.untrustedExcerpts.length) {
      lines.push('');
      lines.push('## Third-party text');
      for (const excerpt of packet.untrustedExcerpts) lines.push(excerpt.quoted);
    }
    return lines.join('\n');
  }

  private modelName(): string | null {
    try {
      return this.config.get('CLIO_RESEARCH_PLAN_MODEL', { infer: true }) ?? null;
    } catch {
      return null;
    }
  }

  // ── Persistence. Audit surfaces only. ─────────────────────────────────────

  /**
   * Write the artifact and return its version number.
   *
   * Versioning uses `clio_artifacts`' own parentArtifactId chain: a re-run for
   * the same client/opportunity/conversation points at the previous head, so
   * the prior assessment is preserved rather than overwritten. Fail-open — the
   * assessment is already computed and correct, and losing the audit copy must
   * not lose the answer.
   */
  private async persist(
    actor: AssessActor,
    input: AssessInput,
    assessment: MeriOpportunityAssessment,
    provenance: AssessmentProvenance,
  ): Promise<number> {
    try {
      return await this.prisma.withTenant(actor.tenantId, async (tx) => {
        const previous = await tx.clioArtifact.findFirst({
          where: {
            tenantId: actor.tenantId,
            conversationId: input.conversationId,
            kind: ARTIFACT_KIND,
            clientId: input.clientId,
            metadata: { path: ['sourceRecordId'], equals: input.sourceRecordId },
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true, metadata: true },
        });
        const version =
          typeof (previous?.metadata as { artifactVersion?: unknown } | null)?.artifactVersion ===
          'number'
            ? ((previous!.metadata as { artifactVersion: number }).artifactVersion ?? 0) + 1
            : 1;
        await tx.clioArtifact.create({
          data: {
            tenantId: actor.tenantId,
            userId: actor.userId,
            clientId: input.clientId,
            conversationId: input.conversationId,
            parentArtifactId: previous?.id ?? null,
            title: `Assessment — ${assessment.sourceRecordId}`,
            kind: ARTIFACT_KIND,
            contentType: 'application/json',
            bodyText: JSON.stringify(assessment),
            metadata: {
              ...provenance,
              artifactVersion: version,
              source: assessment.source,
              sourceRecordId: assessment.sourceRecordId,
              fingerprint: assessment.fingerprint,
              modelState: assessment.modelState,
            },
          },
        });
        return version;
      });
    } catch (error) {
      this.logger.warn(
        `assessment artifact persistence failed (non-blocking): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return provenance.artifactVersion;
    }
  }

  /**
   * Persist claim/evidence rows through the existing writer.
   *
   * `supported` is the SCHEMA's verdict, not the model's self-report — a model
   * asserting its own claim is supported is not evidence of anything, and
   * bindClaim already resolved every ref against the packet.
   */
  private async recordClaims(
    actor: AssessActor,
    packet: DeterministicPacket,
    assessment: MeriOpportunityAssessment,
  ): Promise<void> {
    if (!this.claimWriter || assessment.claims.length === 0) return;
    const numbering = new Map(packet.evidence.map((e, i) => [e.ref, i + 1]));
    await this.claimWriter.persistClaimsSafe(
      actor.tenantId,
      {
        subjectType: ARTIFACT_KIND,
        subjectId: `${assessment.source}:${assessment.sourceRecordId}`,
      },
      assessment.claims.map((c) => ({
        claim: c.text,
        supported: c.verdict === 'supported',
        sourceIds: c.refs.map((r) => numbering.get(r)).filter((n): n is number => typeof n === 'number'),
      })),
      packet.evidence.map((e, i) => ({
        n: i + 1,
        type: e.ref.split(':')[0] ?? 'evidence',
        id: e.ref,
        title: e.label,
      })),
    );
  }

  /**
   * One compliance row per assessment.
   *
   * `WARN` when anything was held or the packet was incomplete, `PASS`
   * otherwise. Not `BLOCK` in either case: nothing was attempted that could be
   * blocked — this is a read that produced analysis, and marking it BLOCK would
   * put a non-event in a log operators read for real refusals.
   */
  private async audit(
    actor: AssessActor,
    input: AssessInput,
    assessment: MeriOpportunityAssessment,
  ): Promise<void> {
    if (!this.auditor) return;
    const held = assessment.claims.filter((c) => c.verdict === 'held').length;
    await this.auditor.recordSafe(
      { tenantId: actor.tenantId, userId: actor.userId } as TenantContext,
      {
        trigger: ARTIFACT_KIND,
        decision: held > 0 || assessment.incomplete ? 'WARN' : 'PASS',
        reason:
          held > 0
            ? `${held} statement(s) held for review: not tied to packet evidence.`
            : assessment.incomplete
              ? assessment.incompleteReasons.join(' ')
              : 'Assessment produced with every statement tied to packet evidence.',
        ruleSource: ASSESSMENT_POLICY_VERSION,
        requiredApproval: false,
        entityType: 'funding_opportunity',
        entityId: `${input.source}:${input.sourceRecordId}`,
      },
    );
  }
}

/** Carry P37's refusal through unchanged — one wall, one wording. */
function refusalFrom(probe: MeriToolEnvelope<unknown>): AssessmentResult {
  const state = probe.state === 'available' ? 'invalid_request' : probe.state;
  return { state, explanation: probe.explanation };
}

/**
 * `compilerVersion` exists on the v2 packet only.
 *
 * Read defensively rather than narrowed on `version === 2`: a v1 packet is a
 * legitimate rollout state, and null here means "the compiler did not state
 * one", which is exactly what a provenance reader should see.
 */
function compilerVersionOf(compiled: CompiledContextPacket | null): string | null {
  const value = (compiled as { compilerVersion?: unknown } | null)?.compilerVersion;
  return typeof value === 'string' ? value : null;
}

function packetIdOf(compiled: CompiledContextPacket | null): string | null {
  if (!compiled) return null;
  const candidate = (compiled as { packetId?: unknown; generatedPacketId?: unknown }).packetId
    ?? (compiled as { generatedPacketId?: unknown }).generatedPacketId;
  return typeof candidate === 'string' ? candidate : null;
}
