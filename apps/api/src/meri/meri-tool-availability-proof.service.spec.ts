import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { fingerprintMeriFinalToolSchemas } from '@capiro/meriv2-core';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { MeriV3InternalServiceGuard } from './meri-v3-internal-service.guard.js';
import type { MeriFeatureFlagsService } from './meri-feature-flags.service.js';
import { MeriToolAvailabilityProofController } from './meri-tool-availability-proof.controller.js';
import {
  MERI_OFFERED_TOOL_DIAGNOSTIC_CATALOG_SHA256,
  MERI_TOOL_AVAILABILITY_PROOF_CATALOG,
  MERI_TOOL_AVAILABILITY_PROOF_CATALOG_SHA256,
  MERI_TOOL_AVAILABILITY_PROOF_VERSION,
  MERI_FINAL_SCHEMA_VERSION,
} from './meri-tool-availability-proof.contract.js';
import { MeriToolAvailabilityProofService } from './meri-tool-availability-proof.service.js';
import type { MeriAnalysisSandboxReadinessObserver } from './meri-analysis-sandbox-readiness-observer.service.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const userId = '20000000-0000-4000-8000-000000000002';
const conversationId = '30000000-0000-4000-8000-000000000003';
const clientId = '40000000-0000-4000-8000-000000000004';
const otherClientId = '50000000-0000-4000-8000-000000000005';
const ctx = { tenantId, tenantSlug: 'capiro-internal', userId, clerkUserId: 'clerk-user', role: 'standard_user' } as TenantContext;
const finalOfferedTools = ['get_client_context', 'search_client_knowledge', 'get_representation'].map((name) => ({ type: 'function' as const, name, description: name, parameters: { type: 'object', properties: {} }, strict: false }));
const turn = { nonce: '60000000-0000-4000-8000-000000000006', surface: 'chat' as const, finalSchemaVersion: MERI_FINAL_SCHEMA_VERSION, finalOfferedTools };
const requestBody = { conversationId, turnNonce: turn.nonce, surface: turn.surface, finalSchemaVersion: turn.finalSchemaVersion, finalOfferedTools };

function setup(options: {
  conversation?: { clientId: string | null; status?: string } | null;
  activeClient?: boolean;
  denied?: boolean;
  wallAllowed?: boolean;
  fail?: boolean;
  analysisTenantSettings?: unknown;
  analysisTenantMissing?: boolean;
  analysisTenantSlug?: string;
  analysisScopeVisible?: boolean;
  analysisScopeClientId?: string | null;
  effectiveV3?: boolean;
  effectiveAnalysis?: boolean;
  readinessObserver?: MeriAnalysisSandboxReadinessObserver;
} = {}) {
  const state = {
    conversation: options.conversation === undefined
      ? { clientId, status: 'active' }
      : options.conversation === null
        ? null
        : { status: 'active', ...options.conversation },
    activeClient: options.activeClient ?? true,
    denied: options.denied ?? false,
    wallAllowed: options.wallAllowed ?? true,
    fail: options.fail ?? false,
    analysisTenantSettings: options.analysisTenantSettings ?? {
      clioFeatureFlags: { 'meriv3.fullChat': true, runAnalysis: true },
    },
    analysisTenantMissing: options.analysisTenantMissing ?? false,
    analysisScopeVisible: options.analysisScopeVisible ?? true,
  };
  const tx = {
    tenant: {
      findFirst: jest.fn(async () => {
        if (state.fail) throw new Error('database unavailable');
        return state.analysisTenantMissing
          ? null
          : { slug: options.analysisTenantSlug ?? 'capiro-internal', settings: state.analysisTenantSettings };
      }),
    },
    clioConversation: {
      findFirst: jest.fn(async (args: any) => {
        expect(args.where).toMatchObject({ id: conversationId, tenantId, userId, archivedAt: null });
        expect(args.where).not.toHaveProperty('status');
        if (state.fail) throw new Error('database unavailable');
        return state.conversation;
      }),
    },
      client: {
      findFirst: jest.fn(async (args: any) => {
        if (!state.activeClient || args.where.id !== clientId) return null;
        if (Array.isArray(args.where.OR) && state.denied) return null;
        return { id: clientId };
      }),
    },
    $queryRawUnsafe: jest.fn(async (sql: string) => {
      if (state.fail) throw new Error('database unavailable');
      if (sql.includes('SELECT c.id')) return state.denied ? [{ id: clientId }] : [];
      if (sql.includes('SELECT (NOT c.memory_wall')) return [{ allowed: state.wallAllowed }];
      throw new Error('unexpected authorization query');
    }),
    $queryRaw: jest.fn(async (parts: TemplateStringsArray) => {
      if (state.fail) throw new Error('database unavailable');
      const sql = parts.join('?');
      if (sql.includes('FROM clio_conversations')) {
        return state.analysisScopeVisible && state.conversation
          ? [{ client_id: options.analysisScopeClientId === undefined
            ? state.conversation.clientId
            : options.analysisScopeClientId }]
          : [];
      }
      if (sql.includes('FROM client_memory_access')) {
        return state.wallAllowed ? [{ id: 'grant' }] : [];
      }
      if (sql.includes('FROM clients')) {
        return state.activeClient ? [{ memory_wall: true }] : [];
      }
      throw new Error('unexpected analysis authorization query');
    }),
  };
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, fn: (transaction: unknown) => unknown) => fn(tx)),
    withTenantUser: jest.fn(async (_tenant: string, _user: string, fn: (transaction: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  const flags = {
    isMeriV3ChatEnabled: jest.fn(async () => options.effectiveV3 ?? true),
    isEnabled: jest.fn(async () => options.effectiveAnalysis ?? true),
  } as unknown as MeriFeatureFlagsService;
  return { service: new MeriToolAvailabilityProofService(prisma, flags, options.readinessObserver), prisma, tx, state, flags };
}

describe('MeriToolAvailabilityProofService (dark v3)', () => {
  it('binds a server-owned exact tool catalog and its versioned fingerprint', async () => {
    const h = setup();
    const proof = await h.service.prove(ctx, conversationId, turn);
    expect(MERI_TOOL_AVAILABILITY_PROOF_VERSION).toBe('meri.tool-availability-proof.v3');
    expect(MERI_TOOL_AVAILABILITY_PROOF_CATALOG.map((entry) => entry.tool)).toEqual([
      'get_client_context', 'search_client_knowledge', 'get_representation',
    ]);
    expect(MERI_TOOL_AVAILABILITY_PROOF_CATALOG_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(proof.catalogSha256).toBe(MERI_TOOL_AVAILABILITY_PROOF_CATALOG_SHA256);
    expect(proof).toMatchObject({ semantics: 'permission_only', eligibility: 'unresolved', runtimeAvailability: 'unresolved', unresolvedChecks: ['runtime-availability'] });
    expect(proof.turnBinding).toMatchObject({
      finalSchemaFingerprint: fingerprintMeriFinalToolSchemas(finalOfferedTools),
      schemaFingerprintProvenance: 'api_recomputed_from_exact_provider_schemas',
      integrity: 'api_recomputed_schema_fingerprint',
    });
    expect(proof.tools.map((entry) => entry.tool)).toEqual(MERI_TOOL_AVAILABILITY_PROOF_CATALOG.map((entry) => entry.tool));
    expect(proof.offeredDiagnostic).toMatchObject({
      version: 'meri.offered-tool-diagnostic.v2',
      catalogSha256: MERI_OFFERED_TOOL_DIAGNOSTIC_CATALOG_SHA256,
    });
    expect(proof.offeredDiagnostic.tools.map((entry) => entry.tool)).toEqual(finalOfferedTools.map((tool) => tool.name));
    expect(proof.offeredDiagnostic.tools.every((entry) => entry.runtimeAvailability === 'unresolved' && entry.eligibility === 'unresolved' && !entry.executable)).toBe(true);
  });

  it('checks only offered catalog names and leaves other offered families unresolved', async () => {
    const h = setup();
    const subset = [
      finalOfferedTools[0]!,
      { ...finalOfferedTools[0]!, name: 'search_public_web' },
    ];
    const proof = await h.service.prove(ctx, conversationId, { ...turn, finalOfferedTools: subset });
    expect(proof.tools.map(({ status, reason }) => ({ status, reason }))).toEqual([
      { status: 'eligible', reason: 'authorized' },
      { status: 'unknown', reason: 'not_offered' },
      { status: 'unknown', reason: 'not_offered' },
    ]);
    expect(proof.offeredDiagnostic.tools).toMatchObject([
      { tool: 'get_client_context', permissionStatus: 'eligible', permissionReason: 'authorized', executable: false },
      { tool: 'search_public_web', permissionStatus: 'unknown', permissionReason: 'permission_semantics_unresolved', executable: false },
    ]);
    expect(h.tx.client.findFirst).toHaveBeenCalledTimes(1);
    expect(h.tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('performs no catalog permission reads when none of its names were offered', async () => {
    const h = setup();
    const proof = await h.service.prove(ctx, conversationId, {
      ...turn,
      finalOfferedTools: [{ ...finalOfferedTools[0]!, name: 'search_public_web' }],
    });
    expect(proof.offeredDiagnostic.tools).toMatchObject([
      { tool: 'search_public_web', permissionStatus: 'unknown', permissionReason: 'permission_semantics_unresolved', runtimeAvailability: 'unresolved', eligibility: 'unresolved', executable: false },
    ]);
    expect(proof.tools.every((entry) => entry.status === 'unknown' && entry.reason === 'not_offered')).toBe(true);
    expect(h.tx.client.findFirst).not.toHaveBeenCalled();
    expect(h.tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('mounts only behind the strict service-secret guard in addition to API bearer context', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, MeriToolAvailabilityProofController) as unknown[];
    expect(guards).toContain(MeriV3InternalServiceGuard);
    expect(guards).toContain(RolesGuard);
    expect(Reflect.getMetadata(ROLES_KEY, MeriToolAvailabilityProofController)).toEqual(['standard_user']);
    const guard = new RolesGuard(new Reflector());
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ tenantContext: { ...ctx, role: 'client_portal_user' } } as Request & { tenantContext?: TenantContext }) }),
      getHandler: () => MeriToolAvailabilityProofController.prototype.check,
      getClass: () => MeriToolAvailabilityProofController,
    } as never;
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('derives client scope from the authenticated persisted conversation only', async () => {
    const h = setup({ conversation: { clientId } });
    const proof = await h.service.prove(ctx, conversationId, turn);
    expect(proof.scope).toMatchObject({ tenantId, userId, conversationId, clientId, surface: 'chat', source: 'authenticated_context_and_persisted_conversation' });
    expect(proof.turnBinding).toMatchObject({ nonce: turn.nonce, nonceProvenance: 'authenticated_internal_service_assertion', surface: 'chat', surfaceProvenance: 'authenticated_internal_service_assertion', finalSchemaVersion: MERI_FINAL_SCHEMA_VERSION, schemaFingerprintProvenance: 'api_recomputed_from_exact_provider_schemas', integrity: 'api_recomputed_schema_fingerprint' });
    expect(Number.isNaN(Date.parse(proof.turnBinding.checkTime))).toBe(false);
    expect(proof).toMatchObject({ eligibility: 'unresolved', unresolvedChecks: ['runtime-availability'] });
    expect(proof.clientScope).toBe('present');
    expect(proof.tools.every((entry) => entry.status === 'eligible' && !entry.executable)).toBe(true);
    expect(h.prisma.withTenantUser).toHaveBeenCalledWith(tenantId, userId, expect.any(Function));
    expect(h.tx.clioConversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: conversationId, tenantId, userId, archivedAt: null },
      select: { clientId: true, status: true },
    }));
  });

  it('returns clarification/needs_input, never executable eligibility, when the persisted conversation has no client', async () => {
    const h = setup({ conversation: { clientId: null } });
    const proof = await h.service.prove(ctx, conversationId, turn);
    expect(proof.clientScope).toBe('needs_input');
    expect(proof.scope.source).toBe('authenticated_context_and_persisted_conversation');
    expect(proof.tools).toHaveLength(3);
    expect(proof.tools.every((entry) => entry.status === 'unknown' && !entry.executable && entry.reason === 'needs_input')).toBe(true);
    expect(h.tx.client.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong user or tenant', null],
    ['archived conversation', null],
  ])('fails closed for %s', async (_label, conversation) => {
    const h = setup({ conversation });
    const proof = await h.service.prove(ctx, conversationId, turn);
    expect(proof.clientScope).toBe('unavailable');
    expect(proof.scope.source).toBe('authenticated_context_only');
    expect(proof.tools.every((entry) => entry.status === 'denied' && !entry.executable && entry.reason === 'conversation_unavailable')).toBe(true);
    expect(h.tx.client.findFirst).not.toHaveBeenCalled();
  });

  it('denies archived/invisible clients and active ethical-wall denials', async () => {
    const archived = await setup({ activeClient: false }).service.prove(ctx, conversationId, turn);
    expect(archived.tools.every((entry) => entry.status === 'denied' && !entry.executable)).toBe(true);
    const walled = await setup({ denied: true, wallAllowed: false }).service.prove(ctx, conversationId, turn);
    expect(walled.tools.every((entry) => entry.status === 'denied' && !entry.executable)).toBe(true);
  });

  it('keeps failed authorization checks unknown, never eligible', async () => {
    const proof = await setup({ fail: true }).service.prove(ctx, conversationId, turn);
    expect(proof.scope.source).toBe('authenticated_context_only');
    expect(proof.tools.every((entry) => entry.status === 'unknown' && !entry.executable && entry.reason === 'check_failed')).toBe(true);
  });

  it('enforces the standard-user floor in the service itself, not only at the HTTP route', async () => {
    const h = setup();
    const lowRole = { ...ctx, role: 'client_portal_user' } as TenantContext;
    const proof = await h.service.prove(lowRole, conversationId, turn);
    expect(proof.scope.source).toBe('authenticated_context_only');
    expect(proof.tools.every((entry) => entry.status === 'denied' && !entry.executable && entry.reason === 'caller_role_insufficient')).toBe(true);
    expect(h.tx.clioConversation.findFirst).not.toHaveBeenCalled();
  });

  it('accepts exact schema-bearing shape and rejects caller scope/candidate claims', async () => {
    const prove = jest.fn(async () => ({ turnBinding: { integrity: 'api_recomputed_schema_fingerprint' } }));
    const controller = new MeriToolAvailabilityProofController({ prove } as never);
    await controller.check(ctx, requestBody);
    expect(prove).toHaveBeenCalledWith(ctx, conversationId, turn);
    for (const extra of [{ clientId: otherClientId }, { tools: [] }, { tenantId: 'foreign' }, { userId: 'foreign' }, { candidates: [] }, { finalSchemaFingerprint: 'a'.repeat(64) }]) {
      expect(() => controller.check(ctx, { ...requestBody, ...extra })).toThrow('valid turn-bound proof request');
    }
    for (const invalid of [{ turnNonce: 'bad' }, { surface: 'admin' }, { finalSchemaVersion: 'unknown' }, { finalOfferedTools: [{ type: 'function', name: 'bad', description: '', parameters: {}, extra: true }] }, { finalOfferedTools: Array(257).fill(finalOfferedTools[0]) }]) {
      expect(() => controller.check(ctx, { ...requestBody, ...invalid })).toThrow('valid turn-bound proof request');
    }
    const oversizedTools = Array.from({ length: 64 }, (_, index) => ({
      ...finalOfferedTools[0]!, name: `schema_${index}`, description: 'x'.repeat(15_000),
    }));
    expect(() => controller.check(ctx, { ...requestBody, finalOfferedTools: oversizedTools })).toThrow('valid turn-bound proof request');
    expect(() => controller.check(ctx, { ...requestBody, conversationId: 'not-a-uuid' })).toThrow('valid turn-bound proof request');
  });

  it('rejects malformed turn claims when called below the controller', async () => {
    const service = setup().service;
    await expect(service.prove(ctx, conversationId, { ...turn, nonce: 'bad' })).rejects.toThrow();
    await expect(service.prove(ctx, conversationId, { ...turn, surface: 'admin' as never })).rejects.toThrow();
    await expect(service.prove(ctx, conversationId, { ...turn, finalSchemaVersion: 'v0' as never })).rejects.toThrow();
    await expect(service.prove(ctx, conversationId, { ...turn, finalOfferedTools: Array(257).fill(finalOfferedTools[0]) })).rejects.toThrow();
  });
});

describe('run_analysis permission-only offered diagnostic', () => {
  const oldEnabled = process.env.MERIV3_ENABLED;
  const oldSlugs = process.env.MERIV3_CANARY_TENANT_SLUGS;
  const analysisTool = { ...finalOfferedTools[0]!, name: 'run_analysis' };
  const analysisTurn = { ...turn, finalOfferedTools: [analysisTool] };

  beforeEach(() => {
    process.env.MERIV3_ENABLED = 'true';
    process.env.MERIV3_CANARY_TENANT_SLUGS = 'capiro-internal';
  });
  afterEach(() => {
    if (oldEnabled === undefined) delete process.env.MERIV3_ENABLED;
    else process.env.MERIV3_ENABLED = oldEnabled;
    if (oldSlugs === undefined) delete process.env.MERIV3_CANARY_TENANT_SLUGS;
    else process.env.MERIV3_CANARY_TENANT_SLUGS = oldSlugs;
  });

  it('marks observer demand only for a genuinely offered and eligible run_analysis row without changing proof shape', async () => {
    const noteRunAnalysisOffered = jest.fn();
    const readinessObserver = { noteRunAnalysisOffered } as unknown as MeriAnalysisSandboxReadinessObserver;
    const offered = await setup({ readinessObserver }).service.prove(ctx, conversationId, analysisTurn);
    expect(noteRunAnalysisOffered).toHaveBeenCalledTimes(1);
    expect(offered.offeredDiagnostic.tools[0]).toMatchObject({
      tool: 'run_analysis', permissionStatus: 'eligible', runtimeAvailability: 'unresolved',
      eligibility: 'unresolved', executable: false,
    });
    expect(offered).not.toHaveProperty('sandboxReadiness');

    await setup({ readinessObserver }).service.prove(ctx, conversationId, turn);
    await setup({ readinessObserver, wallAllowed: false }).service.prove(ctx, conversationId, analysisTurn);
    await setup({ readinessObserver, effectiveAnalysis: false }).service.prove(ctx, conversationId, analysisTurn);
    expect(noteRunAnalysisOffered).toHaveBeenCalledTimes(1);
  });

  it('keeps the v3 three-tool catalog fixed and permits a clientless V3 analysis conversation', async () => {
    const h = setup({ conversation: { clientId: null } });
    const proof = await h.service.prove(ctx, conversationId, {
      ...analysisTurn,
      finalOfferedTools: [...finalOfferedTools, analysisTool],
    });
    expect(proof.catalogSha256).toBe('a4e1eeb283348dc9f430424695f86d36fcd642283f6a2af2bccdf8aa1d49b2dd');
    expect(MERI_OFFERED_TOOL_DIAGNOSTIC_CATALOG_SHA256).toBe('f47b85b2cf1386eb430fc42b544bfe8e932655542dfdd54940fbb3b58863fcbf');
    expect(proof.offeredDiagnostic.catalogSha256).not.toBe(proof.catalogSha256);
    expect(proof.tools).toHaveLength(3);
    expect(proof.tools.every(({ status, reason, executable }) =>
      status === 'unknown' && reason === 'needs_input' && executable === false,
    )).toBe(true);
    expect(proof.clientScope).toBe('needs_input');
    expect(proof.offeredDiagnostic.tools).toMatchObject([
      ...finalOfferedTools.map(({ name }) => ({
        tool: name, permissionStatus: 'unknown', permissionReason: 'needs_input', executable: false,
      })),
      {
        tool: 'run_analysis', permissionStatus: 'eligible', permissionReason: 'authorized',
        runtimeAvailability: 'unresolved', eligibility: 'unresolved', executable: false,
      },
    ]);
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('denies a walled client without a current-user grant', async () => {
    const proof = await setup({ wallAllowed: false }).service.prove(ctx, conversationId, analysisTurn);
    expect(proof.offeredDiagnostic.tools).toMatchObject([{
      tool: 'run_analysis', permissionStatus: 'denied', permissionReason: 'analysis_scope_unavailable', executable: false,
    }]);
  });

  it('accepts a current-user grant and denies archived or reassigned analysis scope', async () => {
    const granted = await setup({ wallAllowed: true }).service.prove(ctx, conversationId, analysisTurn);
    expect(granted.offeredDiagnostic.tools[0]).toMatchObject({ permissionStatus: 'eligible', permissionReason: 'authorized' });
    const archived = await setup({ activeClient: false }).service.prove(ctx, conversationId, analysisTurn);
    expect(archived.offeredDiagnostic.tools[0]).toMatchObject({ permissionStatus: 'denied', permissionReason: 'analysis_scope_unavailable' });
    const reassigned = await setup({ analysisScopeClientId: otherClientId }).service.prove(ctx, conversationId, analysisTurn);
    expect(reassigned.offeredDiagnostic.tools[0]).toMatchObject({ permissionStatus: 'denied', permissionReason: 'analysis_scope_unavailable' });
  });

  it('respects the V3 gate and tenant opt-out, including their effective cached gates', async () => {
    process.env.MERIV3_ENABLED = 'false';
    const off = await setup().service.prove(ctx, conversationId, analysisTurn);
    expect(off.offeredDiagnostic.tools[0]).toMatchObject({ permissionStatus: 'denied', permissionReason: 'v3_disabled' });

    process.env.MERIV3_ENABLED = 'true';
    const optedOut = await setup({ analysisTenantSettings: {
      clioFeatureFlags: { 'meriv3.fullChat': true, runAnalysis: false },
    } }).service.prove(ctx, conversationId, analysisTurn);
    expect(optedOut.offeredDiagnostic.tools[0]).toMatchObject({ permissionStatus: 'denied', permissionReason: 'tenant_feature_disabled' });

    const cachedV3Off = await setup({ effectiveV3: false }).service.prove(ctx, conversationId, analysisTurn);
    expect(cachedV3Off.offeredDiagnostic.tools[0]).toMatchObject({ permissionStatus: 'denied', permissionReason: 'v3_disabled' });
    const cachedAnalysisOff = await setup({ effectiveAnalysis: false }).service.prove(ctx, conversationId, analysisTurn);
    expect(cachedAnalysisOff.offeredDiagnostic.tools[0]).toMatchObject({ permissionStatus: 'denied', permissionReason: 'tenant_feature_disabled' });
    const outsideCanary = await setup({ analysisTenantSlug: 'other-tenant' }).service.prove(ctx, conversationId, analysisTurn);
    expect(outsideCanary.offeredDiagnostic.tools[0]).toMatchObject({ permissionStatus: 'denied', permissionReason: 'v3_disabled' });
  });

  it('follows the V3 bridge on research turns and non-active unarchived conversations', async () => {
    const h = setup({ conversation: { clientId, status: 'paused' } });
    const proof = await h.service.prove(ctx, conversationId, { ...analysisTurn, surface: 'research' });
    expect(proof.tools.every(({ status, reason }) => status === 'unknown' && reason === 'not_offered')).toBe(true);
    expect(proof.offeredDiagnostic.tools[0]).toMatchObject({ permissionStatus: 'eligible', permissionReason: 'authorized' });
    expect(h.tx.client.findFirst).not.toHaveBeenCalled();
  });

  it('never converts missing tenant, failed reads, lost scope, missing conversation, or low role into eligibility', async () => {
    const cases = [
      [setup({ analysisTenantMissing: true }), 'unknown', 'check_failed'],
      [setup({ fail: true }), 'unknown', 'check_failed'],
      [setup({ analysisScopeVisible: false }), 'denied', 'analysis_scope_unavailable'],
      [setup({ conversation: null }), 'denied', 'conversation_unavailable'],
    ] as const;
    for (const [h, status, reason] of cases) {
      const proof = await h.service.prove(ctx, conversationId, analysisTurn);
      expect(proof.offeredDiagnostic.tools[0]).toMatchObject({ permissionStatus: status, permissionReason: reason });
    }
    const lowRole = { ...ctx, role: 'client_portal_user' } as TenantContext;
    const roleProof = await setup().service.prove(lowRole, conversationId, analysisTurn);
    expect(roleProof.offeredDiagnostic.tools[0]).toMatchObject({ permissionStatus: 'denied', permissionReason: 'caller_role_insufficient' });
  });
});
