/**
 * The governed Generation Gateway (Phase 1 §3.g1).
 *
 * ONE path for Engagement generation, in ONE fixed order:
 *
 *   authorize → pin provider/model → compile Evidence Packet → persist packet
 *   → build + validate Message Plan → draft → parse strictly
 *   → deterministic verifiers → Phase 0 audit on the exact output
 *   → persist immutable version → record usage → return a reviewable result
 *
 * The order is the control. Every step that could let ungrounded text reach a
 * recipient sits BEFORE the drafting call, and every step that could let
 * unverified text become sendable sits AFTER it. Previously these same concerns
 * existed but were interleaved through a 600-line method in EngagementService,
 * with enrichment failures silently nulled, and no plan at all — so there was
 * no single place to assert the ordering.
 *
 * Two hard rules hold throughout:
 *   - No external call happens inside a Prisma transaction.
 *   - Provider/model are chosen ONCE, recorded in the packet, and reused — a
 *     campaign never splits across two provider voices mid-flight.
 */
import { ForbiddenException, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { recordAiUsageEvent, type ProviderUsage, type TenantContext } from '@capiro/shared';
import type { LedgerEntry } from '@capiro/meriv2-core';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AppConfig } from '../../config/config.schema.js';
import { EngagementAiService } from '../engagement-ai.service.js';
import {
  LlmCompletionService,
  LLM_LONG_GENERATION_TIMEOUT_MS,
} from '../llm-completion.service.js';
import { OutreachDraftService } from '../outreach-draft.service.js';
import { AttachmentScannerService } from '../attachment-scanner.service.js';
import { OutreachV3LivePreviewService } from './outreach-v3-live-preview.service.js';
import { extractStreamingJsonStringField } from './streaming-json-field.js';
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
import { MessagePlanService } from './message-plan.service.js';
import { MessagePlanInvalidError, type MessagePlan } from './message-plan.schema.js';
import { GenerationVerifierService, type VerifierFinding } from './generation-verifier.service.js';
import {
  assembleSkeletonBody,
  parseSkeletonDraft,
  skeletonDraftJsonSchema,
} from './content-skeleton.js';
import { AuthorStyleProfileService } from './author-style-profile.service.js';
import { extractJsonObject } from './json-extract.js';
import { applyDraftRevision, REVISION_JSON_SCHEMA } from './draft-revision.js';
import {
  buildGatewayPrompt,
  GATEWAY_DRAFT_JSON_SCHEMA,
  GATEWAY_PROMPT_SPEC_VERSION,
} from './gateway-prompt.js';
import { supportsReasoning, type ReasoningEffort } from './reasoning-effort.js';
import {
  OutreachContextPlaneService,
  projectUserVoice,
} from './outreach-context-plane.service.js';
import type {
  GenerationRequest,
  GenerationResult,
  GenerationSourceManifest,
  PinnedGenerationIdentity,
} from './generation-gateway.types.js';
import type { OutreachEvaluationRunner } from './outreach-evaluation.runner.js';

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
  private readonly v3GenerationEffort: ReasoningEffort;
  private readonly v3GenerationModel: string;
  private readonly streamingEnabled: boolean;

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
    private readonly contextPlane: OutreachContextPlaneService,
    // Phase 27F — optional so this file's own tests (which construct the
    // gateway directly, without a full Nest module) keep working unchanged.
    // When absent, generate()'s behavior and return value are byte-identical
    // to before this dependency existed.
    @Optional() private readonly evaluation?: OutreachEvaluationRunner,
    // Same reasoning as `evaluation` above — optional so existing tests that
    // construct the gateway directly are unaffected. When absent, or when
    // OUTREACH_V3_GENERATION_STREAMING_ENABLED is off (the default), the
    // draft call behaves byte-identically to before this dependency existed.
    @Optional() private readonly livePreview?: OutreachV3LivePreviewService,
  ) {
    this.enabled = config.get('ENGAGEMENT_GENERATION_GATEWAY', { infer: true });
    this.envEmailScope = config.get('ENGAGEMENT_EMAIL_CONTEXT_SCOPE', { infer: true });
    this.v3GenerationEffort = config.get('OUTREACH_V3_GENERATION_EFFORT', { infer: true });
    this.v3GenerationModel = config.get('OUTREACH_V3_GENERATION_MODEL', { infer: true });
    this.streamingEnabled = config.get('OUTREACH_V3_GENERATION_STREAMING_ENABLED', {
      infer: true,
    });
  }

  /**
   * The model V3 generation drafts on.
   *
   * A tenant's explicit BYOK modelOverride always wins — their choice governs, the
   * same precedence OUTREACH_DRAFT_MODEL respects. Otherwise
   * OUTREACH_V3_GENERATION_MODEL applies, and when that is unset (the default)
   * nothing changes: the resolved credential's model is used, so deploying this
   * code cannot move any tenant's drafting model or COGS on its own.
   */
  private resolveDraftModel(
    cred: ResolvedAiCredential,
    runtimeAction: GenerationRequest['runtimeAction'],
  ): string {
    if (runtimeAction !== 'outreach_v3_generate') return cred.model;
    if (cred.modelOverridden) return cred.model;
    return this.v3GenerationModel || cred.model;
  }

  /**
   * Reasoning depth for this operation, or null.
   *
   * Scoped to V3 generation on purpose: Classic outreach keeps its exact current
   * request shape. `supportsReasoning` is checked HERE as well as inside the
   * completion client so the pinned identity and the manifest record `null`
   * rather than an effort that was never actually sent — the audit trail should
   * say what ran, not what was configured.
   */
  private resolveReasoningEffort(
    provider: 'openai' | 'anthropic',
    model: string,
    runtimeAction: GenerationRequest['runtimeAction'],
  ): ReasoningEffort | null {
    if (runtimeAction !== 'outreach_v3_generate') return null;
    return supportsReasoning(provider, model) ? this.v3GenerationEffort : null;
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
    opts: {
      runtimeAction?: 'outreach_generate' | 'outreach_v3_generate';
    },
  ): Promise<{ creds: ResolvedAiCredential[]; pinned: PinnedGenerationIdentity } | null> {
    const creds =
      opts.runtimeAction === 'outreach_v3_generate'
        ? await this.ai.resolveOutreachV3Credentials(ctx)
        : await this.ai.resolveOutreachCredentials(ctx);
    const head = creds[0];
    if (!head) return null;
    const model = this.resolveDraftModel(head, opts.runtimeAction);
    return {
      creds,
      pinned: {
        provider: head.provider,
        model,
        planModel: this.plans.resolvePlanModel(head),
        reasoningEffort: this.resolveReasoningEffort(head.provider, model, opts.runtimeAction),
        promptSpecVersion: GATEWAY_PROMPT_SPEC_VERSION,
      },
    };
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
    const scope: EmailContextScope = tenantAllows && wallAllowsClient ? 'firm_shared' : 'mine';
    return { scope, wallAllowsClient };
  }

  /**
   * Phase 20: leftover Classic drafting paths that have not yet been rewritten
   * onto generate() still must obtain the shared governed packet before they
   * spend a model call. Authorization stays server-derived.
   */
  async resolveGovernedContext(
    ctx: TenantContext,
    input: {
      clientId: string | null;
      recipientName: string | null;
      recipientEmail: string | null;
      objective: string;
      outreachRecordId?: string | null;
    },
  ) {
    const { wallAllowsClient } = await this.resolveEmailScope(ctx, input.clientId);
    return this.contextPlane.resolve(ctx, { ...input, wallAllowsClient });
  }

  /**
   * Generate ONE unit (one recipient slot, or one shared group message).
   *
   * Never throws for an expected failure: a critical source failure, an
   * invalid plan, or a provider outage all come back as a structured
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

    // ── 1. Pin identity (or reuse the job's) ──
    const head = creds[0];
    if (!head) {
      return this.blocked(
        ctx,
        request,
        'AI_NOT_CONFIGURED',
        'Drafting is not configured for this workspace.',
        now,
      );
    }
    const pinned: PinnedGenerationIdentity = request.pinned
      ? { ...request.pinned }
      : (() => {
          const model = this.resolveDraftModel(head, request.runtimeAction);
          return {
            provider: head.provider,
            model,
            planModel: this.plans.resolvePlanModel(head),
            reasoningEffort: this.resolveReasoningEffort(
              head.provider,
              model,
              request.runtimeAction,
            ),
            promptSpecVersion: GATEWAY_PROMPT_SPEC_VERSION,
          };
        })();
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
        ctx,
        request,
        'PINNED_PROMPT_SPEC_MISMATCH',
        'This campaign was pinned to a different generation version than is currently running. Retry shortly, or start a new campaign.',
        now,
      );
    }
    // §3.k3: a chunk whose pinned provider is unavailable FAILS rather than
    // silently falling back — a campaign must not switch voice midway.
    const pinnedCreds = creds.filter((c) => c.provider === pinned.provider);
    if (!pinnedCreds.length) {
      return this.blocked(
        ctx,
        request,
        'PINNED_PROVIDER_UNAVAILABLE',
        `This campaign is pinned to ${pinned.provider}, which is currently unavailable. Retry later or start a new campaign to switch providers.`,
        now,
      );
    }

    const { scope: emailScope, wallAllowsClient } = await this.resolveEmailScope(
      ctx,
      request.clientId,
    );

    // ── 3. Shared Context Plane packet (Phase 20) ──
    // Classic, V3, batch, async, and revision all enter here. Authorization is
    // derived from server state; the browser cannot widen client/mailbox scope.
    let governed;
    try {
      governed = await this.contextPlane.resolve(ctx, {
        clientId: request.clientId,
        recipientName: recipient.name,
        recipientEmail: recipient.email,
        // Revision is additive: retrieval still needs the campaign's original
        // objective and main idea so all selected context remains applicable.
        objective: [request.mainIdea, request.objective ?? request.templatePrompt, request.reviseInstruction]
          .map((part) => part?.trim())
          .filter(Boolean)
          .join('\n'),
        outreachRecordId: request.outreachRecordId ?? null,
        wallAllowsClient,
      });
    } catch (e) {
      if (e instanceof ForbiddenException) {
        return this.blocked(
          ctx,
          request,
          'CONTEXT_PLANE_DENIED',
          'Governed context could not be authorized for this draft.',
          now,
        );
      }
      const message = (e as Error).message ?? '';
      if (message.startsWith('context_plane_phase20_operation_not_adopted')) {
        return this.blocked(
          ctx,
          request,
          'CONTEXT_PLANE_NOT_ADOPTED',
          'Outreach generation is not yet adopted onto the Context Plane.',
          now,
        );
      }
      throw e;
    }

    // ── 3/4. Compile + persist the Evidence Packet ──
    const directives = this.buildRequestDirectives(ctx, request);
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
        audience: request.direction === 'to-clients' ? 'internal' : 'external',
        recipientEmails: recipient.email ? [recipient.email.trim().toLowerCase()] : [],
        requestDirectives: directives,
        enrichments: enrichment.channels,
        includeRelevantEmail: enrichment.includeRelevantEmail,
        topicTerms: enrichment.topicTerms,
        // §4.7: under the gateway, a packet that cannot be persisted stops the
        // generation. There is no such thing as a sendable draft with no record
        // of what it was grounded in.
        // Phase 26: the gateway is the only generation path, so this is always on.
        failClosedOnPersist: true,
        now,
        ...(request.packetId ? { packetId: request.packetId } : {}),
        // Forwarded so EvidenceSourceService can rehydrate an 'intel' item from
        // intel-api under the caller's own identity. Spread (not passed as an
        // explicit undefined) so a caller with no header stays byte-identical.
        ...(request.authHeader ? { authHeader: request.authHeader } : {}),
        recipientIdentityResolved: Boolean(recipient.email || recipient.name),
        governedContext: governed,
      });
    } catch (e) {
      if (e instanceof EvidencePacketPersistError) {
        return this.blocked(
          ctx,
          request,
          e.code,
          'This draft could not be recorded, so it was not generated. Try again — no partial draft was kept.',
          now,
        );
      }
      throw e;
    }

    const styleSamples = request.styleSamples ?? [];
    const manifest = this.buildManifest(packet, pinned, styleSamples.length);

    // ── 6a. Critical source failures stop here, BEFORE any spend ──
    if (packet.criticalFailureCount > 0) {
      // EM-04: still seed an empty artifact so the user can hand-author recovery.
      return this.failedResult(ctx, request, {
        error: 'CRITICAL_SOURCE_FAILURE',
        manifest,
        pinned,
      });
    }

    // ── 5. Style profile (never raw examples) ──
    const styleProfile = await this.styles
      .getProfile(ctx, request.clientId, {
        creds: pinnedCreds,
        now,
        runtimeAction: request.runtimeAction,
        // Voice memory comes from the packet this gateway already resolved, so
        // the style profile no longer compiles a second one of its own.
        voiceMemory: projectUserVoice(governed.packet),
      })
      .catch(() => null);

    // ── 5. Message Plan + deterministic pre-draft validation ──
    let plan: MessagePlan;
    let planModelUsed = pinned.planModel ?? pinned.model;
    try {
      const built = await this.plans.buildPlan(ctx, {
        runtimeAction: request.runtimeAction,
        packet,
        creds: pinnedCreds,
        recipientBrief: this.recipientBrief(request),
        audienceKind: request.audienceKind,
        ...(request.groupMemberCount != null ? { groupMemberCount: request.groupMemberCount } : {}),
        clientName: enrichment.clientName,
        tone: request.tone,
        // Same recipient scoping the draft call uses below — see buildPlan's
        // own comment for why this matters for both caching and correctness.
        recipientScopeKeys: recipient.scopeKeys,
        existingSubject: request.existingSubject ?? null,
        existingBody: request.existingBody ?? null,
        reviseInstruction: request.reviseInstruction ?? null,
        // Same pinned depth as the draft: the plan fixes which claims the draft
        // may make, so a shallow plan caps a deep draft.
        ...(pinned.reasoningEffort ? { reasoningEffort: pinned.reasoningEffort } : {}),
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
        //
        // Log the validator codes. This used to return silently, which combined
        // with the worker dropping `planIssues` to make a 100%-failing campaign
        // completely undiagnosable from logs or DB (live 2026-08-24). Codes only —
        // messages/subjects can quote packet evidence, so they stay in the DB row.
        this.logger.warn(
          `message plan rejected for ${recipient.recipientKey}: ${e.issues
            .map((i) => i.code)
            .join(', ')}`,
        );
        return this.failedResult(ctx, request, {
          error: e.code,
          manifest,
          pinned,
          planIssues: e.issues,
        });
      }
      this.logger.warn(`message plan failed: ${(e as Error).message}`);
      return this.failedResult(ctx, request, {
        error: 'PLAN_GENERATION_FAILED',
        manifest,
        pinned,
      });
    }

    // ── 6. Draft through the pinned provider/model ──
    const prompt = buildGatewayPrompt({
      packet,
      plan,
      styleProfile,
      styleProfileBlock: styleProfile ? this.styles.renderProfileBlock(styleProfile) : null,
      styleSamples,
      recipientBrief: this.recipientBrief(request),
      clientBrief: enrichment.clientBrief,
      audienceKind: request.audienceKind,
      ...(request.groupMemberCount != null ? { groupMemberCount: request.groupMemberCount } : {}),
      tone: request.tone,
      length: request.length ?? null,
      senderName: null,
      existingSubject: request.existingSubject ?? null,
      existingBody: request.existingBody ?? null,
      reviseInstruction: request.reviseInstruction ?? null,
      recipientScopeKeys: recipient.scopeKeys,
      now,
      // Revision mode edits an existing whole body, so it must NOT run in
      // skeleton mode: the user is refining prose that already exists, and
      // re-deriving it from sections would silently discard their edits.
      contentSkeleton: request.existingBody?.trim() ? null : (request.contentSkeleton ?? null),
    });

    const skeleton = request.existingBody?.trim() ? null : (request.contentSkeleton ?? null);
    const isRevision = Boolean(request.existingBody?.trim());

    let subject: string;
    let body: string;
    let modelContextNote: string | undefined;
    try {
      const cred = pinnedCreds[0]!;
      const completionRequest = {
        runtimeAction: request.runtimeAction,
        provider: cred.provider,
        apiKey: cred.apiKey,
        // The PINNED model, not cred.model — a job's chunk must use the identity
        // resolved at submit even if the resolver order has since changed.
        model: pinned.model,
        system: prompt.system,
        userStatic: prompt.userStatic,
        userVolatile: prompt.userVolatile,
        jsonSchema: (isRevision
          ? REVISION_JSON_SCHEMA
          : skeleton ? skeletonDraftJsonSchema() : GATEWAY_DRAFT_JSON_SCHEMA) as unknown as Record<string, unknown>,
        jsonSchemaName: isRevision
          ? 'outreach_draft_revision'
          : skeleton ? 'outreach_draft_sections' : 'outreach_draft',
        cacheSystem: true,
        cacheUserStatic: true,
        // The draft call is the slowest in the path; the 90s LlmCompletionService
        // default aborted healthy gpt-5 max-effort generations outright.
        timeoutMs: LLM_LONG_GENERATION_TIMEOUT_MS,
        // The PINNED effort, for the same reason as the pinned model: every chunk
        // of one campaign must reason at the same depth.
        ...(pinned.reasoningEffort ? { reasoningEffort: pinned.reasoningEffort } : {}),
      };
      // Streaming only applies to the plain subject/body/contextNote shape —
      // sections and revision edits don't map onto a single 'body' field,
      // so those paths (and Anthropic, and streaming turned off) keep
      // the ordinary non-streaming call. Either way the FINAL result below is
      // identical; this only changes whether a live preview gets written.
      const canStream =
        this.streamingEnabled &&
        !skeleton &&
        !isRevision &&
        cred.provider === 'openai' &&
        Boolean(this.livePreview) &&
        Boolean(recipient.generationKey);
      const completion = canStream
        ? await this.llm.completeStreaming(completionRequest, (rawTextSoFar) => {
            const preview = extractStreamingJsonStringField(rawTextSoFar, 'body');
            if (preview) this.livePreview!.update(recipient.generationKey, preview);
          })
        : await this.llm.complete(completionRequest);
      // ── 7. Strict output parse (+ skeleton assembly) ──
      if (skeleton) {
        const parsedSections = parseSkeletonDraft(completion.text);
        if (!parsedSections) {
          return this.failedResult(ctx, request, {
            error: 'DRAFT_OUTPUT_INVALID',
            manifest,
            pinned,
          });
        }
        const assembled = assembleSkeletonBody(skeleton, parsedSections.sections);
        // A required section the model left empty means the assembled email
        // would have a visible hole in it. That is a failed generation, not a
        // formatting quirk — fail it here rather than letting a reviewer find a
        // half-written email that looks superficially structured and complete.
        if (assembled.missingRequiredSlots.length) {
          this.logger.warn(
            `skeleton draft missing required section(s): ${assembled.missingRequiredSlots.join(', ')}`,
          );
          return this.failedResult(ctx, request, {
            error: 'DRAFT_SECTIONS_INCOMPLETE',
            manifest,
            pinned,
          });
        }
        // The skeleton's own subject wins when it has one. An author who typed a
        // subject line meant it; only fall back to a model-written subject when
        // the skeleton left it blank.
        subject = assembled.subject || '';
        body = assembled.body;
        modelContextNote = parsedSections.contextNote || undefined;
        if (!subject) {
          this.logger.warn('skeleton produced an empty subject; falling back to the plan intent');
          subject = plan.intent;
        }
      } else {
        const parsed = isRevision
          ? applyDraftRevision(completion.text, {
              subject: request.existingSubject ?? '',
              body: request.existingBody ?? '',
            })
          : parseDraft(completion.text);
        if (!parsed) {
          return this.failedResult(ctx, request, {
            error: isRevision ? 'DRAFT_REVISION_INVALID' : 'DRAFT_OUTPUT_INVALID',
            manifest,
            pinned,
          });
        }
        subject = parsed.subject;
        body = parsed.body;
        modelContextNote = parsed.contextNote || undefined;
      }
      await this.recordUsage(ctx, 'outreach_campaign', {
        provider: cred.provider,
        model: pinned.model,
        usage: completion.usage,
      });
    } catch (e) {
      // §4.24: the packet SURVIVES a provider failure. The generation is an
      // error, and no sendable output exists.
      this.logger.warn(`gateway draft failed: ${(e as Error).message}`);
      return this.failedResult(ctx, request, {
        error: 'GENERATION_FAILED',
        manifest,
        pinned,
      });
    }

    // ── 8. Deterministic verifiers ──
    const verdict = this.verifier.verify({
      subject,
      body,
      packet,
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

      // Phase 27F — fire-and-forget shadow evaluation. Started here (not from
      // a later worker) because its inputs (governed context, packet, plan,
      // style profile) are ephemeral and must never be persisted; started
      // AFTER the treatment version is durably persisted, so a slow or
      // failing replay can never affect or delay the real response. Void +
      // .catch: a broken evaluation must never surface as a broken draft.
      void this.evaluation
        ?.considerAndRun(ctx, {
          request,
          enrichment,
          pinned,
          pinnedCreds,
          governed,
          packet,
          plan,
          styleProfile,
          styleSamples,
          recipientBrief: this.recipientBrief(request),
          requestDirectives: directives,
          wallAllowsClient,
          scanRequired: this.scanner.scanRequired,
          ...(request.authHeader ? { authHeader: request.authHeader } : {}),
          treatmentSubject: subject,
          treatmentBody: body,
          treatmentArtifactId: version.id,
          treatmentArtifactVersionSeq: version.version,
          contextPacketId: packet.packetId,
        })
        .catch(() => undefined);

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
      // EM-04: still seed an empty artifact so the user can recover by hand.
      return this.failedResult(ctx, request, {
        error: 'DRAFT_PERSIST_FAILED',
        manifest,
        pinned,
      });
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
  ): AuthenticatedDirective[] {
    const out: AuthenticatedDirective[] = [];
    const push = (
      kind: AuthenticatedDirective['kind'],
      text: string | null | undefined,
      id: string,
      scope: string = 'all',
    ): void => {
      const t = (text ?? '').trim();
      if (!t) return;
      out.push({
        id,
        kind,
        text:
          t.length > MAX_USER_INSTRUCTION_CHARS * 4
            ? t.slice(0, MAX_USER_INSTRUCTION_CHARS * 4)
            : t,
        scope,
        authenticatedUserId: ctx.userId,
      });
    };

    // The campaign idea and template objective remain in force in every mode.
    // Improve with Meri adds a revision instruction; it must not replace the
    // purpose or selected context of the original campaign.
    if (request.mainIdea?.trim()) {
      push('main_idea', request.mainIdea, 'objective:main-idea');
    }
    push('objective', request.objective ?? request.templatePrompt, 'objective:template');
    if (request.existingBody?.trim() && request.reviseInstruction?.trim()) {
      push('objective', request.reviseInstruction, 'objective:revise');
    }
    // OutreachRecipient.personalNote is an instruction for the matching
    // recipient, not metadata. Keep it through both fresh generation and
    // revision, scoped so it cannot leak into another recipient's message.
    push(
      'custom_note',
      request.audienceKind === 'group' ? undefined : request.recipient.personalNote,
      `recipient-note:${request.recipient.recipientKey}`,
      request.recipient.recipientKey,
    );
    push('template', request.templateId, 'template:id');
    if (!request.existingBody?.trim()) {
      push('tone', `Write in a ${request.tone} register.`, 'tone');
      push('length', request.length ?? 'standard', 'length');
    }
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
      // Staffer-shaped identity: a committee staffer or office staffer has no
      // bioguide-keyed enrichment (press/votes), so the committee they serve
      // is often the ONLY hook the planner gets. Members carry their
      // assignments here too — harmless duplication with the directory
      // profile channel, and the brief is the one input the plan pass always
      // has even when every enrichment channel came back empty.
      r.committees?.length ? `Committee(s): ${r.committees.slice(0, 6).join('; ')}` : null,
      r.email ? `Email: ${r.email}` : null,
    ].filter((s): s is string => Boolean(s));
    return lines.length ? lines.join('\n') : null;
  }

  /** Build the Context-Used manifest (§3.j1). Summaries only, never bodies. */
  buildManifest(
    packet: EvidencePacketV2,
    pinned: PinnedGenerationIdentity,
    styleSampleCount = 0,
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
      provider: pinned.provider,
      model: pinned.model,
      planModel: pinned.planModel,
      reasoningEffort: pinned.reasoningEffort ?? null,
      promptSpecVersion: pinned.promptSpecVersion,
      emailScopeLabel: EMAIL_SCOPE_LABELS[packet.emailScope],
      standingMemoryCount: packet.standingMemory.length,
      styleSampleCount,
      criticalMissingContext: criticalFailures.map((f) => f.userMessage),
      disclosures: packet.failures
        .filter((f) => f.code === 'ATTACHMENT_UNSCANNED' || f.code === 'DOCUMENT_TRUNCATED')
        .map((f) => f.userMessage),
    };
  }

  /** A blocked result with a minimal (possibly packet-less) manifest. */

  /**
   * EM-04 — when generation fails/blocks against a durable outreach record, still
   * ensure an empty artifact row exists so the user can hand-author a version.
   * Best-effort: a seed failure must never replace the structured error the UI
   * already has to show. Returns the artifact id (or undefined).
   */
  private async seedFailedSlotArtifact(
    ctx: TenantContext,
    request: GenerationRequest,
  ): Promise<string | undefined> {
    if (!request.outreachRecordId) return undefined;
    try {
      const artifact = await this.drafts.ensureArtifact(ctx, {
        outreachRecordId: request.outreachRecordId,
        generationKey: request.recipient.generationKey,
        recipientKey: request.recipient.recipientKey,
        audienceKind: request.audienceKind,
        recipientSnapshot: request.recipient.snapshot ?? {},
        subject: '',
        body: '',
      });
      return artifact.id;
    } catch (err) {
      this.logger.warn(
        `EM-04 failed-slot artifact seed failed for ${request.recipient.generationKey}: ${
          (err as Error).message
        }`,
      );
      return undefined;
    }
  }


  /** EM-04-aware structured error result. Seeds an empty artifact when possible. */
  private async failedResult(
    ctx: TenantContext,
    request: GenerationRequest,
    opts: {
      error: string;
      subject?: string;
      body?: string;
      manifest: GenerationSourceManifest;
      pinned: PinnedGenerationIdentity;
      planIssues?: GenerationResult['planIssues'];
    },
  ): Promise<GenerationResult> {
    const artifactId = await this.seedFailedSlotArtifact(ctx, request);
    return {
      outcome: 'error',
      generationKey: request.recipient.generationKey,
      recipientKey: request.recipient.recipientKey,
      subject: opts.subject ?? '',
      body: opts.body ?? '',
      manifest: opts.manifest,
      sendable: false,
      error: opts.error,
      pinned: opts.pinned,
      ...(opts.planIssues?.length ? { planIssues: opts.planIssues } : {}),
      ...(artifactId ? { artifactId } : {}),
    };
  }

  private async blocked(
    ctx: TenantContext,
    request: GenerationRequest,
    code: string,
    message: string,
    now: Date,
  ): Promise<GenerationResult> {
    const pinned: PinnedGenerationIdentity = request.pinned ?? {
      provider: '',
      model: '',
      planModel: null,
      reasoningEffort: null,
      promptSpecVersion: GATEWAY_PROMPT_SPEC_VERSION,
    };
    const failure: SourceFailure = {
      sourceType: 'generation',
      severity: 'critical',
      code,
      userMessage: message,
    };
    // EM-04: empty artifact so a failed/blocked slot can still be hand-authored.
    const artifactId = await this.seedFailedSlotArtifact(ctx, request);
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
        provider: pinned.provider || null,
        model: pinned.model || null,
        planModel: pinned.planModel,
        reasoningEffort: pinned.reasoningEffort ?? null,
        promptSpecVersion: pinned.promptSpecVersion,
        emailScopeLabel: EMAIL_SCOPE_LABELS.mine,
        standingMemoryCount: 0,
        styleSampleCount: 0,
        criticalMissingContext: [message],
        disclosures: [],
      },
      sendable: false,
      error: code,
      pinned,
      ...(artifactId ? { artifactId } : {}),
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

/**
 * Exported (Phase 27F) so `OutreachEvaluationRunner` can parse a shadow
 * control-arm completion with the SAME logic the real draft path uses,
 * instead of a second, drifting implementation.
 */
export function parseDraft(text: string): { subject: string; body: string; contextNote: string } | null {
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
