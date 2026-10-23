import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { MicrosoftOAuthController } from './microsoft/microsoft-oauth.controller.js';
import { MicrosoftOAuthService } from './microsoft/microsoft-oauth.service.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { GoogleOAuthController } from './google/google-oauth.controller.js';
import { GoogleOAuthService } from './google/google-oauth.service.js';
import { GoogleTokenService } from './google/google-token.service.js';
import { GoogleSyncService } from './google/google-sync.service.js';
import { ctx, harness } from './mailbox-oauth.a1-fixture.js';

jest.mock('@azure/msal-node', () => ({ ConfidentialClientApplication: jest.fn() }));

const connectionId = '00000000-0000-4000-8000-000000000003';
describe.each(['microsoft_365', 'google_workspace'] as const)(
  'ML-08/10 direct HTTP %s',
  (provider) => {
    let app: INestApplication;
    let base: string;
    let h: ReturnType<typeof harness>;
    let providerSync: jest.Mock;
    beforeEach(async () => {
      h = harness(provider);
      jest.spyOn(h.crypto, 'decrypt');
      const row = h.rows.get('connection-A');
      row.id = connectionId;
      h.rows.delete('connection-A');
      h.rows.set(connectionId, row);
      h.service.getSuccessRedirect = () => 'https://app.invalid/integrations';
      const microsoft = provider === 'microsoft_365';
      h.tx.integrationConnection.findUnique = h.tx.integrationConnection.findFirst;
      const token: any = Object.create(GoogleTokenService.prototype);
      Object.assign(token, { prisma: h.prisma, tokenCrypto: h.crypto });
      const sync: any = Object.create(
        (microsoft ? MicrosoftGraphSyncService : GoogleSyncService).prototype,
      );
      Object.assign(sync, { prisma: h.prisma, tokenCrypto: h.crypto, googleToken: token });
      providerSync = jest.fn().mockResolvedValue({});
      sync.syncCalendar = providerSync;
      sync.syncMail = providerSync;
      const mod = await Test.createTestingModule({
        controllers: [microsoft ? MicrosoftOAuthController : GoogleOAuthController],
        providers: [
          { provide: microsoft ? MicrosoftOAuthService : GoogleOAuthService, useValue: h.service },
          { provide: microsoft ? MicrosoftGraphSyncService : GoogleSyncService, useValue: sync },
        ],
      }).compile();
      app = mod.createNestApplication();
      app.useGlobalPipes(
        new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
      );
      // Authentication/session middleware is outside this bounded harness.
      // Retain real route guards, DTOs, controller and service. Only its trusted
      // tenant-context seam, persistence transaction and provider are inert fakes.
      app.use((req: any, _res: any, next: () => void) => {
        req.tenantContext = { ...ctx, role: 'standard_user' };
        next();
      });
      await app.listen(0, '127.0.0.1');
      base = `${await app.getUrl()}/engagement/integrations/${microsoft ? 'microsoft' : 'google'}`;
    });
    afterEach(async () => app?.close());
    const start = () =>
      fetch(`${base}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId }),
      });
    const expectNoProviderUse = () => {
      expect(providerSync).not.toHaveBeenCalled();
      expect(h.exchange).not.toHaveBeenCalled();
      expect(h.crypto.decrypt).not.toHaveBeenCalled();
      expect(h.tx.integrationConnectionToken.update).not.toHaveBeenCalled();
    };

    test('start rejects another mailbox owner before saving any attempt', async () => {
      h.rows.get(connectionId).createdByUserId = 'other-user';
      expect((await start()).status).toBe(403);
      expect(h.tx.integrationConnection.update).not.toHaveBeenCalled();
      expect(h.exchange).not.toHaveBeenCalled();
    });

    test('sync rejects revoked membership before using a cached provider token', async () => {
      h.rows.get(connectionId).token.expiresAt = new Date(Date.now() + 3600000);
      const other = { ...structuredClone(h.rows.get(connectionId)), id: 'other-connection' };
      h.rows.set(other.id, structuredClone(other));
      h.setActive(false);
      const response = await fetch(`${base}/${connectionId}/sync`, { method: 'POST' });
      expect(response.status).toBe(403);
      expectNoProviderUse();
      expect(h.tx.integrationConnection.updateMany).toHaveBeenCalledTimes(1);
      expect(h.tx.integrationConnection.updateMany).toHaveBeenCalledWith({
        where: { id: connectionId, status: { in: ['connected', 'error'] } },
        data: expect.objectContaining({ status: 'error' }),
      });
      expect(h.rows.get(connectionId).status).toBe('error');
      expect(h.rows.get(other.id)).toEqual(other);
    });

    test('sync cleanup rejection cannot mask the revoked-member 403', async () => {
      h.rows.get(connectionId).token.expiresAt = new Date(Date.now() + 3600000);
      const before = structuredClone(h.rows.get(connectionId));
      h.setActive(false);
      h.tx.integrationConnection.updateMany.mockRejectedValueOnce(new Error('synthetic write failure'));
      const response = await fetch(`${base}/${connectionId}/sync`, { method: 'POST' });
      expect(response.status).toBe(403);
      expect(h.tx.integrationConnection.updateMany).toHaveBeenCalledTimes(1);
      expect(h.rows.get(connectionId)).toEqual(before);
      expectNoProviderUse();
    });

    test.each(['foreign-tenant', 'deleted', 'needs_configuration'])(
      'revoked sync cleanup preserves a concurrently %s connection', async (change) => {
        h.rows.get(connectionId).token.expiresAt = new Date(Date.now() + 3600000);
        h.setActive(false);
        let retained: unknown;
        const query = h.tx.$queryRaw.getMockImplementation();
        h.tx.$queryRaw.mockImplementation(async (sql: TemplateStringsArray, ...values: unknown[]) => {
          const result = await query(sql, ...values);
          if (sql.join('').includes('tenant_memberships')) {
            if (change === 'deleted') h.rows.delete(connectionId);
            else if (change === 'foreign-tenant') h.rows.get(connectionId).tenantId = 'other-tenant';
            else h.rows.get(connectionId).status = change;
            retained = structuredClone(h.rows.get(connectionId));
          }
          return result;
        });
        const response = await fetch(`${base}/${connectionId}/sync`, { method: 'POST' });
        expect(response.status).toBe(403);
        expect(h.tx.integrationConnection.updateMany).toHaveBeenCalledTimes(1);
        await expect(h.tx.integrationConnection.updateMany.mock.results[0].value).resolves.toEqual({
          count: 0,
        });
        expect(h.rows.get(connectionId)).toEqual(retained);
        expectNoProviderUse();
      },
    );

    test('callback refuses revoked membership before provider exchange', async () => {
      const response = await start();
      expect(response.status).toBe(201);
      const { authUrl } = (await response.json()) as { authUrl: string };
      const state = new URL(authUrl).searchParams.get('state')!;
      h.setActive(false);
      const callback = await fetch(
        `${base}/callback?code=fake-code&state=${encodeURIComponent(state)}`,
        {
          redirect: 'manual',
        },
      );
      if (provider === 'google_workspace') {
        expect(callback.status).toBe(302);
        expect(callback.headers.get('location')).toContain('error=');
        expect(callback.headers.get('location')).not.toContain('connected=1');
      } else {
        expect(callback.status).toBe(403);
      }
      expect(h.exchange).not.toHaveBeenCalled();
      expect(h.tx.integrationConnectionToken.upsert).not.toHaveBeenCalled();
    });
  },
);
