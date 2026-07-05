import { MeriRegistryService } from './meri-registry.service';
import type { ApiClientContextRepo } from './api-client-context.repo';
import type { ConfigService } from '@nestjs/config';

describe('MeriRegistryService', () => {
  const fakeRepo = {
    loadClientContext: async () => ({ client: { id: 'c', name: 'n' } }),
  } as unknown as ApiClientContextRepo;

  it('registers the get_client_context migration-template tool', () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const svc = new MeriRegistryService(fakeRepo, config);
    expect(svc.registry.list()).toContain('get_client_context');
  });

  it('registers hearing reasoning tools when ANTHROPIC_API_KEY is set', () => {
    const config = {
      get: (k: string) => (k === 'ANTHROPIC_API_KEY' ? 'sk-test' : undefined),
    } as unknown as ConfigService;
    const svc = new MeriRegistryService(fakeRepo, config);
    expect(svc.registry.list()).toContain('tag_live_policy_mentions');
    expect(svc.registry.list()).toContain('generate_post_hearing_summary');
  });

  it('registers hearing tools even with NO global key (BYOK2: tenant key may arrive per-request)', () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const svc = new MeriRegistryService(fakeRepo, config);
    // BYOK2 changed this deliberately: the request-scoped LLM client resolves a
    // caller-passed tenant credential at call time, so a tenant-key-only
    // deployment still serves the tools; with neither key the call throws and
    // intel-api degrades gracefully.
    expect(svc.registry.list()).toContain('tag_live_policy_mentions');
    expect(svc.registry.list()).toContain('generate_post_hearing_summary');
  });
});
