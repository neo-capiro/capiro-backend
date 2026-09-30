import { MeriToolsService } from '../meri/meri-tools.service.js';
import { isResearchPortfolioMeriTool } from './research-portfolio-meri-tools.service.js';
const ctx: any = { tenantId: 'owned-tenant', userId: 'owned-actor' };
describe('Research Portfolio Meri dark rollout', () => {
  const original = process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED;
    else process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED = original;
  });
  const service = () =>
    Object.assign(Object.create(MeriToolsService.prototype), {
      researchPortfolioTools: { execute: jest.fn(async () => ({ owned: true })) },
    });
  const schemas = (s: MeriToolsService, value?: string) =>
    s.anthropicToolSchemas({
      tenantId: ctx.tenantId,
      surface: 'chat',
      env: value === undefined ? {} : { RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED: value },
    });
  it.each([undefined, 'false', 'TRUE'])(
    'omits all nineteen RP tools and denies dispatch unless explicitly true: %s',
    async (value) => {
      if (value === undefined) delete process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED;
      else process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED = value;
      const s = service(),
        enabled = schemas(s, 'true'),
        dark = schemas(s, value);
      const rp = enabled.filter((t) => isResearchPortfolioMeriTool(t.name));
      expect(rp).toHaveLength(19);
      expect(dark.filter((t) => isResearchPortfolioMeriTool(t.name))).toHaveLength(0);
      expect(dark).toEqual(enabled.filter((t) => !isResearchPortfolioMeriTool(t.name)));
      for (const tool of rp)
        await expect(s.execute(ctx, tool.name, {})).rejects.toThrow('Meri tool not found');
      expect(s.researchPortfolioTools.execute).not.toHaveBeenCalled();
    },
  );
  it('explicit true enables the same nineteen advertised adapters and dispatch', async () => {
    process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED = 'true';
    const s = service();
    const rp = schemas(s, 'true').filter((t) => isResearchPortfolioMeriTool(t.name));
    expect(rp).toHaveLength(19);
    for (const tool of rp)
      await expect(s.execute(ctx, tool.name, {})).resolves.toEqual({ owned: true });
    expect(s.researchPortfolioTools.execute).toHaveBeenCalledTimes(19);
  });
  it.each([undefined, 'false', 'TRUE'])(
    'rejects actual RP dispatch independently of advertisement: %s',
    async (value) => {
      if (value === undefined) delete process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED;
      else process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED = value;
      const s = service();
      await expect(s.execute(ctx, 'get_research_portfolio', {})).rejects.toThrow(
        'Meri tool not found',
      );
      expect(s.researchPortfolioTools.execute).not.toHaveBeenCalled();
    },
  );
});
