import { MeriRegistryService } from './meri-registry.service';
import type { ApiClientContextRepo } from './api-client-context.repo';
import type { ApiToolExecutorRepo } from './api-tool-executor.repo';
import type { ConfigService } from '@nestjs/config';

describe('MeriRegistryService', () => {
  const fakeRepo = {
    loadClientContext: async () => ({ client: { id: 'c', name: 'n' } }),
  } as unknown as ApiClientContextRepo;
  const fakeExecutor = { execute: async () => ({ ok: true }) } as unknown as ApiToolExecutorRepo;
  const make = (config: ConfigService) => new MeriRegistryService(fakeRepo, fakeExecutor, config);

  it('registers the get_client_context migration-template tool', () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    expect(make(config).registry.list()).toContain('get_client_context');
  });

  it('registers hearing reasoning tools when ANTHROPIC_API_KEY is set', () => {
    const config = {
      get: (k: string) => (k === 'ANTHROPIC_API_KEY' ? 'sk-test' : undefined),
    } as unknown as ConfigService;
    const svc = make(config);
    expect(svc.registry.list()).toContain('tag_live_policy_mentions');
    expect(svc.registry.list()).toContain('generate_post_hearing_summary');
  });

  it('registers hearing tools even with NO global key (BYOK2: tenant key may arrive per-request)', () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const svc = make(config);
    expect(svc.registry.list()).toContain('tag_live_policy_mentions');
    expect(svc.registry.list()).toContain('generate_post_hearing_summary');
  });

  it('registers the delegated read-only tool surface (Workstream C)', () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const list = make(config).registry.list();
    // A sample of the delegated read tools + the count sanity (24 catalog tools,
    // get_client_context registered natively once → 24 unique names total).
    expect(list).toContain('search_congress_bills');
    expect(list).toContain('search_lda_filings');
    expect(list).toContain('get_pe_budget_timeline');
    expect(list).toContain('query_economic_data');
    // get_client_context is registered exactly once (native), not duplicated.
    expect(list.filter((n) => n === 'get_client_context')).toHaveLength(1);
    // No write tool leaked into the registry.
    expect(list).not.toContain('send_email');
    expect(list).not.toContain('update_client_profile');
  });
});
