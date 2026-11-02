import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Request } from 'express';
import { ImpersonationService, type StartImpersonation } from './impersonation.service.js';
import { impersonationDatabase } from './impersonation.postgres-fixture.js';

const url = process.env.IMPERSONATION_TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  'exact HQ impersonation lifecycle through ordinary PostgreSQL',
  () => {
    let store: Awaited<ReturnType<typeof impersonationDatabase>>, service: ImpersonationService;
    let ctx: TenantContext, input: StartImpersonation, checks: number, revokedAfter: number;
    const req = { header: () => undefined } as unknown as Request;
    beforeAll(async () => {
      store = await impersonationDatabase(url!);
    }, 90000);
    afterAll(async () => {
      await store?.db.$disconnect();
    });
    beforeEach(async () => {
      const tenantId = randomUUID(),
        userId = randomUUID(),
        target = randomUUID();
      ctx = {
        tenantId,
        userId,
        clerkUserId: 'synthetic-' + userId,
        tenantSlug: 'synthetic-' + tenantId,
        role: 'capiro_admin',
      };
      for (const id of [tenantId, target])
        await store.db.tenant.create({
          data: { id, slug: 'synthetic-' + id, name: 'Synthetic', status: 'active' },
        });
      await store.db.user.create({
        data: { id: userId, clerkUserId: ctx.clerkUserId, email: userId + '@example.invalid' },
      });
      await store.db.tenantMembership.create({
        data: { tenantId, userId, status: 'active', role: 'capiro_admin' },
      });
      input = {
        requestId: randomUUID(),
        tenantId: target,
        reason: 'Investigating a synthetic support request',
      };
      checks = 0;
      revokedAfter = Infinity;
      service = new ImpersonationService(store.system, {
        readApplicationAuthoritySession: async (request: Request, actor: TenantContext) => {
          expect(request).toBe(req);
          expect(actor).toBe(ctx);
          return {
            readCurrent: async () => {
              if (++checks > revokedAfter) throw new ForbiddenException('Session revoked');
            },
          };
        },
      } as never);
    });
    const start = (command = input) => service.start(ctx, req, command);
    const audit = () =>
      store.db.auditLog.findMany({
        where: { actorUserId: ctx.userId },
        orderBy: { occurredAt: 'asc' },
      });

    it('recovers the active server selection across tabs and audits expiry once', async () => {
      expect(await service.active(ctx, req)).toEqual({ session: null });
      await start();
      expect((await service.active(ctx, req)).session?.sessionId).toBe(input.requestId);
      await store.db.impersonationSession.update({
        where: { id: input.requestId },
        data: { expiresAt: new Date(1) },
      });
      expect(await service.active(ctx, req)).toEqual({ session: null });
      expect(await service.active(ctx, req)).toEqual({ session: null });
      expect((await audit()).filter((r) => r.action === 'impersonation.end')).toHaveLength(1);
    });

    it('reads only the saved target and visible clients, pages completely, and audits use', async () => {
      await start();
      const clients = Array.from({ length: 52 }, () => ({
        id: randomUUID(),
        tenantId: input.tenantId,
        name: 'Synthetic client',
      }));
      await store.db.client.createMany({ data: clients });
      await store.db.client.createMany({
        data: [
          { tenantId: ctx.tenantId, name: 'Other tenant' },
          { tenantId: input.tenantId, name: 'Archived', status: 'archived' },
          { tenantId: input.tenantId, name: 'Walled', memoryWall: true },
        ],
      });
      const first = await service.workspace(ctx, req, input.requestId);
      expect(first.clients).toHaveLength(50);
      expect(first.readOnly).toBe(true);
      expect(first.session.tenantId).toBe(input.tenantId);
      const second = await service.workspace(ctx, req, input.requestId, first.nextCursor!);
      expect(second.clients).toHaveLength(2);
      expect(second.nextCursor).toBeNull();
      expect(new Set([...first.clients, ...second.clients].map((c) => c.id))).toEqual(
        new Set(clients.map((c) => c.id)),
      );
      expect(
        (await audit()).filter((r) => r.action === 'impersonation.workspace.read'),
      ).toHaveLength(2);
    });
    it.each(['ended', 'expired', 'suspended', 'replaced'] as const)(
      'refuses workspace after %s',
      async (state) => {
        await start();
        if (state === 'ended') await service.end(ctx, req, input.requestId);
        if (state === 'expired')
          await store.db.impersonationSession.update({
            where: { id: input.requestId },
            data: { expiresAt: new Date(1) },
          });
        if (state === 'suspended')
          await store.db.tenant.update({
            where: { id: input.tenantId },
            data: { status: 'suspended' },
          });
        if (state === 'replaced') await start({ ...input, requestId: randomUUID() });
        await expect(service.workspace(ctx, req, input.requestId)).rejects.toThrow(
          'no longer active',
        );
        expect(
          (await audit()).filter((r) => r.action === 'impersonation.workspace.read'),
        ).toHaveLength(0);
      },
    );
    it('rolls back a read audit on late native-session loss and refuses header scope substitution', async () => {
      await start();
      checks = 0;
      revokedAfter = 1;
      await expect(service.workspace(ctx, req, input.requestId)).rejects.toThrow('Session revoked');
      expect(
        (await audit()).filter((r) => r.action === 'impersonation.workspace.read'),
      ).toHaveLength(0);
      for (const header of ['x-capiro-impersonate-tenant', 'x-capiro-impersonation-session'])
        await expect(
          service.workspace(
            ctx,
            { header: (name: string) => (name === header ? input.tenantId : undefined) } as Request,
            input.requestId,
          ),
        ).rejects.toThrow('own HQ');
    });

    it('concurrent exact starts create one session and start audit; a lost reply recovers it', async () => {
      const results = await Promise.all([start(), start()]);
      expect(results.map((v) => v.sessionId)).toEqual([input.requestId, input.requestId]);
      expect(results.filter((v) => v.replayed)).toHaveLength(1);
      expect(await audit()).toHaveLength(1);
      expect(await service.read(ctx, req, input.requestId)).toMatchObject({
        sessionId: input.requestId,
        status: 'active',
        tenantId: input.tenantId,
      });
    });
    it('serializes different starts, audits replacement and keeps the old start receipt', async () => {
      const newer = { ...input, requestId: randomUUID() };
      await Promise.all([start(), start(newer)]);
      const rows = await store.db.impersonationSession.findMany({
        where: { actorUserId: ctx.userId },
      });
      expect(rows.filter((row) => row.endedAt === null)).toHaveLength(1);
      const ended = rows.find((row) => row.endedAt !== null)!;
      expect(ended.endedReason).toBe('replaced');
      expect(await start({ ...input, requestId: ended.id })).toMatchObject({
        sessionId: ended.id,
        status: 'ended',
        replayed: true,
      });
      expect((await audit()).map((row) => row.action).sort()).toEqual([
        'impersonation.end',
        'impersonation.start',
        'impersonation.start',
      ]);
    });
    it('an old tab cannot end the replacement; exact exit is idempotent and audited once', async () => {
      await start();
      const next = await start({ ...input, requestId: randomUUID() });
      expect(await service.end(ctx, req, input.requestId)).toMatchObject({
        status: 'ended',
        endedReason: 'replaced',
        replayed: true,
      });
      expect((await service.read(ctx, req, next.sessionId)).status).toBe('active');
      const endings = await Promise.all([
        service.end(ctx, req, next.sessionId),
        service.end(ctx, req, next.sessionId),
      ]);
      expect(endings.filter((v) => v.replayed)).toHaveLength(1);
      expect(endings.every((v) => v.endedReason === 'manual')).toBe(true);
      expect(
        (await audit()).filter(
          (row) => row.entityId === next.sessionId && row.action === 'impersonation.end',
        ),
      ).toHaveLength(1);
    });
    it('reports expiry and cannot reactivate an expired request through retry', async () => {
      await start();
      await store.db.impersonationSession.update({
        where: { id: input.requestId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await service.read(ctx, req, input.requestId)).status).toBe('expired');
      expect(await start()).toMatchObject({ status: 'expired', replayed: true });
      expect(await service.end(ctx, req, input.requestId)).toMatchObject({
        status: 'ended',
        endedReason: 'expired',
      });
    });
    it('refuses reuse of the original identity with a changed reason or target', async () => {
      await start();
      await expect(start({ ...input, reason: 'Another support investigation' })).rejects.toThrow(
        'already used',
      );
      await expect(start({ ...input, tenantId: ctx.tenantId })).rejects.toThrow('already used');
      expect(await audit()).toHaveLength(1);
    });
    it('refuses foreign session status and exit', async () => {
      await start();
      const foreignActor = randomUUID(),
        foreignSession = randomUUID();
      await store.db.user.create({
        data: {
          id: foreignActor,
          clerkUserId: 'synthetic-' + foreignActor,
          email: foreignActor + '@example.invalid',
        },
      });
      await store.db.impersonationSession.create({
        data: {
          id: foreignSession,
          actorUserId: foreignActor,
          tenantId: input.tenantId,
          reason: 'A different synthetic support request',
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      await expect(service.read(ctx, req, foreignSession)).rejects.toThrow('not found');
      await expect(service.workspace(ctx, req, foreignSession)).rejects.toThrow('not found');
      await expect(service.end(ctx, req, foreignSession)).rejects.toThrow('not found');
      await expect(start({ ...input, requestId: foreignSession })).rejects.toThrow('already used');
      expect(
        (await store.db.impersonationSession.findUniqueOrThrow({ where: { id: foreignSession } }))
          .endedAt,
      ).toBeNull();
      expect(await audit()).toHaveLength(1);
    });
    it.each(['member', 'role', 'tenant', 'identity'])(
      'refuses current %s authority loss',
      async (kind) => {
        await start();
        if (kind === 'member')
          await store.db.tenantMembership.deleteMany({ where: { tenantId: ctx.tenantId } });
        if (kind === 'role')
          await store.db.tenantMembership.updateMany({
            where: { tenantId: ctx.tenantId },
            data: { role: 'user_admin' },
          });
        if (kind === 'tenant')
          await store.db.tenant.update({
            where: { id: ctx.tenantId },
            data: { status: 'suspended' },
          });
        if (kind === 'identity')
          await store.db.user.update({
            where: { id: ctx.userId },
            data: { clerkUserId: 'changed-' + randomUUID() },
          });
        await expect(start()).rejects.toThrow();
        await expect(service.read(ctx, req, input.requestId)).rejects.toThrow();
        await expect(service.end(ctx, req, input.requestId)).rejects.toThrow();
        await expect(service.workspace(ctx, req, input.requestId)).rejects.toThrow();
        await expect(service.active(ctx, req)).rejects.toThrow();
      },
    );
    it('rolls back the session and audit when native authority is lost after the write', async () => {
      revokedAfter = 1;
      await expect(start()).rejects.toThrow('Session revoked');
      expect(
        await store.db.impersonationSession.count({ where: { actorUserId: ctx.userId } }),
      ).toBe(0);
      expect(await audit()).toHaveLength(0);
    });
    it('refuses inactive targets and exposes later target suspension without granting use', async () => {
      await store.db.tenant.update({
        where: { id: input.tenantId },
        data: { status: 'suspended' },
      });
      await expect(start()).rejects.toThrow('Active tenant not found');
      await store.db.tenant.update({ where: { id: input.tenantId }, data: { status: 'active' } });
      await start();
      await store.db.tenant.update({
        where: { id: input.tenantId },
        data: { status: 'suspended' },
      });
      expect((await service.read(ctx, req, input.requestId)).status).toBe('unavailable');
    });
  },
);
