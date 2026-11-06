import { main, parseImpactRefreshArgs } from './refresh-legiwatch-impact.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ImpactRefreshRepository } from '../src/legiwatch-impact/impact-refresh.repository.js';
import { currentDbLane } from '../src/prisma/db-lane.js';

const env = { DATABASE_URL: 'postgresql://localhost/synthetic', LEGIWATCH_AGENT_PROVIDER: 'bedrock', LEGIWATCH_AGENT_MODEL: 'synthetic-model' };

describe('LegiWatch refresh entrypoint', () => {
  it('imports safely and handles help without configuration or resource allocation', async () => {
    const create = jest.fn(), log = jest.fn();
    expect(await main(['--help'], { env: {}, create, log })).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(log.mock.calls[0]?.[0]).toContain('Exit codes:');
  });
  it.each([[], ['--unknown'], ['--limit'], ['--limit', '0'], ['--limit', '101'], ['--limit', '1', '--limit', '2'], ['--discovery-limit', '1001']].map(args => ({ args })))(
    'rejects missing config or invalid argv $args before allocation', async ({ args }) => {
      const create = jest.fn();
      expect(await main(args, { env: {}, create, log: jest.fn() })).toBe(2);
      expect(create).not.toHaveBeenCalled();
    });
  it('requires explicit provider/model, validates provider secrets and the full cycle budget', () => {
    expect(() => parseImpactRefreshArgs([], { ...env, LEGIWATCH_AGENT_PROVIDER: '' })).toThrow();
    expect(() => parseImpactRefreshArgs([], { ...env, LEGIWATCH_AGENT_MODEL: '' })).toThrow();
    expect(() => parseImpactRefreshArgs([], { ...env, LEGIWATCH_AGENT_PROVIDER: 'anthropic' })).toThrow();
    expect(() => parseImpactRefreshArgs([], { ...env, LEGIWATCH_AGENT_MAX_BUDGET_USD: '3' })).toThrow();
    expect(() => parseImpactRefreshArgs([], { ...env, LEGIWATCH_IMPACT_REFRESH_TIMEOUT_MS: '150000' })).toThrow();
    expect(parseImpactRefreshArgs(['--limit', '5'], env)).toEqual({ limit: 5, discoveryLimit: 100, timeoutMs: 240000, analysisTimeoutMs: 90000 });
  });
  it.each([false, true])('closes owned resources after execution (fails=%s)', async fails => {
    const close = jest.fn().mockResolvedValue(undefined);
    const run = fails ? jest.fn().mockRejectedValue(new Error('synthetic')) : jest.fn().mockResolvedValue({ checked: 0 });
    expect(await main([], { env, create: async () => ({ run, close }), log: jest.fn() })).toBe(fails ? 1 : 0);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('constructs the actual minimal Nest graph with explicit injection and closes it without live services', async () => {
    const init = jest.spyOn(PrismaService.prototype, 'onModuleInit').mockResolvedValue(undefined);
    const close = jest.spyOn(PrismaService.prototype, 'onModuleDestroy').mockResolvedValue(undefined);
    const discover = jest.spyOn(ImpactRefreshRepository.prototype, 'discover').mockImplementation(async () => {
      expect(currentDbLane()).toBe('background'); return 0;
    });
    const claim = jest.spyOn(ImpactRefreshRepository.prototype, 'claim').mockResolvedValue(null);
    try {
      expect(await main([], { env, log: jest.fn() })).toBe(0);
      expect(discover).toHaveBeenCalledWith(100);
      expect(claim).toHaveBeenCalled();
      expect(init).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally { init.mockRestore(); close.mockRestore(); discover.mockRestore(); claim.mockRestore(); }
  });
});
