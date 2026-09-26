import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ROLE_RANK, type TenantContext } from '@capiro/shared';
import { fingerprintMeriFinalToolSchemas } from '@capiro/meriv2-core';
import { meriV3ChatActive } from '../common/meriv3-flags.js';
import { tenantFeatureEnabled } from '../common/tenant-flags.js';
import { clientMemoryAllowed, fetchDeniedClientIds, visibleClientWhere } from '../memory/memory-wall.helpers.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriFeatureFlagsService } from './meri-feature-flags.service.js';
import { assertVisualAnalysisConversationAccess } from './meri-visual-artifact-access.js';
import { MeriAnalysisSandboxReadinessObserver } from './meri-analysis-sandbox-readiness-observer.service.js';
import {
  MERI_OFFERED_TOOL_DIAGNOSTIC_CATALOG_SHA256,
  MERI_TOOL_AVAILABILITY_PROOF_CATALOG_SHA256,
  MERI_TOOL_AVAILABILITY_PROOF_CATALOG,
  MERI_FINAL_SCHEMA_VERSION,
  MERI_OFFERED_TOOL_DIAGNOSTIC_VERSION,
  MERI_TOOL_AVAILABILITY_PROOF_VERSION,
  isMeriFinalProviderTools,
  type MeriToolAvailabilityProof,
  type MeriToolAvailabilityProofTool,
  type MeriPermissionDiagnosticTool,
  type MeriToolAvailabilityStatus,
  type MeriToolAvailabilityTurnBinding,
  type MeriToolPermissionReason,
  type MeriFinalProviderToolSchema,
} from './meri-tool-availability-proof.contract.js';

type ClientCheck = {
  status: MeriToolAvailabilityStatus;
  reason: MeriToolPermissionReason;
};

export type MeriToolAvailabilityTurnBindingInput = Pick<
  MeriToolAvailabilityTurnBinding,
  'nonce' | 'surface' | 'finalSchemaVersion'
> & { finalOfferedTools: readonly MeriFinalProviderToolSchema[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read-only proof for a fixed, server-owned tool set. It intentionally does not
 * execute tools and is not wired into JEV, model routing, or tool availability.
 * The client id is loaded only from a persisted conversation owned by the
 * authenticated tenant/user. The API hashes the exact final provider-facing
 * schema list supplied by the authenticated internal orchestrator, but that
 * list never expands the fixed server-owned permission-check catalog.
 */
@Injectable()
export class MeriToolAvailabilityProofService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: MeriFeatureFlagsService,
    @Optional() private readonly readiness?: MeriAnalysisSandboxReadinessObserver,
  ) {}

  async prove(
    ctx: TenantContext,
    conversationId: string,
    turn: MeriToolAvailabilityTurnBindingInput,
  ): Promise<MeriToolAvailabilityProof> {
    if (
      !UUID_RE.test(conversationId) ||
      !turn ||
      typeof turn !== 'object' ||
      typeof turn.nonce !== 'string' ||
      !UUID_RE.test(turn.nonce) ||
      (turn.surface !== 'chat' && turn.surface !== 'research') ||
      turn.finalSchemaVersion !== MERI_FINAL_SCHEMA_VERSION ||
      !isMeriFinalProviderTools(turn.finalOfferedTools)
    ) {
      throw new BadRequestException('Invalid turn-binding contract');
    }
    let finalSchemaFingerprint: string;
    try {
      finalSchemaFingerprint = fingerprintMeriFinalToolSchemas(
        turn.finalOfferedTools,
        turn.finalSchemaVersion,
      );
    } catch {
      throw new BadRequestException('Invalid or oversized final offered tool schemas');
    }
    const offeredNames = new Set(turn.finalOfferedTools.map((tool) => tool.name));
    const base = {
      version: MERI_TOOL_AVAILABILITY_PROOF_VERSION,
      catalogSha256: MERI_TOOL_AVAILABILITY_PROOF_CATALOG_SHA256,
      semantics: 'permission_only' as const,
      runtimeAvailability: 'unresolved' as const,
      eligibility: 'unresolved' as const,
      unresolvedChecks: Object.freeze(['runtime-availability'] as const),
      conversationId,
    };
    const result = (
      clientScope: MeriToolAvailabilityProof['clientScope'],
      clientId: string | null,
      checks: readonly { tool: MeriPermissionDiagnosticTool; check: ClientCheck }[],
      persistedConversation: boolean,
    ): MeriToolAvailabilityProof => {
      const checkTime = new Date().toISOString();
      const scope = Object.freeze({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        conversationId,
        clientId,
        surface: turn.surface,
        source: persistedConversation
          ? 'authenticated_context_and_persisted_conversation' as const
          : 'authenticated_context_only' as const,
      });
      const turnBinding = Object.freeze({
        nonce: turn.nonce,
        nonceProvenance: 'authenticated_internal_service_assertion' as const,
        surface: turn.surface,
        surfaceProvenance: 'authenticated_internal_service_assertion' as const,
        finalSchemaVersion: turn.finalSchemaVersion,
        finalSchemaFingerprint,
        schemaFingerprintProvenance: 'api_recomputed_from_exact_provider_schemas' as const,
        checkTime,
        integrity: 'api_recomputed_schema_fingerprint' as const,
      });
      const checked = new Map<MeriPermissionDiagnosticTool, ClientCheck>(
        checks.map(({ tool, check }) => [tool, check] as const),
      );
      if (offeredNames.has('run_analysis') && checked.get('run_analysis')?.status === 'eligible') {
        // Demand mark only; the sampler schedules network I/O after this proof
        // exchange. No readiness result enters the v3/v2 proof payload.
        try {
          this.readiness?.noteRunAnalysisOffered();
        } catch {
          // Diagnostic scheduling cannot alter the permission proof or turn.
        }
      }
      const unknownCheck: ClientCheck = { status: 'unknown', reason: 'not_offered' };
      return Object.freeze({
        ...base,
        scope,
        turnBinding,
        clientScope,
        tools: Object.freeze(MERI_TOOL_AVAILABILITY_PROOF_CATALOG.map(({ tool }) =>
          Object.freeze(this.entry(tool, checked.get(tool) ?? unknownCheck)),
        )) as unknown as MeriToolAvailabilityProof['tools'],
        offeredDiagnostic: Object.freeze({
          version: MERI_OFFERED_TOOL_DIAGNOSTIC_VERSION,
          catalogSha256: MERI_OFFERED_TOOL_DIAGNOSTIC_CATALOG_SHA256,
          tools: Object.freeze(turn.finalOfferedTools.map(({ name }) => {
            const check = checked.get(name as MeriPermissionDiagnosticTool);
            return Object.freeze({
              tool: name,
              permissionStatus: check?.status ?? 'unknown',
              permissionReason: check?.reason ?? 'permission_semantics_unresolved',
              runtimeAvailability: 'unresolved' as const,
              eligibility: 'unresolved' as const,
              executable: false as const,
            });
          })),
        }),
      });
    };

    const roleRank = ROLE_RANK[ctx.role];
    if (typeof roleRank !== 'number' || roleRank < ROLE_RANK.standard_user) {
      return result('unavailable', null, this.allChecks(offeredNames, 'denied', 'caller_role_insufficient'), false);
    }

    let conversation: { clientId: string | null; status: string } | null;
    try {
      if (!ctx.tenantId || !ctx.userId) throw new Error('authenticated tenant/user context unavailable');
      conversation = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
        tx.clioConversation.findFirst({
          where: {
            id: conversationId,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            archivedAt: null,
          },
          select: { clientId: true, status: true },
        }),
      );
    } catch {
      return result('unavailable', null, this.allChecks(offeredNames, 'unknown', 'check_failed'), false);
    }
    if (!conversation) return result('unavailable', null, this.allChecks(offeredNames, 'denied', 'conversation_unavailable'), false);
    // The fixed three-tool proof conservatively requires an active conversation.
    // V3 analysis execution only requires an unarchived owned conversation, so
    // keep the two permission policies separate on a non-active row.
    const catalogConversationActive = conversation.status === 'active';
    if (!conversation.clientId) {
      const checks = catalogConversationActive
        ? this.allChecks(offeredNames, 'unknown', 'needs_input', false)
        : this.allChecks(offeredNames, 'denied', 'conversation_unavailable', false);
      if (offeredNames.has('run_analysis')) {
        checks.push({
          tool: 'run_analysis',
          check: await this.checkAnalysis(ctx, conversationId, null),
        });
      }
      return result('needs_input', null, checks, true);
    }

    const clientId = conversation.clientId;
    const checks: { tool: MeriPermissionDiagnosticTool; check: ClientCheck }[] = catalogConversationActive
      ? await Promise.all(MERI_TOOL_AVAILABILITY_PROOF_CATALOG
      .filter(({ tool }) => offeredNames.has(tool))
      .map(async ({ tool }) => ({
        tool,
        check: tool === 'get_client_context'
          ? await this.checkClientContext(ctx, clientId)
          : tool === 'search_client_knowledge'
            ? await this.checkClientKnowledge(ctx, clientId)
            : await this.checkRepresentation(ctx, clientId),
      })))
      : this.allChecks(offeredNames, 'denied', 'conversation_unavailable', false);

    if (offeredNames.has('run_analysis')) {
      checks.push({
        tool: 'run_analysis',
        check: await this.checkAnalysis(ctx, conversationId, clientId),
      });
    }

    return result('present', clientId, checks, true);
  }

  private async checkAnalysis(
    ctx: TenantContext,
    conversationId: string,
    clientId: string | null,
  ): Promise<ClientCheck> {
    try {
      // Read current server-owned tenant policy directly. The cached feature
      // service can default true after a DB error; a proof must not do that.
      const tenant = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
        tx.tenant.findFirst({
          where: { id: ctx.tenantId },
          select: { slug: true, settings: true },
        }),
      );
      if (!tenant) return { status: 'unknown', reason: 'check_failed' };
      if (!meriV3ChatActive(tenant.settings, tenant.slug)) {
        return { status: 'denied', reason: 'v3_disabled' };
      }
      if (!tenantFeatureEnabled(tenant.settings, 'runAnalysis', true)) {
        return { status: 'denied', reason: 'tenant_feature_disabled' };
      }
      // Invocation consults the cached feature service. Confirm both the
      // current DB policy and its effective gate; this cannot turn a failed
      // direct read into a default-true permission result.
      if (!(await this.flags.isMeriV3ChatEnabled(ctx.tenantId, ctx.tenantSlug))) {
        return { status: 'denied', reason: 'v3_disabled' };
      }
      if (!(await this.flags.isEnabled(ctx.tenantId, 'runAnalysis', true))) {
        return { status: 'denied', reason: 'tenant_feature_disabled' };
      }
      // This is the same locked conversation/client-wall predicate used by the
      // V3 visual-analysis bridge. A clientless conversation is intentionally
      // allowed; it does not inherit the three client-tool needs_input state.
      await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
        assertVisualAnalysisConversationAccess(tx, ctx, conversationId, clientId),
      );
      return { status: 'eligible', reason: 'authorized' };
    } catch (error) {
      return error instanceof NotFoundException
        ? { status: 'denied', reason: 'analysis_scope_unavailable' }
        : { status: 'unknown', reason: 'check_failed' };
    }
  }

  private async checkClientContext(ctx: TenantContext, clientId: string): Promise<ClientCheck> {
    try {
      // Mirrors getClientContext(): ensureClientVisible(ctx, id) requires a
      // same-tenant, non-archived client, then fetchDeniedClientIds() rejects
      // an ethical-wall denial under withTenantUser.
      const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.client.findFirst({
          where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
          select: { id: true },
        }),
      );
      if (!client) return { status: 'denied', reason: 'client_not_visible' };
      const denied = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
        fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId),
      );
      return denied.includes(clientId)
        ? { status: 'denied', reason: 'client_not_visible' }
        : { status: 'eligible', reason: 'authorized' };
    } catch {
      return { status: 'unknown', reason: 'check_failed' };
    }
  }

  private async checkClientKnowledge(ctx: TenantContext, clientId: string): Promise<ClientCheck> {
    try {
      // Invocation first resolves the client by tenant, then ClientKbService
      // gates retrieval through clientMemoryAllowed(). Requiring non-archived
      // here is deliberately stricter than the lookup used by that handler.
      const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.client.findFirst({
          where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
          select: { id: true },
        }),
      );
      if (!client) return { status: 'denied', reason: 'client_not_visible' };
      const allowed = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
        clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId),
      );
      return allowed
        ? { status: 'eligible', reason: 'authorized' }
        : { status: 'denied', reason: 'client_not_visible' };
    } catch {
      return { status: 'unknown', reason: 'check_failed' };
    }
  }

  private async checkRepresentation(ctx: TenantContext, clientId: string): Promise<ClientCheck> {
    try {
      // Mirrors getRepresentation() -> ensureClientVisible(ctx, id, true),
      // whose exact database predicate is visibleClientWhere(ctx).
      const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.client.findFirst({
          where: { id: clientId, ...visibleClientWhere(ctx) },
          select: { id: true },
        }),
      );
      return client
        ? { status: 'eligible', reason: 'authorized' }
        : { status: 'denied', reason: 'client_not_visible' };
    } catch {
      return { status: 'unknown', reason: 'check_failed' };
    }
  }

  private entry(tool: MeriToolAvailabilityProofTool, check: ClientCheck) {
    // This endpoint is evidence only. Even an eligible finding is never an
    // authorization token and cannot be used to bypass invocation guards.
    return { tool, ...check, executable: false as const };
  }

  private allChecks(
    offeredNames: ReadonlySet<string>,
    status: MeriToolAvailabilityStatus,
    reason: ClientCheck['reason'],
    includeAnalysis = true,
  ): { tool: MeriPermissionDiagnosticTool; check: ClientCheck }[] {
    const checks: { tool: MeriPermissionDiagnosticTool; check: ClientCheck }[] = MERI_TOOL_AVAILABILITY_PROOF_CATALOG
      .filter(({ tool }) => offeredNames.has(tool))
      .map(({ tool }) => ({ tool, check: { status, reason } }));
    if (includeAnalysis && offeredNames.has('run_analysis')) {
      checks.push({ tool: 'run_analysis', check: { status, reason } });
    }
    return checks;
  }

}
