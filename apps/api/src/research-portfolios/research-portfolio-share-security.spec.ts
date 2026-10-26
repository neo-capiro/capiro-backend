import { ResearchPortfolioSharePublicController } from './research-portfolio-share.controller.js';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';

jest.mock('@clerk/backend', () => ({
  __esModule: true,
  createClerkClient: () => ({}),
  verifyToken: async () => ({}),
}));

describe('public share transport boundary', () => {
  it('admits the exact public route without logging its capability path or resolving a session', async () => {
    const clerk: any = { verifySessionToken: jest.fn() };
    const prisma: any = { withSystem: jest.fn() };
    const middleware = new TenantContextMiddleware(clerk, prisma, {} as any);
    const log = jest.spyOn((middleware as any).logger, 'log').mockImplementation(() => {});
    const next = jest.fn();
    await middleware.use(
      {
        method: 'GET',
        headers: {},
        path: '/api/public/research-share/synthetic-secret',
        originalUrl: '/api/public/research-share/synthetic-secret',
        baseUrl: '',
      } as any,
      { setHeader: jest.fn() } as any,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(clerk.verifySessionToken).not.toHaveBeenCalled();
    expect(prisma.withSystem).not.toHaveBeenCalled();
  });
  it('uses Express proxy authority instead of a caller-supplied forwarded prefix', async () => {
    const share: any = { verifyPin: jest.fn().mockResolvedValue({}) };
    const controller = new ResearchPortfolioSharePublicController(share);
    await controller.verifyPin('synthetic-token', { pin: '123456' }, {
      headers: { 'x-forwarded-for': 'spoofed, proxy' },
      ip: 'transport-peer',
    } as any);
    expect(share.verifyPin).toHaveBeenCalledWith('synthetic-token', '123456', 'transport-peer');
  });
  it.each(['availability', 'verifyPin', 'dashboard'] as const)(
    'marks %s responses non-cacheable with no referrer',
    (method) => {
      const headers = Reflect.getMetadata(
        '__headers__',
        ResearchPortfolioSharePublicController.prototype[method],
      );
      expect(headers).toEqual(
        expect.arrayContaining([
          { name: 'Cache-Control', value: 'no-store' },
          { name: 'Referrer-Policy', value: 'no-referrer' },
        ]),
      );
    },
  );
});
