/**
 * The governed Generation Gateway (Phase 1 §3.g1).
 *
 * ONE path for Engagement generation, in ONE fixed order:
 *
 *   authorize → pin provider/model → select policy → compile Evidence Packet
 *   → persist packet → build + validate Message Plan → draft → parse strictly
 *   → deterministic verifiers → Phase 0 audit on the exact output
 *   → persist immutable version → record usage → return a reviewable result
 *
 * The order is the control. Every step that could let ungrounded text reach a
 * recipient sits BEFORE the drafting call, and every step that could let
 * unverified text become sendable sits AFTER it. Previously these same concerns
 * existed but were interleaved through a 600-line method in EngagementService,
 * with enrichment failures silently nulled, the policy hardcoded to federal, and
 * no plan at all — so there was no single place to assert the ordering.
 *
 * Two hard rules hold throughout:
 *   - No external call happens inside a Prisma transaction.
 *   - Provider/model are chosen ONCE, recorded in the packet, and reused — a
 *     campaign never splits across two provider voices mid-flight.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { recordAiUsageEvent, type ProviderUsage, type TenantContext } from '@capiro/shared';
import type { LedgerEntry } from '@capiro/meriv2-core';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AppConfig } from '../../config/config.schema.js';
import { EngagementAiService } from '../engagement-ai.service.js';
import { LlmCompletionService } from '../llm-completion.service.js';
import { OutreachDraftService } from '../outreach-draft.service.js';
import { AttachmentScannerService } from '../attachment-scanner.service.js';
import { clientMemoryAllowed } from '../../memory/memory-wall.helpers.js';
import { engagementFirmMailContextEnabled } from '../../common/tenant-flags.js';
import type { ResolvedAiCredential } from '../ai-credential-resolver.service.js';
import {
  EvidencePacketService,
  EvidencePacketPersistError,
  type EnrichmentChannel,
} from './evidence-packet.service.js';
import {
  EMAIL_SCOPE_LABELS,
  MAX_USER_INSTRUCTION_CHARS,
  type AuthenticatedDirective,
  type EmailContextScope,
  type EvidencePacketV2,
  type SourceFailure,
} from './evidence-packet.types.js';
import {
  AudiencePolicyRequiredError,
  selectPolicy,
  type GaPolicy,
} from './government-affairs-policy.registry.js';
import { MessagePlanService } from './message-plan.service.js';
import { MessagePlanInvalidError, type MessagePlan } from './message-plan.schema.js';
import { GenerationVerifierService, type VerifierFinding } from './generation-verifier.service.js';
import { AuthorStyleProfileService } from './author-style-profile.service.js';
import { extractJsonObject } from './json-extract.js';
import {
  buildGatewayPrompt,
  GATEWAY_DRAFT_JSON_SCHEMA,
  GATEWAY_PROMPT_SPEC_VERSION,
} from './gateway-prompt.js';
import type {
  GenerationRequest,
  GenerationResult,
  GenerationSourceManifest,
  PinnedGenerationIdentity,
} from './generation-gateway.types.js';

/** Enrichment channels the caller wants folded into the packet. */
export interface GatewayEnrichmentInput {
  channels: EnrichmentChannel[];
  /** Rendered client brief (already pruned of ids/tenant fields). */
  clientBrief: string | null;
  clientName: string | null;
  /** Terms the email ranker matches on. */
  topicTerms: string[];
  /** Structured truth ledger entries for the Phase 0 auditor. */
  auditLedger: LedgerEntry[];
  /** Suggest relevant email in addition to explicitly selected threads. */
  includeRelevantEmail: boolean;
}

@Injectable()
export class GenerationGatewayService {
  private readonly logger = new Logger(GenerationGatewayService.name);
  readonly enabled: boolean;
  private readonly envEmailScope: EmailContextScope;

  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly ai: EngagementAiService,
    private readonly llm: LlmCompletionService,
    private readonly packets: EvidencePacketService,
    private readonly plans: MessagePlanService,
    private readonly verifier: GenerationVerifierService,
    private readonly styles: AuthorStyleProfileService,
    private readonly drafts: OutreachDraftService,
    private readonly scanner: AttachmentScannerService,
  ) {
    this.enabled = config.get('ENGAGEMENT_GENERATION_GATEWAY', { infer: true });
    this.envEmailScope = config.get('ENGAGEMENT_EMAIL_CONTEXT_SCOPE', { infer: true });
  }

  /**
   * Resolve the credential order and PIN one provider/model for a whole
   * operation or job (§3.g1 step 1, §3.k step 1).
   *
   * Called once by the caller (batch generator or job submit) and the result is
   * threaded into every generate() call, so no per-recipient fallback can change
   * the voice partway through a campaign.
   */
  async resolvePinnedIdentity(
    ctx: TenantContext,
    opts: { policy: GaPolicy },
  ): Promise<{ creds: ResolvedAiCredential[]; pinned: PinnedGenerationIdentity } | null> {
    const creds = await this.ai.resolveOutreachCredentials(ctx);
    const head = creds[0];
    if (!head) return null;
    return {
      creds,
      pinned: {
        provider: head.provider,
        model: head.model,
        planModel: this.plans.resolvePlanModel(head),
        promptSpecVersion: GATEWAY_PROMPT_SPEC_VERSION,
        policyId: opts.policy.policyId,
        policyVersion: opts.policy.version,
      },
    };
  }

  /**
   * Resolve the GA policy for a request. Throws AudiencePolicyRequiredError when
   * the audience is ambiguous — deliberately, rather than defaulting to federal
   * (§4.19).
   */
  resolvePolicy(request: GenerationRequest): GaPolicy {
    // Deliberately NOT read from request.pinned. Policy is a deterministic
    // function of (explicit choice, direction, template, server-resolved
    // recipient), so it is already stable across an async retry without pinning —
    // and pinning it would apply ONE recipient's audience rules to a batch whose
    // recipients differ (a state legislator drafted under congressional etiquette
    // is the precise failure §4.20 forbids). pinned.policyId is a RECORD of what
    // the job resolved, for audit, not an override.
    return selectPolicy({
      explicitAudience: request.explicitAudience ?? null,
      direction: request.direction ?? null,
      templateId: request.templateId,
      recipient: {
        sourceType: request.recipient.sourceType,
        emailDomain: emailDomain(request.recipient.email),
        chamber: request.recipient.chamber,
        defenseAcquisition: request.recipient.defenseAcquisition,
      },
    });
  }

  /**
   * Resolve the mailbox scope SERVER-SIDE (§3.d2).
   *
   * Requires the env value AND the tenant setting AND an ethical-wall pass. The
   * browser has no input here at all — there is no request field to widen.
   */
  async resolveEmailScope(
    ctx: TenantContext,
    clientId: string | null,
  ): Promise<{ scope: EmailContextScope; wallAllowsClient: boolean }> {
    const wallAllowsClient = clientId
      ? await this.prisma
          .withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
            clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId),
          )
          .catch(() => false)
      : true;

    if (this.envEmailScope !== 'firm_shared') return { scope: 'mine', wallAllowsClient };

    const tenant = await this.prisma
      .withTenant(ctx.tenantId, (tx) =>
        tx.tenant.findFirst({ where: { id: ctx.tenantId }, select: { settings: true } }),
      )
      .catch(() => null);
    // §4.11: env flag on but tenant setting off ⇒ scope stays 'mine'.
    const tenantAllows = engagementFirmMailContextEnabled(tenant?.settings);
    const scope: EmailContextScope =
      tenantAllows && wallAllowsClient ? 'firm_shared' : 'mine';
    return { scope, wallAllowsClient };
  }

  /**
   * Generate ONE unit (one recipient slot, or one shared group message).
   *
   * Never throws for an expected failure: a blocked policy, a critical source
   * failure, an invalid plan, or a provider outage all come back as a structured
   * GenerationResult the UI can render and the user can act on.
   */
  async generate(
    ctx: TenantContext,
    request: GenerationRequest,
    enrichment: GatewayEnrichmentInput,
    creds: ResolvedAiCredential[],
  ): Promise<GenerationResult> {
    const now = request.now ?? new Date();
    const recipient = request.recipient;

    // ── 2. Policy ──
    let policy: GaPolicy;
    try {
      policy = this.resolvePolicy(request);
    } catch (e) {
      if (e instanceof AudiencePolicyRequiredError) {
        return this.blocked(request, 'AUDIENCE_POLICY_REQUIRED', e.message, now, null);
      }
      throw e;
    }

    // ── 1. Pin identity (or reuse the job's) ──
    const head = creds[0];
    if (!head) {
      return this.blocked(
        request,
        'AI_NOT_CONFIGURED',
        'Drafting is not configured for this workspace.',
        now,
        policy,
      );
    }
    // The job's pinned PROVIDER/MODEL is authoritative (that is what must not
    // change mid-campaign); the policy fields are re-stamped from the policy this
    // unit actually resolved, so the manifest reports the truth.
    const pinned: PinnedGenerationIdentity = request.pinned
      ? { ...request.pinned, policyId: policy.policyId, policyVersion: policy.version }
      : {
          provider: head.provider,
          model: head.model,
          planModel: this.plans.resolvePlanModel(head),
          promptSpecVersion: GATEWAY_PROMPT_SPEC_VERSION,
          policyId: policy.policyId,
          policyVersion: policy.version,
        };
    // §e3: an async chunk's pinned prompt spec must match what THIS process's
    // prompt builder actually implements. A rolling deploy can have an old and
    // a new container claiming chunks of the SAME job; without this check the
    // new container would silently draft under its OWN prompt logic while the
    // persisted version/manifest still carried the stale promptSpecVersion it
    // was handed — the audit trail would misreport what was actually run.
    // Reject the chunk (no version is created) rather than draft on a
    // mismatched spec under a false label.
    if (request.pinned && request.pinned.promptSpecVersion !== GATEWAY_PROMPT_SPEC_VERSION) {
      return this.blocked(
        request,
        'PINNED_PROMPT_SPEC_MISMATCH',
        'This campaign was pinned to a different generation version than is currently running. Retry shortly, or start a new campaign.',
        now,
        policy,
      );
    }
    // §3.k3: a chunk whose pinned provider is unavailable FAILS rather than
    // silently falling back — a campaign must not switch voice midway.
    const pinnedCreds = creds.filter((c) => c.provider === pinned.provider);
    if (!pinnedCreds.length) {
      return this.blocked(
        request,
        'PINNED_PROVIDER_UNAVAILABLE',
        `This campaign is pinned to ${pinned.provider}, which is currently unavailable. Retry later or start a new campaign to switch providers.`,
        now,
        policy,
      );
    }

    const { scope: emailScope, wallAllowsClient } = await this.resolveEmailScope(
      ctx,
      request.clientId,
    );

    // ── 3/4. Compile + persist the Evidence Packet ──
    const directives = this.buildRequestDirectives(ctx, request, policy);
    let packet: EvidencePacketV2;
    try {
      packet = await this.packets.compileOutreachPacket(ctx, {
        surface: request.surface,
        clientId: request.clientId,
        ref: request.ref ?? {
          outreachRecordId: request.outreachRecordId ?? null,
          generationKey: recipient.generationKey,
        },
        items: request.items,
        policy,
        modelPolicy: {
          provider: pinned.provider,
          model: pinned.model,
          planModel: pinned.planModel,
          promptSpecVersion: pinned.promptSpecVersion,
          usedTenantKey: head.usedTenantKey,
        },
        emailScope,
        scanRequired: this.scanner.scanRequired,
        wallAllowsClient,
        audience: policy.jurisdiction === 'internal' ? 'internal' : 'external',
        recipientEmails: recipient.email ? [recipient.email.trim().toLowerCase()] : [],
        requestDirectives: directives,
        enrichments: enrichment.channels,
        includeRelevantEmail: enrichment.includeRelevantEmail,
        topicTerms: enrichment.topicTerms,
        // §4.7: under the gateway, a packet that cannot be persisted stops the
        // generation. There is no such thing as a sendable draft with no record
        // of what it was grounded in.
        failClosedOnPersist: this.enabled,
        now,
        ...(request.packetId ? { packetId: request.packetId } : {}),
        // Forwarded so EvidenceSourceService can rehydrate an 'intel' item from
        // intel-api under the caller's own identity. Spread (not passed as an
        // explicit undefined) so a caller with no header stays byte-identical.
        ...(request.authHeader ? { authHeader: request.authHeader } : {}),
        recipientIdentityResolved: Boolean(recipient.email || recipient.name),
      });
    } catch (e) {
      if (e instanceof EvidencePacketPersistError) {
        return this.blocked(
          request,
          e.code,
          'This draft could not be recorded, so it was not generated. Try again — no partial draft was kept.',
          now,
          policy,
        );
      }
      throw e;
    }

    const manifest = this.buildManifest(packet, policy, pinned);

    // ── 6a. Critical source failures stop here, BEFORE any spend ──
    if (packet.criticalFailureCount > 0) {
      return {
        outcome: 'blocked',
        generationKey: recipient.generationKey,
        recipientKey: recipient.recipientKey,
        subject: '',
        body: '',
        manifest,
        sendable: false,
        error: 'CRITICAL_SOURCE_FAILURE',
        pinned,
      };
    }

    // ── 5. Style profile (never raw examples) ──
    const styleProfile = await this.styles
      .getProfile(ctx, request.clientId, { creds: pinnedCreds, now })
      .catch(() => null);

    // ── 5. Message Plan + deterministic pre-draft validation ──
    let plan: MessagePlan;
    let planModelUsed = pinned.planModel ?? pinned.model;
    try {
      const built = await this.plans.buildPlan(ctx, {
        packet,
        policy,
        creds: pinnedCreds,
        recipientBrief: this.recipientBrief(request),
        audienceKind: request.audienceKind,
        ...(request.groupMemberCount != null
          ? { groupMemberCount: request.groupMemberCount }
          : {}),
        clientName: enrichment.clientName,
        tone: request.tone,
      });
      plan = built.plan;
      planModelUsed = built.planModel;
      // §3.g1 step 11: plan and draft usage are metered SEPARATELY, so the cost
      // of the planning pass is visible rather than folded into drafting.
      await this.recordUsage(ctx, 'outreach_message_plan', {
        provider: built.provider,
        model: built.planModel,
        usage: built.usage,
      });
    } catch (e) {
      if (e instanceof MessagePlanInvalidError) {
        // §4.22: an invalid plan means NO drafting call is made.
        return {
          outcome: 'blocked',
          generationKey: recipient.generationKey,
          recipientKey: recipient.recipientKey,
          subject: '',
          body: '',
          manifest,
          sendable: false,
          error: e.code,
          planIssues: e.issues,
          pinned,
        };
      }
      this.logger.warn(`message plan failed: ${(e as Error).message}`);
      return {
        outcome: 'error',
        generationKey: recipient.generationKey,
        recipientKey: recipient.recipientKey,
        subject: '',
        body: '',
        manifest,
        sendable: false,
        error: 'PLAN_GENERATION_FAILED',
        pinned,
      };
    }

    // ── 6. Draft through the pinned provider/model ──
    const prompt = buildGatewayPrompt({
      packet,
      policy,
      plan,
      styleProfile,
      styleProfileBlock: styleProfile ? this.styles.renderProfileBlock(styleProfile) : null,
      recipientBrief: this.recipientBrief(request),
      clientBrief: enrichment.clientBrief,
      audienceKind: request.audienceKind,
      ...(request.groupMemberCount != null ? { groupMemberCount: request.groupMemberCount } : {}),
      tone: request.tone,
      length: request.length ?? null,
      senderName: null,
      existingSubject: request.existingSubject ?? null,
      existingBody: request.existingBody ?? null,
      recipientScopeKeys: recipient.scopeKeys,
    });

    let subject: string;
    let body: string;
    let modelContextNote: string | undefined;
    try {
      const cred = pinnedCreds[0]!;
      const completion = await this.llm.complete({
        provider: cred.provider,
        apiKey: cred.apiKey,
        // The PINNED model, not cred.model — a job's chunk must use the identity
        // resolved at submit even if the resolver order has since changed.
        model: pinned.model,
        system: prompt.system,
        userStatic: prompt.userStatic,
        userVolatile: prompt.userVolatile,
        jsonSchema: GATEWAY_DRAFT_JSON_SCHEMA as unknown as Record<string, unknown>,
        jsonSchemaName: 'outreach_draft',
        cacheSystem: true,
        cacheUserStatic: true,
      });
      // ── 7. Strict output parse ──
      const parsed = parseDraft(completion.text);
      if (!parsed) {
        return {
          outcome: 'error',
          generationKey: recipient.generationKey,
          recipientKey: recipient.recipientKey,
          subject: '',
          body: '',
          manifest,
          sendable: false,
          error: 'DRAFT_OUTPUT_INVALID',
          pinned,
        };
      }
      subject = parsed.subject;
      body = parsed.body;
      modelContextNote = parsed.contextNote || undefined;
      await this.recordUsage(ctx, 'outreach_campaign', {
        provider: cred.provider,
        model: pinned.model,
        usage: completion.usage,
      });
    } catch (e) {
      // §4.24: the packet SURVIVES a provider failure. The generation is an
      // error, and no sendable output exists.
      this.logger.warn(`gateway draft failed: ${(e as Error).message}`);
      return {
        outcome: 'error',
        generationKey: recipient.generationKey,
        recipientKey: recipient.recipientKey,
        subject: '',
        body: '',
        manifest,
        sendable: false,
        error: 'GENERATION_FAILED',
        pinned,
      };
    }

    // ── 8. Deterministic verifiers ──
    const verdict = this.verifier.verify({
      subject,
      body,
      packet,
      policy,
      plan,
      audienceKind: request.audienceKind,
      now,
    });

    // ── 9/10. Phase 0 audit on the EXACT output + immutable version ──
    if (!request.outreachRecordId) {
      // No durable parent: return the reviewable result without a version. Only
      // reachable for non-outreach surfaces; outreach requires the record.
      return {
        outcome: verdict.held ? 'held' : 'ready',
        generationKey: recipient.generationKey,
        recipientKey: recipient.recipientKey,
        subject,
        body,
        ...(composeContextNote(modelContextNote, verdict) ?? {}),
        manifest,
        sendable: false,
        pinned,
      };
    }

    try {
      const version = await this.drafts.upsertGeneratedVersion(ctx, {
        outreachRecordId: request.outreachRecordId,
        generationKey: recipient.generationKey,
        recipientKey: recipient.recipientKey,
        audienceKind: request.audienceKind,
        recipientSnapshot: recipient.snapshot,
        subject,
        body,
        provider: pinned.provider,
        model: pinned.model,
        promptSpecVersion: pinned.promptSpecVersion,
        contextPacketId: packet.packetId,
        auditLedger: enrichment.auditLedger,
        verifierFindings: verdict.findings.map((f) => ({
          check: f.check,
          severity: f.blocking ? 'critical' : 'warning',
          blocking: f.blocking,
        })),
      });

      const note = composeContextNote(modelContextNote, verdict, version.contextNote);
      return {
        outcome: version.sendable ? 'ready' : 'held',
        generationKey: recipient.generationKey,
        recipientKey: recipient.recipientKey,
        subject,
        body,
        ...(note ?? {}),
        manifest,
        artifactId: version.artifactId,
        versionId: version.id,
        version: version.version,
        generationStatus: version.generationStatus,
        auditStatus: version.auditStatus,
        approvalStatus: version.approvalStatus,
        ...(version.reviewRequestId ? { reviewRequestId: version.reviewRequestId } : {}),
        sendable: version.sendable,
        pinned,
      };
    } catch (persistErr) {
      // Generation succeeded but the immutable version did not persist. The text
      // is deliberately dropped: returning it as ready would hand the caller
      // sendable content with no audited record (Phase 0's invariant).
      this.logger.error(
        `gateway draft version persistence FAILED for ${recipient.generationKey}: ${
          (persistErr as Error).message
        }`,
      );
      return {
        outcome: 'error',
        generationKey: recipient.generationKey,
        recipientKey: recipient.recipientKey,
        subject: '',
        body: '',
        manifest,
        sendable: false,
        error: 'DRAFT_PERSIST_FAILED',
        pinned,
      };
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * The authenticated directives derived from the REQUEST itself (objective,
   * template, tone, length, revision instruction).
   *
   * Every one is stamped with ctx.userId here. That is what makes them
   * authenticated: the id comes from the verified session, not from a field in
   * the request body.
   */
  private buildRequestDirectives(
    ctx: TenantContext,
    request: GenerationRequest,
    policy: GaPolicy,
  ): AuthenticatedDirective[] {
    const out: AuthenticatedDirective[] = [];
    const push = (
      kind: AuthenticatedDirective['kind'],
      text: string | null | undefined,
      id: string,
    ): void => {
      const t = (text ?? '').trim();
      if (!t) return;
      out.push({
        id,
        kind,
        text: t.length > MAX_USER_INSTRUCTION_CHARS * 4 ? t.slice(0, MAX_USER_INSTRUCTION_CHARS * 4) : t,
        scope: 'all',
        authenticatedUserId: ctx.userId,
      });
    };

    // In revision mode the freeform instruction IS the objective.
    if (request.existingBody?.trim() && request.reviseInstruction?.trim()) {
      push('objective', request.reviseInstruction, 'objective:revise');
    } else {
      push('objective', request.objective ?? request.templatePrompt, 'objective:template');
    }
    push('template', request.templateId, 'template:id');
    push('tone', `Write in a ${request.tone} register.`, 'tone');
    push('length', request.length ?? policy.defaultLength, 'length');
    return out;
  }

  private recipientBrief(request: GenerationRequest): string | null {
    const r = request.recipient;
    // A GROUP message gets no single-recipient identity: it would bias the draft
    // toward one member and invite per-member claims the group cannot support.
    if (request.audienceKind === 'group') return null;
    const lines = [
      r.name ? `Name: ${r.name}` : null,
      r.title ? `Title: ${r.title}` : null,
      r.office ? `Office: ${r.office}` : null,
      r.state ? `State/District: ${r.state}${r.district ? `-${r.district}` : ''}` : null,
      r.email ? `Email: ${r.email}` : null,
    ].filter((s): s is string => Boolean(s));
    return lines.length ? lines.join('\n') : null;
  }

  /** Build the Context-Used manifest (§3.j1). Summaries only, never bodies. */
  buildManifest(
    packet: EvidencePacketV2,
    policy: GaPolicy,
    pinned: PinnedGenerationIdentity,
  ): GenerationSourceManifest {
    const counts: Record<string, number> = {};
    for (const e of packet.evidence) {
      counts[e.ref.sourceType] = (counts[e.ref.sourceType] ?? 0) + 1;
    }
    const criticalFailures = packet.failures.filter((f) => f.severity === 'critical');
    return {
      contextPacketId: packet.packetId,
      packetHash: packet.packetHash,
      evidenceCountsByType: counts,
      included: packet.evidence.map((e) => ({
        sourceType: e.ref.sourceType,
        sourceId: e.ref.sourceId,
        title: e.ref.title,
        trust: e.ref.trust,
        asOf: e.ref.authoritativeAsOf ?? null,
        scope: e.scope,
        ...(typeof e.ref.provenance?.relevance === 'string'
          ? { relevance: e.ref.provenance.relevance as 'high' | 'medium' | 'low' }
          : {}),
        ...(e.relevanceReasons?.length ? { relevanceReasons: e.relevanceReasons } : {}),
        ...(e.ref.provenance?.truncated === true ? { truncated: true } : {}),
      })),
      exclusions: packet.standingMemoryExclusions.map((x) => ({
        sourceType: `standingMemory:${x.type}`,
        sourceId: x.id,
        reason: x.reason,
      })),
      failures: packet.failures,
      criticalFailures,
      oldestSourceAt: packet.stalestSourceAt,
      newestSourceAt: packet.freshestSourceAt,
      policy: {
        policyId: policy.policyId,
        version: policy.version,
        label: policy.label,
        jurisdiction: policy.jurisdiction,
        audienceType: policy.audienceType,
      },
      provider: pinned.provider,
      model: pinned.model,
      planModel: pinned.planModel,
      promptSpecVersion: pinned.promptSpecVersion,
      emailScopeLabel: EMAIL_SCOPE_LABELS[packet.emailScope],
      standingMemoryCount: packet.standingMemory.length,
      criticalMissingContext: criticalFailures.map((f) => f.userMessage),
      disclosures: packet.failures
        .filter((f) => f.code === 'ATTACHMENT_UNSCANNED' || f.code === 'DOCUMENT_TRUNCATED')
        .map((f) => f.userMessage),
    };
  }

  /** A blocked result with a minimal (possibly packet-less) manifest. */
  private blocked(
    request: GenerationRequest,
    code: string,
    message: string,
    now: Date,
    policy: GaPolicy | null,
  ): GenerationResult {
    const pinned: PinnedGenerationIdentity = request.pinned ?? {
      provider: '',
      model: '',
      planModel: null,
      promptSpecVersion: GATEWAY_PROMPT_SPEC_VERSION,
      policyId: policy?.policyId ?? '',
      policyVersion: policy?.version ?? '',
    };
    const failure: SourceFailure = {
      sourceType: 'generation',
      severity: 'critical',
      code,
      userMessage: message,
    };
    return {
      outcome: 'blocked',
      generationKey: request.recipient.generationKey,
      recipientKey: request.recipient.recipientKey,
      subject: '',
      body: '',
      manifest: {
        contextPacketId: '',
        packetHash: '',
        evidenceCountsByType: {},
        included: [],
        exclusions: [],
        failures: [failure],
        criticalFailures: [failure],
        oldestSourceAt: null,
        newestSourceAt: null,
        policy: {
          policyId: policy?.policyId ?? '',
          version: policy?.version ?? '',
          label: policy?.label ?? 'unresolved',
          jurisdiction: policy?.jurisdiction ?? '',
          audienceType: policy?.audienceType ?? '',
        },
        provider: pinned.provider || null,
        model: pinned.model || null,
        planModel: pinned.planModel,
        promptSpecVersion: pinned.promptSpecVersion,
        emailScopeLabel: EMAIL_SCOPE_LABELS.mine,
        standingMemoryCount: 0,
        criticalMissingContext: [message],
        disclosures: [],
      },
      sendable: false,
      error: code,
      pinned,
    };
  }

  /** Best-effort usage metering (recordAiUsageEvent swallows its own errors). */
  private recordUsage(
    ctx: TenantContext,
    workflow: string,
    generated: { provider: string; model: string; usage: ProviderUsage },
  ): Promise<void> {
    return recordAiUsageEvent(
      { prisma: this.prisma, logger: this.logger },
      { tenantId: ctx.tenantId, userId: ctx.userId },
      workflow,
      generated,
    );
  }
}

// ── Pure helpers ────────────────────────────────────────────────────────────

function emailDomain(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : null;
}

function parseDraft(text: string): { subject: string; body: string; contextNote: string } | null {
  try {
    const raw: unknown = JSON.parse(extractJsonObject(text) ?? text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    const subject = typeof o.subject === 'string' ? o.subject.trim() : '';
    const body = typeof o.body === 'string' ? o.body.trim() : '';
    if (!body) return null;
    return {
      subject,
      body,
      contextNote: typeof o.contextNote === 'string' ? o.contextNote.trim() : '',
    };
  } catch {
    return null;
  }
}

/**
 * The INTERNAL note the author sees. Verifier findings are named explicitly so
 * "held" is actionable rather than mysterious — and never appended to the
 * recipient-facing body.
 */
function composeContextNote(
  modelNote: string | undefined,
  verdict: { findings: VerifierFinding[]; held: boolean },
  versionNote?: string,
): { contextNote: string } | null {
  const parts: string[] = [];
  if (verdict.held) {
    const blocking = verdict.findings.filter((f) => f.blocking);
    parts.push(
      `⚠️ Held for review — ${blocking.length} verification finding(s): ${blocking
        .map((f) => f.message)
        .join(' ')}`,
    );
  } else if (verdict.findings.length) {
    parts.push(
      `Note — ${verdict.findings.length} non-blocking verification finding(s): ${verdict.findings
        .map((f) => f.message)
        .join(' ')}`,
    );
  }
  if (versionNote) parts.push(versionNote);
  if (modelNote) parts.push(modelNote);
  const joined = parts.join(' ').trim();
  return joined ? { contextNote: joined } : null;
}
