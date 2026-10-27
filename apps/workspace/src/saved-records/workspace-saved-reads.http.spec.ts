import 'reflect-metadata';
// Constructor tokens only. The existing 29 adapter/actual-owner cases cover
// ACL and saved data. This fixture exercises real Nest routing + TenantGuard.
jest.mock('../documents/documents.service.js', () => ({ DocumentsService: class {} }));
jest.mock('../versions/versions.service.js', () => ({ VersionsService: class {} }));
jest.mock('../comments/comments.service.js', () => ({ CommentsService: class {} }));
jest.mock('../hillday/hillday-document.service.js', () => ({ HillDayDocumentService: class {} }));
jest.mock('../newsletters/newsletter.service.js', () => ({ NewsletterService: class {} }));
import { EventEmitter } from 'node:events';
import { Test } from '@nestjs/testing';
import { ClerkService, ORG_TENANT_RESOLVER, TenantGuard } from '@capiro/auth';
import { DocumentsService } from '../documents/documents.service.js';
import { VersionsService } from '../versions/versions.service.js';
import { CommentsService } from '../comments/comments.service.js';
import { HillDayDocumentService } from '../hillday/hillday-document.service.js';
import { NewsletterService } from '../newsletters/newsletter.service.js';
import { WorkspaceSavedReadsController } from './workspace-saved-reads.controller.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const draftId = '22222222-2222-4222-8222-222222222222';
const versionId = '33333333-3333-4333-8333-333333333333';

async function fixture() {
  const state = { member: true, tenantClaim: tenantId, verify: true };
  const getSaved = jest.fn(async () => ({
    id: versionId,
    label: null,
    authorId: 'user_author',
    authorKind: 'person',
    createdAt: new Date('2026-10-27T00:00:00Z'),
    snapshot: { documents: [{ body: '完整 saved' }] },
  }));
  const module = await Test.createTestingModule({
    controllers: [WorkspaceSavedReadsController],
    providers: [
      TenantGuard,
      {
        provide: ClerkService,
        useValue: {
          verifySessionToken: jest.fn(async () => {
            if (!state.verify) throw new Error('invalid');
            return {
              sub: 'user_current',
              org_id: 'org_current',
              capiro_tenant_id: state.tenantClaim,
            };
          }),
        },
      },
      {
        provide: ORG_TENANT_RESOLVER,
        useValue: {
          resolveByClerkOrgId: async () => ({
            tenantId,
            clerkOrgId: 'org_current',
            slug: 'fixture',
          }),
          resolveByTenantId: async () => null,
          hasActiveMembership: async () => state.member,
        },
      },
      { provide: VersionsService, useValue: { getSaved } },
      ...[DocumentsService, CommentsService, HillDayDocumentService, NewsletterService].map(
        (provide) => ({ provide, useValue: {} }),
      ),
    ],
  }).compile();
  const app = module.createNestApplication({ logger: ['error'] });
  app.setGlobalPrefix('workspace-api');
  await app.init(); // No listen/socket. Invoke the actual Nest route proxy.
  const layer = app
    .getHttpAdapter()
    .getInstance()
    ._router.stack.find((item: any) => item.route?.path === '/workspace-api/saved-records/read');
  const send = async (
    body: unknown = { kind: 'saved_version', draftId, versionId },
    authorization?: string,
  ) => {
    const response: any = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: {} as Record<string, string>,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader(key: string, value: string) {
        this.headers[key] = value;
        return this;
      },
      set(key: string, value: string) {
        return this.setHeader(key, value);
      },
      getHeader(key: string) {
        return this.headers[key];
      },
      json(value: unknown) {
        this.body = value;
        return this;
      },
      send(value: unknown) {
        return this.json(value);
      },
    });
    const request = {
      method: 'POST',
      url: '/workspace-api/saved-records/read',
      body,
      headers: {
        ...(authorization ? { authorization } : {}),
        'x-internal-service-secret': 'cannot-grant-user-authority',
      },
    };
    await layer.route.stack[0].handle(request, response, () => {});
    return response;
  };
  return { app, send, state, getSaved };
}

describe('Workspace saved read authenticated mount', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    await f.app.close();
  });
  it('passes only the freshly verified tenant/actor to exact saved-version owner and preserves snapshot', async () => {
    const result = await f.send(undefined, 'Bearer synthetic');
    expect(result.statusCode).toBe(200);
    expect(result.headers['Cache-Control']).toBe('private, no-store');
    expect(f.getSaved).toHaveBeenCalledWith(tenantId, draftId, versionId, 'user_current');
    expect(result.body.data).toMatchObject({
      draftId,
      versionId,
      snapshot: { documents: [{ body: '完整 saved' }] },
    });
  });
  it.each(['missing-session', 'invalid-session', 'inactive-member', 'mismatched-tenant'])(
    'refuses %s before owner reads despite a service header',
    async (reason) => {
      if (reason === 'invalid-session') f.state.verify = false;
      if (reason === 'inactive-member') f.state.member = false;
      if (reason === 'mismatched-tenant') f.state.tenantClaim = draftId;
      const result = await f.send(
        undefined,
        reason === 'missing-session' ? undefined : 'Bearer synthetic',
      );
      expect(result.statusCode).toBe(reason.includes('session') ? 401 : 403);
      expect(f.getSaved).not.toHaveBeenCalled();
    },
  );
  it('rejects input actor/tenant claims instead of replacing guard context', async () => {
    const result = await f.send(
      { kind: 'saved_version', draftId, versionId, tenantId, clerkUserId: 'user_other' },
      'Bearer synthetic',
    );
    expect(result.statusCode).toBe(400);
    expect(f.getSaved).not.toHaveBeenCalled();
  });
});
