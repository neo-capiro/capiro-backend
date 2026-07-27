/**
 * Generation Gateway (Phase 1 §3.g1, §5.3).
 *
 * Exercises the ORDER, which is the control: a critical source failure or an
 * invalid plan must short-circuit BEFORE any drafting call, and provider/model
 * must be pinned once and honored on every unit.
 */
import { describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { GenerationGatewayService } from './generation-gateway.service.js';
import { GenerationVerifierService } from './generation-verifier.service.js';
import { EvidencePacketPersistError } from './evidence-packet.service.js';
import { MessagePlanInvalidError } from './message-plan.schema.js';
import { GATEWAY_PROMPT_SPEC_VERSION } from './gateway-prompt.js';
import { policyForAudience } from './government-affairs-policy.registry.js';
import type { EvidencePacketV2 } from './evidence-packet.types.js';
import type { GenerationRequest } from './generation-gateway.types.js';

const NOW = new Date('2026-07-26T00:00:00.000Z');
const CTX = {
  tenantId: 't1',
  tenantSlug: 'tenant',
  userId: 'u1',
  clerkUserId: 'clerk_u1',
  role: 'user',
} as unknown as TenantContext;

const CRED = {
  provider: 'anthropic' as const,
  apiKey: 'k',
  model: 'claude-sonnet-4-6',
  usedTenantKey: false,
  modelOverridden: false,
};

function basePacket(over: Partial<EvidencePacketV2> = {}): EvidencePacketV2 {
  return {
    packetId: 'packet-1',
    packetVersion: 2,
    tenantId: 't1',
    userId: 'u1',
    clientId: 'c1',
    surface: 'outreach_email',
    ref: {},
    directives: [],
    evidence: [],
    standingMemory: [],
    standingMemoryExclusions: [],
    failures: [],
    policy: {
      jurisdiction: 'federal',
      audienceType: 'congressional_office',
      policyId: 'federal.congressional_office',
      version: 'ga-policy-v1',
    },
    modelPolicy: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      promptSpecVersion: GATEWAY_PROMPT_SPEC_VERSION,
    },
    criticalFailureCount: 0,
    freshestSourceAt: null,
    stalestSourceAt: null,
    compiledAt: NOW.toISOString(),
    packetHash: 'hash',
    emailScope: 'mine',
    ...over,
  };
}

function makeGateway(opts: {
  enabled?: boolean;
  emailScope?: 'mine' | 'firm_shared';
  packet?: EvidencePacketV2;
  packetThrows?: unknown;
  planThrows?: unknown;
  completeImpl?: () => Promise<{ text: string; usage: unknown }>;
  versionImpl?: () => Promise<unknown>;
  tenantSettings?: unknown;
} = {}) {
  const config = {
    get: (key: string) =>
      key === 'ENGAGEMENT_GENERATION_GATEWAY'
        ? (opts.enabled ?? true)
        : (opts.emailScope ?? 'mine'),
  } as never;
  const prisma = {
    withTenant: async (_t: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ tenant: { findFirst: async () => ({ settings: opts.tenantSettings ?? {} }) } }),
    withTenantUser: async (_t: string, _u: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({}),
  };
  const ai = { resolveOutreachCredentials: jest.fn(async () => [CRED]) };
  const complete = jest.fn(
    opts.completeImpl ??
      (async () => ({
        text: JSON.stringify({
          subject: 'A 20-minute meeting before the markup',
          body: 'Hi Dana — could we find 20 minutes before the markup? Best,',
          contextNote: 'Grounded in the selected bill.',
        }),
        usage: { inputTokens: 100, outputTokens: 50 },
      })),
  );
  const llm = { complete };
  const packets = {
    compileOutreachPacket: jest.fn(async () => {
      if (opts.packetThrows) throw opts.packetThrows;
      return opts.packet ?? basePacket();
    }),
  };
  const plans = {
    resolvePlanModel: jest.fn(() => 'claude-haiku-4-5-20251001'),
    buildPlan: jest.fn(async () => {
      if (opts.planThrows) throw opts.planThrows;
      return {
        plan: {
          intent: 'meeting_request',
          jurisdiction: 'federal',
          audienceType: 'congressional_office',
          clientRepresented: 'Aperture',
          desiredOutcome: 'A meeting.',
          whyRecipient: [],
          whyNow: [],
          clientAsk: ['A 20-minute meeting.'],
          supportedClaims: [],
          unsupportedOrRiskyClaims: [],
          tone: 'professional',
          callToAction: 'Could we find 20 minutes?',
          missingCriticalContext: [],
        },
        planModel: 'claude-haiku-4-5-20251001',
        provider: 'anthropic',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
  };
  const styles = { getProfile: jest.fn(async () => null), renderProfileBlock: jest.fn(() => '') };
  const upsertGeneratedVersion = jest.fn(
    opts.versionImpl ??
      (async () => ({
        id: 'v1',
        artifactId: 'a1',
        version: 1,
        generationStatus: 'generated',
        auditStatus: 'passed',
        approvalStatus: 'not_required',
        sendable: true,
      })),
  );
  const drafts = { upsertGeneratedVersion };
  const scanner = { scanRequired: false, providerName: 'none' };

  const svc = new GenerationGatewayService(
    config,
    prisma as never,
    ai as never,
    llm as never,
    packets as never,
    plans as never,
    new GenerationVerifierService(),
    styles as never,
    drafts as never,
    scanner as never,
  );
  return { svc, complete, packets, plans, upsertGeneratedVersion, ai };
}

function request(over: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    surface: 'outreach_email',
    clientId: 'c1',
    outreachRecordId: 'rec-1',
    items: [],
    templateId: 'meeting_request',
    templatePrompt: 'Request a meeting.',
    tone: 'professional',
    direction: 'on-behalf',
    audienceKind: 'individual',
    recipient: {
      generationKey: 'individual:dana',
      scopeKeys: ['dana'],
      recipientKey: 'dana',
      name: 'Dana Reed',
      email: 'dana.reed@mail.house.gov',
      title: 'Representative',
      office: 'House',
      state: 'CA',
      district: '12',
      sourceType: 'congress',
      chamber: 'House',
      snapshot: {},
    },
    now: NOW,
    ...over,
  };
}

describe('happy path', () => {
  test('produces a sendable result with a manifest and a persisted version', async () => {
    const { svc, upsertGeneratedVersion } = makeGateway();
    const result = await svc.generate(CTX, request(), enrichment(), [CRED]);
    expect(result.outcome).toBe('ready');
    expect(result.sendable).toBe(true);
    expect(result.versionId).toBe('v1');
    expect(result.manifest.contextPacketId).toBe('packet-1');
    expect(result.manifest.promptSpecVersion).toBe(GATEWAY_PROMPT_SPEC_VERSION);
    expect(upsertGeneratedVersion).toHaveBeenCalledTimes(1);
  });

  test('the manifest reports the resolved policy and the mailbox scope verbatim', async () => {
    const { svc } = makeGateway();
    const result = await svc.generate(CTX, request(), enrichment(), [CRED]);
    expect(result.manifest.policy.audienceType).toBe('congressional_office');
    expect(result.manifest.emailScopeLabel).toBe('My mailbox');
  });
});

describe('short-circuits BEFORE any drafting call', () => {
  test('an ambiguous audience blocks and never calls the model (§4.19)', async () => {
    const { svc, complete, packets } = makeGateway();
    const result = await svc.generate(
      CTX,
      request({ direction: null, recipient: { ...request().recipient, sourceType: null, email: null, chamber: 'House' } }),
      enrichment(),
      [CRED],
    );
    expect(result.outcome).toBe('blocked');
    expect(result.error).toBe('AUDIENCE_POLICY_REQUIRED');
    expect(packets.compileOutreachPacket).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  test('a CRITICAL source failure blocks before spending anything', async () => {
    const { svc, complete, plans } = makeGateway({
      packet: basePacket({
        criticalFailureCount: 1,
        failures: [
          {
            sourceType: 'bill',
            severity: 'critical',
            code: 'BILL_NOT_ON_RECORD',
            userMessage: 'No record of that bill.',
          },
        ],
      }),
    });
    const result = await svc.generate(CTX, request(), enrichment(), [CRED]);
    expect(result.outcome).toBe('blocked');
    expect(result.error).toBe('CRITICAL_SOURCE_FAILURE');
    expect(result.sendable).toBe(false);
    // Neither the planner nor the drafter ran.
    expect(plans.buildPlan).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    // …and the user is told exactly what to fix.
    expect(result.manifest.criticalMissingContext).toEqual(['No record of that bill.']);
  });

  test('an invalid Message Plan blocks with reviewable issues and no draft (§4.22)', async () => {
    const { svc, complete } = makeGateway({
      planThrows: new MessagePlanInvalidError([
        { code: 'CLAIM_CITES_UNKNOWN_SOURCE', message: 'cites s999' },
      ]),
    });
    const result = await svc.generate(CTX, request(), enrichment(), [CRED]);
    expect(result.outcome).toBe('blocked');
    expect(result.error).toBe('MESSAGE_PLAN_INVALID');
    expect(result.planIssues?.[0]?.code).toBe('CLAIM_CITES_UNKNOWN_SOURCE');
    expect(complete).not.toHaveBeenCalled();
  });

  test('a packet that cannot be persisted blocks generation (§4.7)', async () => {
    const { svc, complete } = makeGateway({
      packetThrows: new EvidencePacketPersistError('db down'),
    });
    const result = await svc.generate(CTX, request(), enrichment(), [CRED]);
    expect(result.outcome).toBe('blocked');
    expect(result.error).toBe('CONTEXT_PACKET_PERSIST_FAILED');
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('provider/model pinning (§3.k)', () => {
  test('a pinned identity is used for the draft call, not the resolver default', async () => {
    const { svc, complete } = makeGateway();
    await svc.generate(
      CTX,
      request({
        pinned: {
          provider: 'anthropic',
          model: 'claude-opus-pinned',
          planModel: 'claude-haiku-4-5-20251001',
          promptSpecVersion: GATEWAY_PROMPT_SPEC_VERSION,
          policyId: 'federal.congressional_office',
          policyVersion: 'ga-policy-v1',
        },
      }),
      enrichment(),
      [CRED],
    );
    const call = (complete.mock.calls as unknown as Array<[{ model: string }]>)[0]!;
    expect(call[0].model).toBe('claude-opus-pinned');
  });

  test('an unavailable pinned provider FAILS rather than switching voice', async () => {
    const { svc, complete } = makeGateway();
    const result = await svc.generate(
      CTX,
      request({
        pinned: {
          provider: 'openai',
          model: 'gpt-4.1',
          planModel: null,
          promptSpecVersion: GATEWAY_PROMPT_SPEC_VERSION,
          policyId: 'federal.congressional_office',
          policyVersion: 'ga-policy-v1',
        },
      }),
      enrichment(),
      // Only an Anthropic credential is available.
      [CRED],
    );
    expect(result.outcome).toBe('blocked');
    expect(result.error).toBe('PINNED_PROVIDER_UNAVAILABLE');
    expect(complete).not.toHaveBeenCalled();
  });

  test('resolvePinnedIdentity records provider, model and prompt spec once', async () => {
    const { svc } = makeGateway();
    const identity = await svc.resolvePinnedIdentity(CTX, {
      policy: policyForAudience('congressional_office'),
    });
    expect(identity?.pinned).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      promptSpecVersion: GATEWAY_PROMPT_SPEC_VERSION,
    });
  });

  test('policy is re-resolved per unit, so a mixed-audience batch is not forced', async () => {
    const { svc } = makeGateway();
    const result = await svc.generate(
      CTX,
      request({
        // The job pinned a FEDERAL policy, but this recipient is a client contact.
        direction: 'to-clients',
        pinned: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          planModel: null,
          promptSpecVersion: GATEWAY_PROMPT_SPEC_VERSION,
          policyId: 'federal.congressional_office',
          policyVersion: 'ga-policy-v1',
        },
      }),
      enrichment(),
      [CRED],
    );
    expect(result.pinned.policyId).toBe('internal.client_executive');
  });
});

describe('mailbox scope resolution (§3.d2)', () => {
  test("defaults to 'mine'", async () => {
    const { svc } = makeGateway({ emailScope: 'mine' });
    const out = await svc.resolveEmailScope(CTX, null);
    expect(out.scope).toBe('mine');
  });

  test("env firm_shared with the tenant setting OFF stays 'mine' (§4.11)", async () => {
    const { svc } = makeGateway({ emailScope: 'firm_shared', tenantSettings: {} });
    const out = await svc.resolveEmailScope(CTX, null);
    expect(out.scope).toBe('mine');
  });

  test('env firm_shared + tenant setting ON resolves firm_shared', async () => {
    const { svc } = makeGateway({
      emailScope: 'firm_shared',
      tenantSettings: { clioFeatureFlags: { engagementFirmMailContext: true } },
    });
    const out = await svc.resolveEmailScope(CTX, null);
    expect(out.scope).toBe('firm_shared');
  });
});

describe('failures after the draft call', () => {
  test('a provider failure leaves the packet and returns error, never a draft (§4.24)', async () => {
    const { svc, packets } = makeGateway({
      completeImpl: async () => {
        throw new Error('provider 503');
      },
    });
    const result = await svc.generate(CTX, request(), enrichment(), [CRED]);
    expect(result.outcome).toBe('error');
    expect(result.error).toBe('GENERATION_FAILED');
    expect(result.body).toBe('');
    // The packet WAS compiled and persisted before the failure.
    expect(packets.compileOutreachPacket).toHaveBeenCalledTimes(1);
    expect(result.manifest.contextPacketId).toBe('packet-1');
  });

  test('unparseable model output is an error, not a draft', async () => {
    const { svc } = makeGateway({
      completeImpl: async () => ({ text: 'not json at all', usage: {} }),
    });
    const result = await svc.generate(CTX, request(), enrichment(), [CRED]);
    expect(result.outcome).toBe('error');
    expect(result.error).toBe('DRAFT_OUTPUT_INVALID');
  });

  test('a version that cannot be persisted DISCARDS the text', async () => {
    const { svc } = makeGateway({
      versionImpl: async () => {
        throw new Error('db down');
      },
    });
    const result = await svc.generate(CTX, request(), enrichment(), [CRED]);
    expect(result.outcome).toBe('error');
    expect(result.error).toBe('DRAFT_PERSIST_FAILED');
    expect(result.body).toBe('');
    expect(result.sendable).toBe(false);
  });
});

describe('deterministic verifier findings ride into the version', () => {
  test('a placeholder in the output is passed to the draft service as blocking', async () => {
    const { svc, upsertGeneratedVersion } = makeGateway({
      completeImpl: async () => ({
        text: JSON.stringify({
          subject: 'Meeting',
          body: 'Hi {first_name} — could we meet?',
          contextNote: '',
        }),
        usage: {},
      }),
    });
    await svc.generate(CTX, request(), enrichment(), [CRED]);
    const calls = upsertGeneratedVersion.mock.calls as unknown as Array<
      [unknown, { verifierFindings: Array<{ check: string; blocking: boolean }> }]
    >;
    const arg = calls[0]![1];
    expect(
      arg.verifierFindings.some((f) => f.check === 'unresolved_placeholder' && f.blocking),
    ).toBe(true);
  });
});

function enrichment() {
  return {
    channels: [],
    clientBrief: null,
    clientName: 'Aperture Defense Systems',
    topicTerms: [],
    auditLedger: [],
    includeRelevantEmail: false,
  };
}
