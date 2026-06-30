import { MeriRegistryService } from './meri-registry.service';
import type { ApiClientContextRepo } from './api-client-context.repo';

describe('MeriRegistryService', () => {
  it('registers the get_client_context migration-template tool', () => {
    const fakeRepo = {
      loadClientContext: async () => ({ client: { id: 'c', name: 'n' } }),
    } as unknown as ApiClientContextRepo;
    const svc = new MeriRegistryService(fakeRepo);
    expect(svc.registry.list()).toContain('get_client_context');
  });
});
