import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ConflictException, ForbiddenException, ValidationPipe, type ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { HillDayExportService } from './hillday-export.service.js';
import type { HillDayDocumentView } from './hillday.types.js';
import { HillDayController } from './hillday.controller.js';
import { HillDayDocumentService } from './hillday-document.service.js';
import { HillDayResolutionService } from './hillday-resolution.service.js';
import { HillDayContextService } from './hillday-context.service.js';
import { HillDayGenerationService } from './hillday-generation.service.js';
import { TenantGuard } from '../auth/tenant.guard.js';

const REQUEST = '11111111-1111-4111-8111-111111111111';
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
let previousKey: string | undefined;
beforeEach(() => { previousKey = process.env.WORKSPACE_EXPORT_SIGNING_SECRET; process.env.WORKSPACE_EXPORT_SIGNING_SECRET = 'synthetic-ws12-key'; });
afterEach(() => { if (previousKey === undefined) delete process.env.WORKSPACE_EXPORT_SIGNING_SECRET; else process.env.WORKSPACE_EXPORT_SIGNING_SECRET = previousKey; });

function barrier() {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release, arrive: async () => { entered(); await wait; } };
}

function fixture() {
  type Row = Record<string, unknown> & { id: string; tenantId: string; actorId: string; requestId: string | null };
  const rows: Row[] = [];
  const state = { deny: false, loseInsertAck: false, loseReadyAck: false, renderFailure: false };
  const view = { id: 'doc', name: 'Saved packet', client: { id: 'client' }, updatedAt: '2026-10-26T00:00:00.000Z', sections: [{ focus: 'Saved focus' }] } as unknown as HillDayDocumentView;
  let renderGate: ReturnType<typeof barrier> | undefined;
  let findGate: (() => Promise<void>) | undefined;
  const model = {
    findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const result = rows.find(row => Object.entries(where).every(([key, value]) => row[key] === value));
      await findGate?.();
      return result ? { ...result } : null;
    }),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (data.requestId && rows.some(row => row.tenantId === data.tenantId && row.actorId === data.actorId && row.requestId === data.requestId)) throw Object.assign(new Error('unique request'), { code: 'P2002' });
      const row = { id: `export-${rows.length + 1}`, filename: null, file: null, sizeBytes: null, error: null, createdAt: new Date(), ...data } as unknown as Row;
      rows.push(row);
      if (state.loseInsertAck) throw new Error('insert acknowledgement lost');
      return { ...row };
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.find(row => row.id === where.id)!;
      Object.assign(row, data);
      if (data.status === 'ready' && state.loseReadyAck) throw new Error('ready acknowledgement lost');
      return { ...row };
    }),
  };
  const documents = {
    assertDoc: jest.fn(async () => { if (state.deny) throw new ForbiddenException(); return { ownerId: 'owner' }; }),
    get: jest.fn(async () => view),
  };
  const bridge = { branding: jest.fn(async () => ({ ok: false })) };
  const renders = jest.fn(async (captured: HillDayDocumentView) => {
    await renderGate?.arrive();
    if (state.renderFailure) throw new Error('synthetic renderer failure');
    return Buffer.from(`%PDF-synthetic:${captured.name}:${captured.sections[0]?.focus}`);
  });
  const service = () => {
    const result = new HillDayExportService({ wsHillDayExport: model } as never, documents as never, bridge as never);
    result.renderPdf = renders;
    return result;
  };
  return { rows, state, view, model, documents, renders, service, blockRender() { return renderGate = barrier(); }, setFindHook(hook?: () => Promise<void>) { findGate = hook; } };
}

describe('WS12 request-bound export recovery', () => {
  it('recovers a lost ready acknowledgement through a new service without another render, even after saved content changes', async () => {
    const h = fixture(); h.state.loseReadyAck = true;
    await expect(h.service().create('tenant', 'owner', 'doc', 'letter', REQUEST)).rejects.toThrow('ready acknowledgement lost');
    expect(h.rows[0]?.status).toBe('ready');
    expect(h.model.update).toHaveBeenCalledTimes(1);
    const capturedHash = sha(JSON.stringify({ format: 'hillday-render-input-v1', view: h.view, pageSize: 'letter', logoSha256: null }));
    h.view.name = 'Later edit'; h.view.sections[0]!.focus = 'Later focus';
    const read = await h.service().getRequest('tenant', 'doc', REQUEST, 'owner');
    expect(read).toMatchObject({ exportId: 'export-1', requestId: REQUEST, status: 'ready', renderInputSha256: capturedHash, contentSha256: sha(h.rows[0]!.file as Buffer) });
    expect(read!.filename).toBe('Saved-packet.pdf');
    expect(read!.sourceUpdatedAt).toBe('2026-10-26T00:00:00.000Z');
    await expect(h.service().create('tenant', 'owner', 'doc', 'letter', REQUEST)).resolves.toMatchObject({ exportId: read!.exportId, renderInputSha256: capturedHash });
    expect(h.renders).toHaveBeenCalledTimes(1);
    expect(h.documents.get).toHaveBeenCalledTimes(1);
  });

  it('resolves simultaneous absent reads through the unique insert, with only its winner rendering', async () => {
    const h = fixture(), gate = h.blockRender();
    let reads = 0; const both = barrier();
    h.setFindHook(async () => { if (++reads <= 2) { if (reads === 2) both.release(); await both.arrive(); } });
    const a = h.service().create('tenant', 'owner', 'doc', 'letter', REQUEST);
    const b = h.service().create('tenant', 'owner', 'doc', 'letter', REQUEST);
    try {
      await gate.ready;
      const loser = await Promise.race([a, b]);
      expect(loser).toMatchObject({ exportId: 'export-1', status: 'queued' });
      expect(h.renders).toHaveBeenCalledTimes(1);
      expect(h.rows).toHaveLength(1);
    } finally { gate.release(); await Promise.allSettled([a, b]); }
    expect(h.rows[0]?.status).toBe('ready');
  });

  it.each(['page size', 'document'])('refuses changed %s under the same identity without rendering', async (change) => {
    const h = fixture(); await h.service().create('tenant', 'owner', 'doc', 'letter', REQUEST);
    await expect(h.service().create('tenant', 'owner', change === 'document' ? 'other' : 'doc', change === 'page size' ? 'a4' : 'letter', REQUEST)).rejects.toBeInstanceOf(ConflictException);
    expect(h.rows).toHaveLength(1); expect(h.renders).toHaveBeenCalledTimes(1);
  });

  it('keeps an uncertain insert pending and never starts a render on readback or exact replay', async () => {
    const h = fixture(); h.state.loseInsertAck = true;
    await expect(h.service().create('tenant', 'owner', 'doc', 'letter', REQUEST)).rejects.toThrow('insert acknowledgement lost');
    await expect(h.service().getRequest('tenant', 'doc', REQUEST, 'owner')).resolves.toMatchObject({ status: 'queued', contentSha256: null, renderInputSha256: null, url: null });
    await expect(h.service().create('tenant', 'owner', 'doc', 'letter', REQUEST)).resolves.toMatchObject({ status: 'queued' });
    expect(h.renders).not.toHaveBeenCalled(); expect(h.model.create).toHaveBeenCalledTimes(1);
  });

  it('records a renderer failure once and preserves that failed result on replay', async () => {
    const h = fixture(); h.state.renderFailure = true;
    await expect(h.service().create('tenant', 'owner', 'doc', 'letter', REQUEST)).resolves.toMatchObject({ status: 'failed', contentSha256: null, url: null });
    h.state.renderFailure = false;
    await expect(h.service().create('tenant', 'owner', 'doc', 'letter', REQUEST)).resolves.toMatchObject({ status: 'failed' });
    expect(h.renders).toHaveBeenCalledTimes(1);
  });

  it('freezes the captured render input before later edits and denies a result if current access is lost', async () => {
    const h = fixture(), gate = h.blockRender();
    const pending = h.service().create('tenant', 'owner', 'doc', 'letter', REQUEST);
    try { await gate.ready; h.view.name = 'Later'; h.state.deny = true; } finally { gate.release(); }
    await expect(pending).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.model.update).not.toHaveBeenCalled(); expect(h.rows[0]?.status).toBe('queued');
    expect(h.renders.mock.calls[0]![0].name).toBe('Saved packet');
    await expect(h.service().getRequest('tenant', 'doc', REQUEST, 'owner')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rechecks access after the request read, including empty results, without writing', async () => {
    const h = fixture(); h.setFindHook(async () => { h.state.deny = true; });
    await expect(h.service().getRequest('tenant', 'doc', REQUEST, 'owner')).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.model.create).not.toHaveBeenCalled(); expect(h.model.update).not.toHaveBeenCalled();
  });

  it('binds readback to tenant, actor and document; absence never writes', async () => {
    const h = fixture(); await h.service().create('tenant', 'owner', 'doc', 'letter', REQUEST);
    for (const [tenant, doc, actor] of [['foreign', 'doc', 'owner'], ['tenant', 'other', 'owner'], ['tenant', 'doc', 'foreign']])
      await expect(h.service().getRequest(tenant!, doc!, REQUEST, actor!)).resolves.toBeNull();
    expect(h.model.create).toHaveBeenCalledTimes(1); expect(h.renders).toHaveBeenCalledTimes(1);
  });

  it('refuses malformed request identities and retains legacy non-recoverable calls', async () => {
    const h = fixture();
    await expect(h.service().create('tenant', 'owner', 'doc', 'letter', '../bad')).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.service().getRequest('tenant', 'doc', '../bad', 'owner')).rejects.toBeInstanceOf(BadRequestException);
    expect(h.model.create).not.toHaveBeenCalled();
    await expect(h.service().create('tenant', 'owner', 'doc', 'letter')).resolves.toMatchObject({ requestId: null, status: 'ready' });
  });

  it('mounts request-bound POST and readback GET through the existing controller/DTO', async () => {
    const h = fixture();
    const module = await Test.createTestingModule({
      controllers: [HillDayController],
      providers: [
        { provide: HillDayExportService, useValue: h.service() },
        ...[HillDayDocumentService, HillDayResolutionService, HillDayContextService, HillDayGenerationService].map(provide => ({ provide, useValue: {} })),
      ],
    }).overrideGuard(TenantGuard).useValue({ canActivate: (context: ExecutionContext) => {
      context.switchToHttp().getRequest().tenantContext = { tenantId: 'tenant', clerkUserId: 'owner' }; return true;
    } }).compile();
    const app = module.createNestApplication();
    app.setGlobalPrefix('workspace-api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    try {
      await app.init();
      const url = '/workspace-api/hillday/documents/doc/exports';
      const created = await request(app.getHttpServer()).post(url).send({ requestId: REQUEST, pageSize: 'letter' }).expect(201);
      const read = await request(app.getHttpServer()).get(`${url}/requests/${REQUEST}`).expect(200);
      expect(read.body).toMatchObject({ exportId: created.body.exportId, requestId: REQUEST, contentSha256: created.body.contentSha256 });
      await request(app.getHttpServer()).post(url).send({ requestId: REQUEST, pageSize: 'a4' }).expect(409);
      await request(app.getHttpServer()).post(url).send({ requestId: 'bad' }).expect(400);
      h.state.deny = true;
      await request(app.getHttpServer()).get(`${url}/requests/${REQUEST}`).expect(403);
      expect(h.renders).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
});
