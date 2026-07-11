// Outreach task-tier model selection + provider preference (W3.2 / D2).
// Prototype-stub pattern: a real EngagementAiService prototype over a stubbed
// completion client + credential resolver, capturing the request the client
// receives so we can assert the resolved provider + model.

import { describe, expect, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { EngagementAiService, type OutreachDraftInput } from './engagement-ai.service.js';
import type { ResolvedAiCredential } from './ai-credential-resolver.service.js';

const ctx: TenantContext = {
  tenantId: 't1',
  tenantSlug: 'capiro',
  userId: 'u1',
  clerkUserId: 'c1',
  role: 'standard_user',
} as TenantContext;

const INPUT: OutreachDraftInput = {
  workflow: 'campaign',
  client: { name: 'Aperture Defense Systems' },
  recipients: [{ name: 'Dana Reed', email: 'dana@mail.house.gov' }],
  context: { tone: 'professional' },
  promptTemplate: 'custom',
  objective: 'Request a meeting.',
};

function makeService(
  creds: ResolvedAiCredential[],
  cfg?: { provider?: 'openai' | 'anthropic'; draftModel?: string },
): {
  service: EngagementAiService;
  captured: () => { provider: string; model: string } | null;
} {
  let last: { provider: string; model: string } | null = null;
  const service = Object.create(EngagementAiService.prototype) as EngagementAiService;
  const patch = service as unknown as Record<string, unknown>;
  patch.outreachPromptSpec = 'v1'; // keep the assembly path simple
  // No cfg → the configured D2 flip (out-of-band env). cfg given → use as-is,
  // so the neutral-default case can pass undefined/'' (see below).
  patch.outreachProvider = cfg ? cfg.provider : 'anthropic';
  patch.outreachDraftModel = cfg ? (cfg.draftModel ?? '') : 'claude-sonnet-4-6';
  patch.credentials = { resolveOrder: async () => creds };
  patch.llm = {
    complete: async (req: { provider: string; model: string }) => {
      last = { provider: req.provider, model: req.model };
      return {
        text: '{"subject":"s","body":"b","contextNote":""}',
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
        truncated: false,
        raw: {},
      };
    },
  };
  // No federal enrichment in this unit (keeps it hermetic).
  patch.buildFederalContextBlock = async () => '';
  return { service, captured: () => last };
}

const anthropic = (over?: Partial<ResolvedAiCredential>): ResolvedAiCredential => ({
  provider: 'anthropic',
  apiKey: 'k',
  model: 'claude-haiku-4-5-20251001', // global default; outreach should override
  usedTenantKey: false,
  modelOverridden: false,
  ...over,
});
const openai = (over?: Partial<ResolvedAiCredential>): ResolvedAiCredential => ({
  provider: 'openai',
  apiKey: 'k',
  model: 'gpt-4.1-mini',
  usedTenantKey: false,
  modelOverridden: false,
  ...over,
});

describe('outreach model tier (W3.2)', () => {
  test('Anthropic outreach uses OUTREACH_DRAFT_MODEL, not the global default', async () => {
    const { service, captured } = makeService([anthropic()]);
    await service.generateOutreachDraft(INPUT, ctx);
    expect(captured()).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  test('a tenant modelOverride (BYOK) always wins over the draft model', async () => {
    const { service, captured } = makeService([
      anthropic({ model: 'claude-opus-4-8', modelOverridden: true, usedTenantKey: true }),
    ]);
    await service.generateOutreachDraft(INPUT, ctx);
    expect(captured()).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8' });
  });

  test('provider preference puts Anthropic first even when OpenAI resolves first', async () => {
    const { service, captured } = makeService([openai(), anthropic()]);
    await service.generateOutreachDraft(INPUT, ctx);
    expect(captured()!.provider).toBe('anthropic');
    expect(captured()!.model).toBe('claude-sonnet-4-6');
  });

  test('an OpenAI-only tenant keeps the OpenAI default model (no Anthropic override)', async () => {
    const { service, captured } = makeService([openai()]);
    await service.generateOutreachDraft(INPUT, ctx);
    expect(captured()).toEqual({ provider: 'openai', model: 'gpt-4.1-mini' });
  });

  // The critical safety property: with the DEFAULT (unset) config, a deploy must
  // not change the drafting model or provider order — the D2 flip is opt-in.
  test('behavior-neutral defaults: no provider preference, no model override', async () => {
    const { service, captured } = makeService([openai(), anthropic()], {
      provider: undefined,
      draftModel: '',
    });
    await service.generateOutreachDraft(INPUT, ctx);
    // No Anthropic-first reorder → the resolver's first cred (openai) is used,
    // with its own model — exactly today's behavior.
    expect(captured()).toEqual({ provider: 'openai', model: 'gpt-4.1-mini' });
  });

  test('behavior-neutral defaults: Anthropic cred keeps its resolved model (no sonnet override)', async () => {
    const { service, captured } = makeService([anthropic()], {
      provider: undefined,
      draftModel: '',
    });
    await service.generateOutreachDraft(INPUT, ctx);
    expect(captured()).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' });
  });
});
