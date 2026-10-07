import { Test } from '@nestjs/testing';
import type { INestApplication, ExecutionContext } from '@nestjs/common';
import request from 'supertest';
import { PlannerController } from './planner.controller.js';
import { PlannerAttachmentsController } from './planner-attachments.controller.js';
import { PlannerPublicController } from './planner-public.controller.js';
import { PlannerService } from './planner.service.js';
import { PlannerAttachmentsService } from './planner-attachments.service.js';
import { TenantGuard } from '../auth/tenant.guard.js';
const ID = '30000000-0000-4000-8000-000000000001';
const ctx = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  clerkUserId: 'user_http_qa',
  role: 'org:member',
};
/** Contract tests replace JWT verification only. Real grant/storage tests live in planner.db.int-spec.ts. */
describe('Planner HTTP routing and tenant guard coverage', () => {
  let app: INestApplication;
  const planner = {
    bootstrap: jest.fn(async () => ({
      me: { id: ctx.clerkUserId, name: 'QA' },
      people: [],
      projects: [],
    })),
    tasks: jest.fn(async () => ({ items: [], nextCursor: null })),
    task: jest.fn(async () => ({ id: ID })),
    saveTask: jest.fn(async () => ({ id: ID, version: 2 })),
    importTask: jest.fn(async () => ({ id: ID, actualMinutes: 90 })),
    saveProject: jest.fn(async () => ({ id: ID })),
    resources: jest.fn(async () => []),
    reportWidget: jest.fn(async () => ({ buckets: [], total: 0, matched: 0, dashboardVersion: 1 })),
    saveResource: jest.fn(async () => ({ id: ID })),
    instantiateTemplate: jest.fn(async () => ({ id: ID })),
    submitForm: jest.fn(async () => ({ id: ID })),
    shareForm: jest.fn(async () => ({ token: null })),
    publicForm: jest.fn(async () => ({ name: 'Intake', description: '', fields: [] })),
    submitPublicForm: jest.fn(async () => ({ received: true })),
    duplicateProject: jest.fn(async () => ({ id: ID })),
    queue: jest.fn(async () => []),
    reorderTasks: jest.fn(async () => ({ ok: true })),
    events: jest.fn(async () => []),
    addEvent: jest.fn(async () => ({ id: ID })),
    followGoal: jest.fn(async () => ({ following: true })),
    postGoalUpdate: jest.fn(async () => ({ goal: { id: ID }, event: { id: ID } })),
    reviseEvent: jest.fn(async () => ({ id: ID, version: 1 })),
    inbox: jest.fn(async () => []),
    notifications: jest.fn(async () => ({ items: [], unread: 0 })),
    readAllNotifications: jest.fn(async () => ({ read: 0 })),
    updateInbox: jest.fn(async () => ({ ok: true })),
    timeSettings: jest.fn(async () => ({ version: 0, canManage: false, reviewers: {} })),
    timer: jest.fn(async () => ({ id: ID, version: 1 })),
    timeTree: jest.fn(async () => ({
      nodes: [],
      revision: 'a'.repeat(64),
      matched: 0,
      nextCursor: null,
    })),
    startTimer: jest.fn(async () => ({ id: ID, version: 1 })),
    stopTimer: jest.fn(async () => ({ id: ID, version: 2 })),
    discardTimer: jest.fn(async () => ({ id: ID, version: 2 })),
    saveTimeSettings: jest.fn(async () => ({ ok: true })),
    timePreferences: jest.fn(async () => ({ version: 0, autoAddDueTasks: false })),
    saveTimePreferences: jest.fn(async () => ({ ok: true })),
    timesheet: jest.fn(async () => ({ items: [], matched: 0 })),
    timeReview: jest.fn(async () => []),
    timeExport: jest.fn(async () => ({ items: [], matched: 0, nextCursor: null })),
    transitionTimesheet: jest.fn(async () => ({ status: 'submitted' })),
    saveTimesheetWork: jest.fn(async () => ({ workRows: [] })),
    projectBudget: jest.fn(async () => ({ version: 0 })),
    saveProjectBudget: jest.fn(async () => ({ version: 1 })),
    saveBudgetAlert: jest.fn(async () => ({ alert: { version: 1 } })),
    portfolioBudgets: jest.fn(async () => ({ projects: [] })),
  };
  const attachments = {
    list: jest.fn(async () => []),
    upload: jest.fn(async () => ({ id: ID })),
    archive: jest.fn(async () => ({ id: ID })),
    download: jest.fn(),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PlannerController, PlannerAttachmentsController, PlannerPublicController],
      providers: [
        { provide: PlannerService, useValue: planner },
        { provide: PlannerAttachmentsService, useValue: attachments },
      ],
    })
      .overrideGuard(TenantGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest();
          if (req.headers['x-planner-qa'] !== 'allowed') return false;
          req.tenantContext = ctx;
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('strategy-api');
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  it.each([
    ['get', 'bootstrap'],
    ['get', 'queue'],
    ['get', 'time/settings'],
    ['patch', 'time/settings'],
    ['get', 'time/preferences'],
    ['patch', 'time/preferences'],
    ['get', 'timesheets'],
    ['get', 'time/entries'],
    ['get', 'timesheets/review'],
    ['post', 'timesheets/status'],
    ['post', 'timesheets/work'],
    ['post', `forms/${ID}/share`],
    ['post', `projects/${ID}/duplicate`],
    ['post', `projects/${ID}/reorder`],
    ['get', 'tasks'],
    ['get', `tasks/${ID}`],
    ['post', 'tasks'],
    ['post', 'tasks/import'],
    ['patch', `tasks/${ID}`],
    ['post', 'projects'],
    ['patch', `projects/${ID}`],
    ['get', `projects/${ID}/budget`],
    ['patch', `projects/${ID}/budget`],
    ['patch', `projects/${ID}/budget/alert`],
    ['get', `portfolios/${ID}/budgets`],
    ['get', `tasks/${ID}/events`],
    ['post', `tasks/${ID}/events`],
    ['get', `projects/${ID}/events`],
    ['post', `projects/${ID}/events`],
    ['patch', `events/${ID}`],
    ['get', `goals/${ID}/events`],
    ['post', `goals/${ID}/events`],
    ['post', `goals/${ID}/updates`],
    ['patch', `goals/${ID}/follow`],
    ['get', 'inbox'],
    ['get', 'notifications'],
    ['post', 'notifications/read-all'],
    ['patch', `inbox/${ID}`],
    ['get', 'resources'],
    ['get', `reports/${ID}/widgets/${ID}`],
    ['post', 'resources'],
    ['patch', `resources/${ID}`],
    ['post', `templates/${ID}/instantiate`],
    ['post', `forms/${ID}/submit`],
    ['get', `tasks/${ID}/attachments`],
    ['post', `tasks/${ID}/attachments`],
    ['patch', `tasks/${ID}/attachments/${ID}`],
    ['get', `tasks/${ID}/attachments/${ID}/download`],
    ['get', 'time/timer'],
    ['get', 'time/tree'],
    ['post', 'time/timers'],
    ['post', `time/timers/${ID}/stop`],
    ['post', `time/timers/${ID}/discard`],
  ])('guards %s /strategy-api/planner/%s', async (method, path) => {
    const agent = request(app.getHttpServer());
    await agent[method as 'get'](`/strategy-api/planner/${path}`).expect(403);
  });
  it('forwards activity corrections through the signed-in tenant context', async () => {
    const body = { version: 0, text: 'Corrected comment' };
    await request(app.getHttpServer())
      .patch(`/strategy-api/planner/events/${ID}`)
      .set('x-planner-qa', 'allowed')
      .send(body)
      .expect(200);
    expect(planner.reviseEvent).toHaveBeenCalledWith(ctx, ID, body);
  });
  it('routes native timer operations only through the signed-in organization context', async () => {
    const start = { startKey: ID, taskId: ID, time: { billable: true } },
      stop = { version: 1 };
    await request(app.getHttpServer())
      .get('/strategy-api/planner/time/timer')
      .set('x-planner-qa', 'allowed')
      .expect(200);
    await request(app.getHttpServer())
      .post('/strategy-api/planner/time/timers')
      .set('x-planner-qa', 'allowed')
      .send(start)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/strategy-api/planner/time/timers/${ID}/stop`)
      .set('x-planner-qa', 'allowed')
      .send(stop)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/strategy-api/planner/time/timers/${ID}/discard`)
      .set('x-planner-qa', 'allowed')
      .send(stop)
      .expect(201);
    expect(planner.timer).toHaveBeenCalledWith(ctx);
    expect(planner.startTimer).toHaveBeenCalledWith(ctx, start);
    expect(planner.stopTimer).toHaveBeenCalledWith(ctx, ID, stop);
    expect(planner.discardTimer).toHaveBeenCalledWith(ctx, ID, stop);
  });
  it('forwards a reviewed time import and caller authorization through the signed-in organization', async () => {
    const body = { importKey: ID, data: { name: 'Reviewed CSV' }, actualMinutes: 90 };
    await request(app.getHttpServer())
      .post('/strategy-api/planner/tasks/import')
      .set('x-planner-qa', 'allowed')
      .set('authorization', 'Bearer synthetic-import')
      .send(body)
      .expect(201);
    expect(planner.importTask).toHaveBeenCalledWith(ctx, body, 'Bearer synthetic-import');
  });
  it('forwards private budget operations through the signed-in organization context', async () => {
    const body = { version: 0, data: { measurement: 'time', budgetMinutes: 600 } };
    await request(app.getHttpServer())
      .get(`/strategy-api/planner/projects/${ID}/budget`)
      .set('x-planner-qa', 'allowed')
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/strategy-api/planner/projects/${ID}/budget`)
      .set('x-planner-qa', 'allowed')
      .send(body)
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/strategy-api/planner/projects/${ID}/budget/alert`)
      .set('x-planner-qa', 'allowed')
      .send(body)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/strategy-api/planner/portfolios/${ID}/budgets`)
      .set('x-planner-qa', 'allowed')
      .expect(200);
    expect(planner.projectBudget).toHaveBeenCalledWith(ctx, ID);
    expect(planner.saveProjectBudget).toHaveBeenCalledWith(ctx, ID, body);
    expect(planner.saveBudgetAlert).toHaveBeenCalledWith(ctx, ID, body);
    expect(planner.portfolioBudgets).toHaveBeenCalledWith(ctx, ID);
  });
  it('forwards date ranges and revision-bound time export pages through the signed-in context', async () => {
    const query = {
      scope: 'project',
      projectId: ID,
      fromOn: '2026-10-01',
      throughOn: '2026-10-31',
      cursor: ID,
      revision: 'a'.repeat(64),
    };
    await request(app.getHttpServer())
      .get('/strategy-api/planner/time/entries')
      .query(query)
      .set('x-planner-qa', 'allowed')
      .expect(200);
    expect(planner.timeExport).toHaveBeenCalledWith(ctx, query);
  });
  it('forwards complete time-tree scope and revision paging through the signed-in context', async () => {
    const query = {
      projectId: ID,
      taskId: ID,
      mine: 'true',
      archived: 'true',
      cursor: ID,
      revision: 'b'.repeat(64),
    };
    await request(app.getHttpServer())
      .get('/strategy-api/planner/time/tree')
      .query(query)
      .set('x-planner-qa', 'allowed')
      .expect(200);
    expect(planner.timeTree).toHaveBeenLastCalledWith(ctx, query);
  });
  it('routes weekly time and guarded status actions through the signed-in context', async () => {
    await request(app.getHttpServer())
      .get('/strategy-api/planner/timesheets')
      .query({ week: '2026-10-05', userId: 'submitter' })
      .set('x-planner-qa', 'allowed')
      .expect(200);
    expect(planner.timesheet).toHaveBeenCalledWith(ctx, {
      week: '2026-10-05',
      userId: 'submitter',
    });
    const dto = {
      week: '2026-10-05',
      userId: 'submitter',
      version: 1,
      revision: 'a'.repeat(64),
      action: 'submit',
      notes: '',
    };
    await request(app.getHttpServer())
      .post('/strategy-api/planner/timesheets/status')
      .set('x-planner-qa', 'allowed')
      .send(dto)
      .expect(201);
    expect(planner.transitionTimesheet).toHaveBeenCalledWith(ctx, dto);
  });
  it('forwards reporting drill-down cursors, category and expected version through the signed-in tenant guard', async () => {
    await request(app.getHttpServer())
      .get(`/strategy-api/planner/reports/${ID}/widgets/${ID}`)
      .query({ rows: 'true', cursor: ID, bucket: 'done', version: '2' })
      .set('x-planner-qa', 'allowed')
      .expect(200);
    expect(planner.reportWidget).toHaveBeenCalledWith(ctx, ID, ID, {
      rows: 'true',
      cursor: ID,
      bucket: 'done',
      version: '2',
    });
  });
  it('routes goal activity, structured updates and self-following through the signed-in organization', async () => {
    const agent = request(app.getHttpServer());
    await agent
      .get(`/strategy-api/planner/goals/${ID}/events?paged=true`)
      .set('x-planner-qa', 'allowed')
      .expect(200);
    expect(planner.events).toHaveBeenCalledWith(ctx, { resourceId: ID }, { paged: 'true' });
    const body = { version: 3, title: 'Goal update', status: 'on_track', sections: [] };
    await agent
      .post(`/strategy-api/planner/goals/${ID}/updates`)
      .set('x-planner-qa', 'allowed')
      .send(body)
      .expect(201);
    expect(planner.postGoalUpdate).toHaveBeenCalledWith(ctx, ID, body);
    await agent
      .patch(`/strategy-api/planner/goals/${ID}/follow`)
      .set('x-planner-qa', 'allowed')
      .send({ version: 3, following: true })
      .expect(200);
    expect(planner.followGoal).toHaveBeenCalledWith(ctx, ID, { version: 3, following: true });
  });
  it('forwards tenant identity, version patches and the requesting bearer only to link validation', async () => {
    const body = { version: 1, data: { clientId: ID, name: 'HTTP task' } };
    await request(app.getHttpServer())
      .patch(`/strategy-api/planner/tasks/${ID}`)
      .set('x-planner-qa', 'allowed')
      .set('Authorization', 'Bearer synthetic-qa-only')
      .send(body)
      .expect(200);
    expect(planner.saveTask).toHaveBeenCalledWith(ctx, ID, body, 'Bearer synthetic-qa-only');
    await request(app.getHttpServer())
      .get('/strategy-api/planner/tasks?mine=true&cursor=' + ID)
      .set('x-planner-qa', 'allowed')
      .expect(200);
    expect(planner.tasks).toHaveBeenCalledWith(ctx, { mine: 'true', cursor: ID });
  });
  it('does not expose Planner at the canonical API prefix', async () => {
    await request(app.getHttpServer())
      .get('/api/planner/bootstrap')
      .set('x-planner-qa', 'allowed')
      .expect(404);
  });
  it('forwards reviewer filters, history cursors and private saved views through guarded routes', async () => {
    const revision = 'a'.repeat(64);
    const review = {
      week: '2026-10-05',
      people: 'user_submitter',
      statuses: 'submitted',
      sort: 'total',
      direction: 'desc',
      paged: 'true',
      cursor: 'user_cursor',
      revision,
    };
    await request(app.getHttpServer())
      .get('/strategy-api/planner/timesheets/review')
      .query(review)
      .set('x-planner-qa', 'allowed')
      .expect(200);
    expect(planner.timeReview).toHaveBeenLastCalledWith(ctx, review);
    const history = { week: '2026-10-05', userId: 'user_submitter', historyCursor: ID, revision };
    await request(app.getHttpServer())
      .get('/strategy-api/planner/timesheets')
      .query(history)
      .set('x-planner-qa', 'allowed')
      .expect(200);
    expect(planner.timesheet).toHaveBeenLastCalledWith(ctx, history);
    const preferences = {
      version: 4,
      reviewView: {
        people: ['user_submitter'],
        statuses: ['submitted'],
        sort: 'billable',
        direction: 'desc',
      },
    };
    await request(app.getHttpServer())
      .patch('/strategy-api/planner/time/preferences')
      .set('x-planner-qa', 'allowed')
      .send(preferences)
      .expect(200);
    expect(planner.saveTimePreferences).toHaveBeenLastCalledWith(ctx, preferences);
  });
  it('forwards activity cursors and the archived inbox filter through guarded routes', async () => {
    await request(app.getHttpServer())
      .get(`/strategy-api/planner/tasks/${ID}/events?paged=true&cursor=${ID}`)
      .set('x-planner-qa', 'allowed')
      .expect(200);
    expect(planner.events).toHaveBeenLastCalledWith(
      ctx,
      { taskId: ID },
      { paged: 'true', cursor: ID },
    );
    await request(app.getHttpServer())
      .get(`/strategy-api/planner/projects/${ID}/events?paged=true`)
      .set('x-planner-qa', 'allowed')
      .expect(200);
    expect(planner.events).toHaveBeenLastCalledWith(ctx, { projectId: ID }, { paged: 'true' });
    await request(app.getHttpServer())
      .get(`/strategy-api/planner/inbox?paged=true&archived=true&cursor=${ID}`)
      .set('x-planner-qa', 'allowed')
      .expect(200);
    expect(planner.inbox).toHaveBeenLastCalledWith(ctx, {
      paged: 'true',
      archived: 'true',
      cursor: ID,
    });
  });
  it('rejects an unsupported impersonated tenant before reaching Planner business code', async () => {
    planner.bootstrap.mockClear();
    await request(app.getHttpServer())
      .get('/strategy-api/planner/bootstrap')
      .set('x-planner-qa', 'allowed')
      .set('x-capiro-impersonate-tenant', 'other-tenant')
      .expect(403);
    expect(planner.bootstrap).not.toHaveBeenCalled();
  });
  it('allows only the explicit anonymous form routes without the signed-in tenant guard', async () => {
    await request(app.getHttpServer())
      .get('/strategy-api/planner/public/forms/synthetic-capability')
      .expect(200);
    expect(planner.publicForm).toHaveBeenCalledWith('synthetic-capability');
    await request(app.getHttpServer())
      .post('/strategy-api/planner/public/forms/synthetic-capability')
      .send({ answer: 'Request' })
      .expect(201);
    expect(planner.submitPublicForm).toHaveBeenCalledWith(
      'synthetic-capability',
      {
        answer: 'Request',
      },
      [],
    );
  });
  it('passes multipart answers and attachment question identities through signed-in and public intake', async () => {
    for (const path of [`forms/${ID}/submit`, 'public/forms/synthetic-capability']) {
      const call = request(app.getHttpServer()).post(`/strategy-api/planner/${path}`);
      if (!path.startsWith('public')) call.set('x-planner-qa', 'allowed');
      await call
        .field('answers', JSON.stringify({ answer: 'Synthetic request' }))
        .attach(ID, Buffer.from('synthetic'), 'example.txt')
        .expect(201);
    }
    const files = expect.arrayContaining([
      expect.objectContaining({
        fieldname: ID,
        originalname: 'example.txt',
        size: 9,
        buffer: Buffer.from('synthetic'),
      }),
    ]);
    expect(planner.submitForm).toHaveBeenLastCalledWith(
      ctx,
      ID,
      { answers: '{"answer":"Synthetic request"}' },
      files,
    );
    expect(planner.submitPublicForm).toHaveBeenLastCalledWith(
      'synthetic-capability',
      { answers: '{"answer":"Synthetic request"}' },
      files,
    );
  });
  it('rejects excess files and fields, and checks a revoked capability before accepting uploads', async () => {
    const files = request(app.getHttpServer())
      .post('/strategy-api/planner/public/forms/synthetic-capability')
      .field('answers', '{}');
    for (let index = 0; index < 11; index++) files.attach(ID, Buffer.from('one'), `${index}.txt`);
    await files.expect(400);
    await request(app.getHttpServer())
      .post('/strategy-api/planner/public/forms/synthetic-capability')
      .field('answers', '{}')
      .field('unexpected', 'extra')
      .expect(400);
    planner.publicForm.mockRejectedValueOnce(
      new (await import('@nestjs/common')).NotFoundException(),
    );
    planner.submitPublicForm.mockClear();
    await request(app.getHttpServer())
      .post('/strategy-api/planner/public/forms/revoked')
      .attach(ID, Buffer.from('one'), 'one.txt')
      .expect(404);
    expect(planner.submitPublicForm).not.toHaveBeenCalled();
  });
});
