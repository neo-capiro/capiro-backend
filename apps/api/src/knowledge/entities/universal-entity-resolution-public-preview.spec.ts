import { UniversalEntityResolutionOrchestratorService } from './universal-entity-resolution-orchestrator.service.js';
describe('read-only public source preview', () => {
  it('uses only the existing public search source and never resolves, registers or runs the legacy model provider', async () => {
    const resolver = { preview: jest.fn(), resolve: jest.fn() },
      registration = { registerGlobalPublicEntity: jest.fn() };
    const web = {
      stage: 'public_web' as const,
      lookup: jest
        .fn()
        .mockResolvedValue({ stage: 'public_web', sourceStatus: 'complete', candidates: [] }),
    };
    const model = { stage: 'model_candidate_reconciliation' as const, lookup: jest.fn() };
    const service = new UniversalEntityResolutionOrchestratorService(
      resolver as never,
      registration as never,
      [web, model],
    );
    expect(
      await service.previewPublicSources('tenant-one', {
        query: 'Fixture Company',
        entityTypeHint: 'organization',
      }),
    ).toMatchObject({ sourceStatus: 'complete' });
    expect(web.lookup).toHaveBeenCalledTimes(1);
    expect(model.lookup).not.toHaveBeenCalled();
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(registration.registerGlobalPublicEntity).not.toHaveBeenCalled();
  });
});
