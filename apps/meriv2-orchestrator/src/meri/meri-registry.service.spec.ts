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

  it('omits hearing tools when no key is configured', () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const svc = new MeriRegistryService(fakeRepo, config);
    expect(svc.registry.list()).not.toContain('tag_live_policy_mentions');
  });
});
