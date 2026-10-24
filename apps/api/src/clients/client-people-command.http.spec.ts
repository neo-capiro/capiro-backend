import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ClientPeopleController } from './client-people.controller.js';
import { ClientPeopleService } from './client-people.service.js';
import { ctx, IDs } from '../../test/support/activity-command.fixture.js';

describe('contact create request HTTP boundary', () => {
  let app: INestApplication;
  const service = {
    createPerson: jest.fn(async () => ({ status: 'completed' })),
    readCreation: jest.fn(async () => ({ status: 'completed' })),
  };
  const path = `/api/clients/${IDs.client}/people`;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ClientPeopleController],
      providers: [{ provide: ClientPeopleService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.use(
      (
        req: { headers: Record<string, string>; tenantContext?: typeof ctx },
        _res: unknown,
        next: () => void,
      ) => {
        if (req.headers['x-qa-auth'] === 'yes') req.tenantContext = ctx;
        next();
      },
    );
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => jest.clearAllMocks());
  it('passes the exact request and authenticated context to the existing owner', async () => {
    const input = {
      requestId: IDs.request,
      name: 'Synthetic contact',
      email: null,
      lastContact: null,
    };
    await request(app.getHttpServer()).post(path).set('x-qa-auth', 'yes').send(input).expect(201);
    expect(service.createPerson).toHaveBeenCalledWith(ctx, IDs.client, input);
    await request(app.getHttpServer())
      .get(`${path}/requests/${IDs.request}`)
      .set('x-qa-auth', 'yes')
      .expect(200);
    expect(service.readCreation).toHaveBeenCalledWith(ctx, IDs.client, IDs.request);
  });
  it.each([
    { name: 'Missing key' },
    { requestId: 'bad', name: 'Bad key' },
    { requestId: IDs.request, name: 'Extra fields', actorUserId: IDs.actor },
  ])('rejects malformed or caller-authored identity before create', async (input) => {
    await request(app.getHttpServer()).post(path).set('x-qa-auth', 'yes').send(input).expect(400);
    expect(service.createPerson).not.toHaveBeenCalled();
  });
  it('requires authorization for both create and result lookup', async () => {
    await request(app.getHttpServer())
      .post(path)
      .send({ requestId: IDs.request, name: 'Synthetic' })
      .expect(403);
    await request(app.getHttpServer()).get(`${path}/requests/${IDs.request}`).expect(403);
    expect(service.createPerson).not.toHaveBeenCalled();
    expect(service.readCreation).not.toHaveBeenCalled();
  });
});
