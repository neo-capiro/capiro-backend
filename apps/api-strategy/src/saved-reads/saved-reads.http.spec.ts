import { Test } from '@nestjs/testing';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TenantGuard } from '../auth/tenant.guard.js';
import { PlannerContextGuard } from '../planner/planner-context.guard.js';
import { PlannerLinksService } from '../planner/planner-links.service.js';
import { PlannerService } from '../planner/planner.service.js';
import { StrategyFlagsService } from '../flags/strategy-flags.service.js';
import { SavedHistoryService } from './saved-history.service.js';
import { SavedReadsService } from './saved-reads.service.js';
import { SavedReadsController } from './saved-reads.controller.js';

const clientId = '00000000-0000-4000-8000-000000000010';
describe('mounted selected-client saved read route', () => {
  let app: INestApplication;
  let current = true;
  const links = { validate: jest.fn(async () => {}) };
  const planner = {
    savedProjects: jest.fn(async () => ({
      items: [
        {
          id: '00000000-0000-4000-8000-000000000020',
          name: 'Saved project',
          clientId,
        },
      ],
      nextCursor: null,
    })),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SavedReadsController],
      providers: [
        SavedReadsService,
        PlannerContextGuard,
        { provide: PlannerService, useValue: planner },
        { provide: PlannerLinksService, useValue: links },
        { provide: SavedHistoryService, useValue: { read: jest.fn() } },
        { provide: StrategyFlagsService, useValue: { isEnabled: async () => true } },
      ],
    })
      .overrideGuard(TenantGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          context.switchToHttp().getRequest().tenantContext = {
            tenantId: '00000000-0000-4000-8000-000000000001',
            clerkUserId: 'user_synthetic',
            role: 'standard_user',
          };
          return current;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('strategy-api');
    await app.init();
  });
  beforeEach(() => {
    current = true;
    jest.clearAllMocks();
  });
  afterAll(async () => app.close());

  it('mounts the read POST with no-store and passes only the authenticated owner context/bearer', async () => {
    const response = await request(app.getHttpServer())
      .post('/strategy-api/saved-reads')
      .set('authorization', 'Bearer synthetic-only')
      .send({ kind: 'planner_projects', clientId })
      .expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body.items[0].record.name).toBe('Saved project');
    expect(links.validate).toHaveBeenCalledTimes(2);
    expect(links.validate).toHaveBeenCalledWith({ clientId }, 'Bearer synthetic-only');
    expect(planner.savedProjects).toHaveBeenCalledWith(
      expect.objectContaining({ clerkUserId: 'user_synthetic' }),
      { clientId, archived: 'false', cursor: undefined },
    );
  });
  it('refuses tenant impersonation with the actual PlannerContextGuard', async () => {
    await request(app.getHttpServer())
      .post('/strategy-api/saved-reads')
      .set('x-capiro-impersonate-tenant', 'other')
      .send({ kind: 'planner_projects', clientId })
      .expect(403);
    expect(links.validate).not.toHaveBeenCalled();
    expect(planner.savedProjects).not.toHaveBeenCalled();
  });
  it('requires current authentication before dispatch', async () => {
    current = false;
    await request(app.getHttpServer())
      .post('/strategy-api/saved-reads')
      .send({ kind: 'planner_projects', clientId })
      .expect(403);
    expect(links.validate).not.toHaveBeenCalled();
  });
  it('refuses caller authority fields and commands before owner work', async () => {
    for (const extra of [{ tenantId: clientId }, { scope: 'general' }, { kind: 'task.update' }])
      await request(app.getHttpServer())
        .post('/strategy-api/saved-reads')
        .send({ kind: 'planner_projects', clientId, ...extra })
        .expect(400);
    expect(links.validate).not.toHaveBeenCalled();
    expect(planner.savedProjects).not.toHaveBeenCalled();
  });
});
