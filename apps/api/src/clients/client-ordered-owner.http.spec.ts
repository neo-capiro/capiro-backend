import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ClientOrderedOwnerController } from './client-ordered-owner.controller.js';
import { ClientOrderedOwnerService } from './client-ordered-owner.service.js';
import { ClientAccountOwnerController } from './client-account-owner.controller.js';
import { ClientAccountOwnerService } from './client-account-owner.service.js';
import { setup, ctx, client, ids } from './client-ordered-owner.test-support.js';

describe('ordered and legacy owner HTTP boundary', () => {
  let app: INestApplication;
  let fixture: ReturnType<typeof setup>;
  beforeEach(async () => {
    fixture = setup();
    const module = await Test.createTestingModule({
      controllers: [ClientOrderedOwnerController, ClientAccountOwnerController],
      providers: [
        { provide: ClientOrderedOwnerService, useValue: fixture.service },
        {
          provide: ClientAccountOwnerService,
          useValue: new ClientAccountOwnerService(fixture.prisma as never, fixture.service),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    app.use((req: any, _res: any, next: () => void) => {
      if (req.headers['x-synthetic-role'])
        req.tenantContext = { ...ctx, role: req.headers['x-synthetic-role'] };
      next();
    });
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });
  const path = `/api/clients/${client}/account-owners`;
  test('saves/readbacks four ranks and returns typed conflict to the legacy editor', async () => {
    const result = await request(app.getHttpServer())
      .put(path)
      .set('x-synthetic-role', 'user_admin')
      .send({ expectedVersion: 0, userIds: ids.slice(0, 4) })
      .expect(200);
    expect(result.body.version).toBe(1);
    const read = await request(app.getHttpServer())
      .get(path)
      .set('x-synthetic-role', 'standard_user')
      .expect(200);
    expect(read.body).toEqual(result.body);
    const conflict = await request(app.getHttpServer())
      .put(`/api/client-account-owners/${client}`)
      .set('x-synthetic-role', 'user_admin')
      .send({ accountOwnerUserId: ids[1] })
      .expect(409);
    expect(conflict.body.code).toBe('ordered_owners_required');
    expect(fixture.state.owners).toEqual(ids.slice(0, 4));
  });
  test.each([undefined, 'standard_user', 'unknown'])(
    'rejects unauthorized role %s before replacement',
    async (role) => {
      const req = request(app.getHttpServer()).put(path);
      if (role) req.set('x-synthetic-role', role);
      await req.send({ expectedVersion: 0, userIds: [] }).expect(403);
      expect(fixture.tx.$executeRaw).not.toHaveBeenCalled();
    },
  );
  test('rejects unknown body fields despite unknown-type controller boundary', async () => {
    await request(app.getHttpServer())
      .put(path)
      .set('x-synthetic-role', 'user_admin')
      .send({ expectedVersion: 0, userIds: [], tenantId: ctx.tenantId })
      .expect(400);
  });
  test('legacy successful write changes ranked version and makes an old ranked draft stale', async () => {
    await request(app.getHttpServer())
      .put(`/api/client-account-owners/${client}`)
      .set('x-synthetic-role', 'user_admin')
      .send({ accountOwnerUserId: ids[0] })
      .expect(200);
    const result = await request(app.getHttpServer())
      .put(path)
      .set('x-synthetic-role', 'user_admin')
      .send({ expectedVersion: 0, userIds: [ids[1]] })
      .expect(409);
    expect(result.body.code).toBe('owner_version_changed');
  });
});
