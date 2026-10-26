import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { WorkspaceCollabController } from './workspace-collab.controller.js';
import { WorkspaceCollabEmailService } from './workspace-collab-email.service.js';
import { RolesGuard } from '../auth/roles.guard.js';
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));

const draftId = '22222222-2222-4222-8222-222222222222', invitationId = '33333333-3333-4333-8333-333333333333';
describe('ordinary invitation request/status/cancel receiver', () => {
  let app: any;
  const context = { tenantId: '11111111-1111-4111-8111-111111111111', clerkUserId: 'authenticated-owner', role: 'standard_user' };
  const email = { sendInvite: jest.fn(), status: jest.fn(), cancel: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [WorkspaceCollabController], providers: [
      { provide: WorkspaceCollabEmailService, useValue: email },
    ] }).overrideGuard(RolesGuard).useValue({ canActivate: () => true }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api');
    app.use((req: any, _res: any, next: () => void) => { req.tenantContext = context; next(); });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });
  afterAll(async () => app.close());
  afterEach(() => jest.clearAllMocks());
  it('binds the authenticated actor and saved UUIDs through all mounted routes', async () => {
    email.sendInvite.mockResolvedValue({ status: 'accepted', providerMessageId: 'ses-only' });
    await request(app.getHttpServer()).post('/api/workspace/collaborator-invite-email').send({ draftId, invitationId }).expect(201);
    expect(email.sendInvite).toHaveBeenCalledWith(context, { draftId, invitationId });
    await request(app.getHttpServer()).get(`/api/workspace/drafts/${draftId}/collaborator-invite-email/${invitationId}`).expect(200);
    expect(email.status).toHaveBeenCalledWith(context, { draftId, invitationId });
    await request(app.getHttpServer()).post(`/api/workspace/drafts/${draftId}/collaborator-invite-email/${invitationId}/cancel`).expect(201);
    expect(email.cancel).toHaveBeenCalledWith(context, { draftId, invitationId });
  });
  it('rejects the removed raw-mail DTO and malformed path/body identities', async () => {
    await request(app.getHttpServer()).post('/api/workspace/collaborator-invite-email').send({ toEmail: 'raw@example.test', draftTitle: 'raw', role: 'editor', link: 'https://raw.test' }).expect(400);
    await request(app.getHttpServer()).post('/api/workspace/collaborator-invite-email').send({ draftId, invitationId, toEmail: 'raw@example.test' }).expect(400);
    await request(app.getHttpServer()).get(`/api/workspace/drafts/not-a-uuid/collaborator-invite-email/${invitationId}`).expect(400);
    expect(email.sendInvite).not.toHaveBeenCalled(); expect(email.status).not.toHaveBeenCalled();
  });
});
