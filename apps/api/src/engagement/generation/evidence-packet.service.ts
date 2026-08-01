/**
 * Evidence Packet compilation and persistence (Phase 1 §3.c1).
 *
 * This is the orchestration boundary where "best effort" stops being invisible.
 *
 * The pre-Phase-1 batch generator wrapped roughly a dozen enrichment calls in
 * `.catch(() => null)`. Each individually looked prudent — a directory lookup
 * timing out should not fail a campaign. Collectively they meant a draft could be
 * generated with the recipient profile, tracked bills, watchlist, votes, hearings
 * and prior-outreach channels ALL silently absent, and neither the model nor the
 * lobbyist reviewing it had any way to know. The email still read as confident.
 *
 * So failures are still caught here — but they become SourceFailures, and the
 * critical ones stop the generation instead of thinning it.
 *
 * Packet persistence is likewise fail-CLOSED under the gateway flag. The old
 * Context Compiler trace is fail-open by contract (it is diagnostics), and that
 * contract is preserved for every other surface. For an outreach email that will
 * leave the building, the packet IS the provenance record — returning a sendable
 * draft with no durable record of what it was grounded in is precisely the hole.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ContextCompilerService } from '../../context/context-compiler.service.js';
import { EvidenceSourceService, type SelectedContextItemRef } from './evidence-source.service.js';
import {
  canonicalJson,
  compareEvidence,
  compareFailures,
  compareDirectives,
  sourceFailure,
  boundEvidenceText,
  type AuthenticatedDirective,
  type EmailContextScope,
  type EvidenceItem,
  type EvidencePacketV2,
  type GenerationSurface,
  type PacketModelPolicy,
  type SourceFailure,
  type StandingMemoryExclusion,
  type StandingMemoryRef,
} from './evidence-packet.types.js';
import type { GaPolicy } from './government-affairs-policy.registry.js';

/** An enrichment channel the packet folds in, resolved by the caller. */
export interface EnrichmentChannel {
  /** Stable source type recorded on the evidence ref. */
  sourceType: string;
  /** Human label for the manifest. */
  title: string;
  /** Trust class — enrichment is mostly server_record or external_untrusted. */
  trust: EvidenceItem['ref']['trust'];
  scope: 'all' | string;
  /** Resolver. Throwing here becomes a SourceFailure, never a silent null. */
  load: () => Promise<string | null>;
  /** Severity when `load` throws or the channel is unavailable. */
  failureSeverity?: SourceFailure['severity'];
  /** Machine code for the failure. */
  failureCode?: string;
  /** User-facing message when it fails. */
  failureMessage?: string;
  /** As-of date for freshness reporting, when the channel knows one. */
  authoritativeAsOf?: string | null;
}

export interface CompileOutreachPacketRequest {
  surface: GenerationSurface;
  clientId: string | null;
  /** Surface anchor persisted on the packet row. */
  ref: Record<string, string | null>;
  items: SelectedContextItemRef[];
  policy: GaPolicy;
  modelPolicy: PacketModelPolicy;
  emailScope: EmailContextScope;
  scanRequired: boolean;
  wallAllowsClient: boolean;
  audience: 'external' | 'internal';
  recipientEmails: string[];
  /** Directives assembled from the request (objective/template/tone/length). */
  requestDirectives: AuthenticatedDirective[];
  /** Enrichment channels to fold in. */
  enrichments: EnrichmentChannel[];
  /** Auto-suggested relevant email, when the surface wants it. */
  includeRelevantEmail?: boolean;
  /** Terms the email ranker matches on (bill ids, PE codes, issue terms). */
  topicTerms?: string[];
  /**
   * When true, a failed packet WRITE throws. Set from
   * ENGAGEMENT_GENERATION_GATEWAY: external generation must not proceed without
   * durable provenance.
   */
  failClosedOnPersist: boolean;
  /** Injected for deterministic hashes in tests. */
  now: Date;
  /** Injected for deterministic ids in tests. */
  packetId?: string;
  /** Set when recipient identity could not be resolved (delivery-critical). */
  recipientIdentityResolved?: boolean;
  /**
   * HP-05 (Gate L): the inbound request's own Authorization header, forwarded to
   * EvidenceSourceService so an 'intel' item can be rehydrated from intel-api's
   * packet endpoint under the caller's own identity. Not yet populated by
   * GenerationGatewayService's own callers (ENGAGEMENT_GENERATION_GATEWAY
   * defaults off) — accepted here so that wiring is a single additive change
   * when the gateway path is turned on.
   */
  authHeader?: string;
}

/** Thrown when the packet cannot be persisted and the gateway is fail-closed. */
export class EvidencePacketPersistError extends Error {
  readonly code = 'CONTEXT_PACKET_PERSIST_FAILED';
  constructor(cause: string) {
    super(`Evidence packet could not be persisted: ${cause}`);
    this.name = 'EvidencePacketPersistError';
  }
}

@Injectable()
export class EvidencePacketService {
  private readonly logger = new Logger(EvidencePacketService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly contextCompiler: ContextCompilerService,
    private readonly sources: EvidenceSourceService,
  ) {}

  async compileOutreachPacket(
    ctx: TenantContext,
    request: CompileOutreachPacketRequest,
  ): Promise<EvidencePacketV2> {
    const failures: SourceFailure[] = [];
    const evidence: EvidenceItem[] = [];
    const directives: AuthenticatedDirective[] = [...request.requestDirectives];

    // ---- 2. Resolve user-selected items SERVER-SIDE ----
    const resolved = await this.sources.resolveSelectedItems(ctx, {
      items: request.items,
      clientId: request.clientId,
      emailScope: request.emailScope,
      scanRequired: request.scanRequired,
      wallAllowsClient: request.wallAllowsClient,
      audience: request.audience,
      recipientEmails: request.recipientEmails,
      policy: request.policy,
      now: request.now,
      authHeader: request.authHeader,
    });
    evidence.push(...resolved.evidence);
    directives.push(...resolved.directives);
    failures.push(...resolved.failures);

    // ---- 3. Standing memory through the Context Compiler ----
    // NOT a direct memory_items query: the compiler owns the withTenantUser
    // tenancy discipline and the ethical-wall gate, and duplicating either is how
    // three production bugs happened before it existed.
    const standing = await this.loadStandingMemory(ctx, request.clientId);
    if (standing.failed) {
      failures.push(
        sourceFailure(
          'standingMemory',
          'STEERING_MEMORY_UNAVAILABLE',
          'informational',
          'Your saved voice and client steering memory could not be loaded, so the draft is written in the default register.',
        ),
      );
    }

    // ---- 4/5. Enrichment channels, each failing VISIBLY ----
    for (const channel of request.enrichments) {
      try {
        const text = await channel.load();
        if (text == null || !text.trim()) continue; // legitimately empty ≠ failure
        const bounded = boundEvidenceText(text);
        evidence.push({
          ref: {
            sourceType: channel.sourceType,
            sourceId: `${channel.sourceType}:${channel.scope}`,
            title: channel.title,
            clientId: request.clientId,
            recipientKeys: channel.scope === 'all' ? [] : [channel.scope],
            sourceCreatedAt: null,
            authoritativeAsOf: channel.authoritativeAsOf ?? null,
            retrievedAt: request.now.toISOString(),
            trust: channel.trust,
            provenance: { truncated: bounded.truncated },
          },
          evidenceText: bounded.text,
          scope: channel.scope,
        });
      } catch (e) {
        this.logger.warn(
          `enrichment channel ${channel.sourceType} failed: ${(e as Error).message}`,
        );
        failures.push(
          sourceFailure(
            channel.sourceType,
            channel.failureCode ?? 'ENRICHMENT_UNAVAILABLE',
            channel.failureSeverity ?? 'important',
            channel.failureMessage ??
              `${channel.title} could not be loaded, so the draft is not informed by it.`,
          ),
        );
      }
    }

    // ---- Auto-suggested relevant email ----
    if (request.includeRelevantEmail) {
      const suggested = await this.sources.resolveRelevantEmail(ctx, {
        clientId: request.clientId,
        recipientEmails: request.recipientEmails,
        topicTerms: request.topicTerms ?? [],
        emailScope: request.emailScope,
        wallAllowsClient: request.wallAllowsClient,
        audience: request.audience,
        scope: 'all',
        policy: request.policy,
        now: request.now,
        excludeThreadIds: request.items
          .filter((i) => i.kind === 'email')
          .map((i) => i.id.replace(/^mail-/, '')),
      });
      evidence.push(...suggested.evidence);
      failures.push(...suggested.failures);
    }

    // ---- 6. Delivery-critical: recipient identity ----
    if (request.recipientIdentityResolved === false) {
      failures.push(
        sourceFailure(
          'recipient',
          'RECIPIENT_IDENTITY_UNRESOLVED',
          'critical',
          'The recipient for this message could not be identified, so it cannot be drafted or delivered.',
        ),
      );
    }

    // ---- 7/8. Canonical ordering, then hash ----
    evidence.sort(compareEvidence);
    directives.sort(compareDirectives);
    failures.sort(compareFailures);

    const freshness = freshnessWindow(evidence);
    const criticalFailureCount = failures.filter((f) => f.severity === 'critical').length;
    const packetId = request.packetId ?? randomUUID();

    const packet: EvidencePacketV2 = {
      packetId,
      packetVersion: 2,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      clientId: request.clientId,
      surface: request.surface,
      ref: request.ref,
      directives,
      evidence,
      standingMemory: standing.items,
      standingMemoryExclusions: standing.exclusions,
      failures,
      policy: {
        jurisdiction: request.policy.jurisdiction,
        audienceType: request.policy.audienceType,
        policyId: request.policy.policyId,
        version: request.policy.version,
      },
      modelPolicy: request.modelPolicy,
      criticalFailureCount,
      freshestSourceAt: freshness.freshest,
      stalestSourceAt: freshness.stalest,
      compiledAt: request.now.toISOString(),
      // Hash covers content, not identity: packetId and compiledAt are excluded
      // so two identical requests hash identically (§5.7.4). Including either
      // would make every packet unique and the hash meaningless as an identity.
      packetHash: '',
      emailScope: request.emailScope,
    };
    packet.packetHash = hashPacket(packet);

    // ---- 9. Persist (fail-closed under the gateway flag) ----
    await this.persist(packet, request.failClosedOnPersist);
    return packet;
  }

  /**
   * Persist the packet to `context_packet` as packet_version=2.
   *
   * NOTE: writes SYNCHRONOUSLY, unlike ContextCompilerService.persistPacket which
   * is fire-and-forget by design. The compiler's trace remains fire-and-forget for
   * every non-Engagement surface (§3.c1 step 10) — this method does not change it.
   */
  private async persist(packet: EvidencePacketV2, failClosed: boolean): Promise<void> {
    try {
      await this.prisma.withTenant(packet.tenantId, (tx) =>
        tx.contextPacket.create({
          data: {
            id: packet.packetId,
            tenantId: packet.tenantId,
            // NOT NULL with no DB default once
            // 20260729010000_memory_governance_context_v2 is applied. This write
            // is fail-CLOSED under ENGAGEMENT_GENERATION_GATEWAY, so omitting it
            // would turn every gated generation into a hard 500.
            effectiveTenantId: packet.tenantId,
            // The COLUMN keeps the canonical ContextSurface vocabulary
            // ('outreach' | 'memo' | …) that every existing provenance reader
            // filters on; writing 'outreach_email' here would make these packets
            // invisible to a query for surface='outreach'. The precise generation
            // surface is preserved in policy_jsonb below.
            surface: contextSurfaceFor(packet.surface),
            userId: packet.userId,
            clientId: packet.clientId,
            ref: packet.ref as unknown as Prisma.InputJsonValue,
            // The v1 steering trace columns stay populated so the existing
            // provenance readers keep working unchanged.
            items: packet.standingMemory as unknown as Prisma.InputJsonValue,
            exclusions: packet.standingMemoryExclusions as unknown as Prisma.InputJsonValue,
            itemCount: packet.standingMemory.length,
            exclusionCount: packet.standingMemoryExclusions.length,
            blockChars: packet.evidence.reduce((n, e) => n + e.evidenceText.length, 0),
            // v2 fields.
            packetVersion: 2,
            directives: packet.directives as unknown as Prisma.InputJsonValue,
            evidence: packet.evidence as unknown as Prisma.InputJsonValue,
            sourceFailures: packet.failures as unknown as Prisma.InputJsonValue,
            policy: {
              ...packet.policy,
              emailScope: packet.emailScope,
              // The precise generation surface, kept here because the column
              // holds the coarser canonical ContextSurface.
              generationSurface: packet.surface,
            } as unknown as Prisma.InputJsonValue,
            modelPolicy: packet.modelPolicy as unknown as Prisma.InputJsonValue,
            packetHash: packet.packetHash,
            criticalFailureCount: packet.criticalFailureCount,
            freshestSourceAt: packet.freshestSourceAt ? new Date(packet.freshestSourceAt) : null,
            stalestSourceAt: packet.stalestSourceAt ? new Date(packet.stalestSourceAt) : null,
          },
        }),
      );
    } catch (e) {
      const message = (e as Error).message;
      if (failClosed) {
        // §4.7: no transient draft is returned as ready when its provenance
        // could not be recorded.
        this.logger.error(`evidence packet persistence FAILED (fail-closed): ${message}`);
        throw new EvidencePacketPersistError(message);
      }
      this.logger.warn(`evidence packet persistence failed (flag off, continuing): ${message}`);
    }
  }

  /** Compile standing memory, reporting failure rather than swallowing it. */
  private async loadStandingMemory(
    ctx: TenantContext,
    clientId: string | null,
  ): Promise<{ items: StandingMemoryRef[]; exclusions: StandingMemoryExclusion[]; failed: boolean }> {
    try {
      const compiled = await this.contextCompiler.compile({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        clientId,
        surface: 'outreach',
        layers: ['user-voice', 'firm-identity', 'client-steering', 'client-people'],
      });
      return {
        items: compiled.items.map((i) => ({
          layer: String(i.layer),
          id: String(i.id),
          type: String(i.type),
          slug: String(i.slug),
          chars: Number(i.chars ?? 0),
        })),
        exclusions: compiled.exclusions.map((x) => ({
          layer: String(x.layer),
          id: String(x.id),
          type: String(x.type),
          slug: String(x.slug),
          reason: String(x.reason),
        })),
        failed: false,
      };
    } catch (e) {
      this.logger.warn(`standing-memory compile failed: ${(e as Error).message}`);
      return { items: [], exclusions: [], failed: true };
    }
  }
}

/**
 * Map a generation surface onto the canonical `ContextSurface` value stored in
 * `context_packet.surface`.
 *
 * The column has a documented, fixed vocabulary that existing provenance readers
 * filter on. Every Engagement generation surface is an 'outreach'-family packet
 * from that vocabulary's point of view, so they collapse to 'outreach' and the
 * finer distinction lives in policy_jsonb.generationSurface.
 */
export function contextSurfaceFor(surface: GenerationSurface): string {
  switch (surface) {
    case 'outreach_email':
    case 'meeting_prep':
    case 'meeting_debrief':
    case 'talking_points':
      return 'outreach';
    default:
      return 'outreach';
  }
}

/**
 * sha256 over the canonical packet CONTENT.
 *
 * Excludes packetId, compiledAt, packetHash itself, and every ref's retrievedAt:
 * those are all per-invocation identity/time values. Including them would make
 * the hash change on every call, which would break the determinism assertion and
 * make the hash useless for detecting that two generations used the same context.
 */
export function hashPacket(packet: EvidencePacketV2): string {
  const hashable = {
    tenantId: packet.tenantId,
    userId: packet.userId,
    clientId: packet.clientId,
    surface: packet.surface,
    ref: packet.ref,
    emailScope: packet.emailScope,
    policy: packet.policy,
    modelPolicy: packet.modelPolicy,
    directives: packet.directives,
    evidence: packet.evidence.map((e) => ({
      ...e,
      ref: { ...e.ref, retrievedAt: undefined },
    })),
    standingMemory: packet.standingMemory,
    standingMemoryExclusions: packet.standingMemoryExclusions,
    failures: packet.failures,
  };
  return createHash('sha256').update(canonicalJson(hashable)).digest('hex');
}

/** Oldest/newest as-of dates across included evidence. */
function freshnessWindow(evidence: EvidenceItem[]): { freshest: string | null; stalest: string | null } {
  let freshest: number | null = null;
  let stalest: number | null = null;
  for (const e of evidence) {
    const raw = e.ref.authoritativeAsOf ?? e.ref.sourceCreatedAt;
    if (!raw) continue;
    const ms = new Date(raw).getTime();
    if (Number.isNaN(ms)) continue;
    if (freshest == null || ms > freshest) freshest = ms;
    if (stalest == null || ms < stalest) stalest = ms;
  }
  return {
    freshest: freshest == null ? null : new Date(freshest).toISOString(),
    stalest: stalest == null ? null : new Date(stalest).toISOString(),
  };
}
