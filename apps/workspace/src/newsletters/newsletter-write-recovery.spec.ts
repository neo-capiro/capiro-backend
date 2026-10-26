import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ValidationPipe,
  type ExecutionContext,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { NewsletterController } from './newsletter.controller.js';
import { TenantGuard } from '../auth/tenant.guard.js';
import { randomUUID } from 'node:crypto';
import { NewsletterService } from './newsletter.service.js';
import { newsletterWriteHash } from './newsletter-write-receipt.js';
import {
  defaultNewsletterConfig,
  governmentAffairsNewsletter,
  parseNewsletterWriteReceipt,
} from '@capiro/shared/newsletter';

const ctx = { tenantId: '11111111-1111-4111-8111-111111111111', clerkUserId: 'synthetic-owner' };
const clientId = '22222222-2222-4222-8222-222222222222';
function clone<T>(value: T): T {
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, clone(v)])) as T;
  if (value instanceof Date) return new Date(value) as T;
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])) as T;
  return value;
}
type Row = {
  id: string;
  tenantId: string;
  ownerId: string;
  name: string;
  revision: number;
  status: string;
  design: ReturnType<typeof governmentAffairsNewsletter>;
  config: ReturnType<typeof defaultNewsletterConfig>;
  updatedAt: Date;
};

/** Source-only persistence double. Real constraints/locks/rollback are qualified separately in PG. */
function fixture() {
  let rows = new Map<string, Row>(),
    receipts = new Map<string, any>(),
    queue = Promise.resolve();
  const state = { member: true, editor: false, denied: false, failReceipt: false, loseAck: false };
  const prisma = {
    wsNewsletterDocument: {
      findFirst: jest.fn(async ({ where }: any) => {
        const row = rows.get(where.id);
        return row?.tenantId === where.tenantId ? clone(row) : null;
      }),
    },
    wsNewsletterReviewer: {
      findFirst: jest.fn(async () => (state.editor ? { role: 'editor' } : null)),
    },
    wsNewsletterInvitation: { findMany: jest.fn() },
    $transaction: jest.fn(async (fn: any) => {
      const preceding = queue;
      let unlock!: () => void;
      queue = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      await preceding;
      const next = clone(rows),
        saved = clone(receipts);
      try {
        const tx = {
          $executeRaw: jest.fn(async () => 1),
          $queryRaw: jest.fn(async (sql: TemplateStringsArray, ...args: any[]) => {
            const key = JSON.stringify(args.slice(0, 3));
            if (sql.join('').includes('INSERT INTO ws_newsletter_write_receipt')) {
              if (state.failReceipt) throw new Error('RECEIPT_WRITE_FAILED');
              const [
                tenant,
                actor,
                request,
                operation,
                doc,
                previous,
                revision,
                input,
                content,
                clients,
              ] = args;
              const result = {
                request_id: request,
                operation,
                document_id: doc,
                previous_revision: previous,
                revision,
                input_hash: input,
                content_hash: content,
                source_client_ids: clients,
                created_at: new Date(),
              };
              saved.set(JSON.stringify([tenant, actor, request]), result);
              return [clone(result)];
            }
            return saved.has(key) ? [clone(saved.get(key))] : [];
          }),
          wsNewsletterDocument: {
            create: jest.fn(async ({ data }: any) => {
              const row = {
                id: randomUUID(),
                revision: 1,
                status: 'draft',
                updatedAt: new Date(),
                ...clone(data),
              };
              next.set(row.id, row);
              return clone(row);
            }),
            updateMany: jest.fn(async ({ where, data }: any) => {
              const row = next.get(where.id);
              if (
                !row ||
                row.tenantId !== where.tenantId ||
                row.ownerId !== where.ownerId ||
                row.revision !== where.revision ||
                (where.reviewers && !state.editor)
              )
                return { count: 0 };
              next.set(row.id, {
                ...row,
                ...clone(data),
                revision: row.revision + 1,
                updatedAt: new Date(),
              });
              return { count: 1 };
            }),
          },
        };
        const result = await fn(tx);
        rows = next;
        receipts = saved;
        if (state.loseAck) {
          state.loseAck = false;
          throw new Error('COMMIT_ACK_LOST');
        }
        return result;
      } finally {
        unlock();
      }
    }),
  };
  const source = {
    newsletterMember: jest.fn(async () => (state.member ? { role: 'standard_user' } : null)),
    resolveUserId: jest.fn(async () => 'synthetic-user'),
    getClient: jest.fn(async () => ({ wallAllowed: !state.denied })),
  };
  const owner = () =>
    new NewsletterService(prisma as never, source as never, {} as never, {} as never);
  // Saved template permits deterministic content; actual service still validates its shape/access.
  const library = {
    findFirst: jest.fn(async () => ({ payload: { design: governmentAffairsNewsletter() } })),
  };
  Object.assign(prisma, { wsNewsletterLibraryItem: library });
  const createInput = () => ({ requestId: randomUUID(), name: 'Original', templateId: clientId });
  const saveInput = (row: Row) => ({
    requestId: randomUUID(),
    revision: row.revision,
    name: 'Saved',
    design: clone(row.design),
    config: clone(row.config),
  });
  return {
    owner,
    prisma,
    source,
    state,
    library,
    createInput,
    saveInput,
    rows: () => rows,
    receipts: () => receipts,
  };
}

it('creates one exact document for a raced request, rejects changed input and never rereads a template on replay', async () => {
  const f = fixture(),
    input = f.createInput();
  const [a, b] = await Promise.all([f.owner().create(ctx, input), f.owner().create(ctx, input)]);
  expect(a).toEqual(b);
  expect(f.rows().size).toBe(1);
  expect(f.receipts().size).toBe(1);
  expect(f.library.findFirst).toHaveBeenCalledTimes(1);
  await expect(f.owner().create(ctx, { ...input, name: 'Changed' })).rejects.toBeInstanceOf(
    ConflictException,
  );
  expect(
    parseNewsletterWriteReceipt(a, { requestId: input.requestId, operation: 'create' }).ok,
  ).toBe(true);
});
it('recovers a committed create after lost acknowledgement through a new service without another mutation', async () => {
  const f = fixture(),
    input = f.createInput();
  f.state.loseAck = true;
  await expect(f.owner().create(ctx, input)).rejects.toThrow('COMMIT_ACK_LOST');
  const receipt = await f.owner().writeReceipt(ctx, input.requestId);
  expect(receipt?.revision).toBe(1);
  expect(f.rows().size).toBe(1);
  expect(await f.owner().create(ctx, input)).toEqual(receipt);
});
it('returns the exact save receipt after a later revision, never the current document as prior write proof', async () => {
  const f = fixture(),
    created = await f.owner().create(ctx, f.createInput());
  const first = f.saveInput(f.rows().get(created.documentId)!);
  const receipt = await f.owner().save(ctx, created.documentId, first);
  await f
    .owner()
    .save(ctx, created.documentId, {
      ...f.saveInput(f.rows().get(created.documentId)!),
      name: 'Later',
    });
  expect(await f.owner().save(ctx, created.documentId, first)).toEqual(receipt);
  expect(await f.owner().writeReceipt(ctx, first.requestId)).toEqual(receipt);
  expect((await f.owner().get(ctx, created.documentId)).revision).toBe(3);
  expect(receipt).toMatchObject({ previousRevision: 1, revision: 2 });
  expect(receipt.contentHash).toBe(
    newsletterWriteHash({
      name: 'Saved',
      design: f.rows().get(created.documentId)!.design,
      config: first.config,
    }),
  );
  expect(
    parseNewsletterWriteReceipt(receipt, {
      operation: 'save',
      requestId: first.requestId,
      documentId: created.documentId,
      previousRevision: 1,
    }).ok,
  ).toBe(true);
  await expect(
    f.owner().save(ctx, created.documentId, { ...first, name: 'Substituted' }),
  ).rejects.toBeInstanceOf(ConflictException);
});
it('keeps different save requests subject to the same revision CAS', async () => {
  const f = fixture(),
    created = await f.owner().create(ctx, f.createInput()),
    input = f.saveInput(f.rows().get(created.documentId)!);
  const results = await Promise.allSettled([
    f.owner().save(ctx, created.documentId, input),
    f.owner().save(ctx, created.documentId, { ...input, requestId: randomUUID() }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({
    reason: expect.any(ConflictException),
  });
  expect(f.rows().get(created.documentId)!.revision).toBe(2);
});
it('rolls back the document mutation if its receipt cannot persist, for create and save', async () => {
  const f = fixture();
  f.state.failReceipt = true;
  await expect(f.owner().create(ctx, f.createInput())).rejects.toThrow('RECEIPT_WRITE_FAILED');
  expect(f.rows().size).toBe(0);
  f.state.failReceipt = false;
  const created = await f.owner().create(ctx, f.createInput()),
    before = clone(f.rows().get(created.documentId)!);
  f.state.failReceipt = true;
  await expect(f.owner().save(ctx, created.documentId, f.saveInput(before))).rejects.toThrow(
    'RECEIPT_WRITE_FAILED',
  );
  expect(f.rows().get(created.documentId)).toEqual(before);
  expect(f.receipts().size).toBe(1);
});
it('retains the request fence after deletion and refuses replay instead of recreating', async () => {
  const f = fixture(),
    input = f.createInput(),
    receipt = await f.owner().create(ctx, input);
  f.rows().delete(receipt.documentId);
  await expect(f.owner().create(ctx, input)).rejects.toBeInstanceOf(NotFoundException);
  await expect(f.owner().writeReceipt(ctx, input.requestId)).rejects.toBeInstanceOf(
    NotFoundException,
  );
  expect(f.rows().size).toBe(0);
  expect(f.receipts().size).toBe(1);
});
it('reads no other tenant/actor receipt and checks current membership for owners too', async () => {
  const f = fixture(),
    input = f.createInput();
  await f.owner().create(ctx, input);
  expect(await f.owner().writeReceipt({ ...ctx, tenantId: clientId }, input.requestId)).toBeNull();
  expect(
    await f.owner().writeReceipt({ ...ctx, clerkUserId: 'another' }, input.requestId),
  ).toBeNull();
  f.state.member = false;
  await expect(f.owner().writeReceipt(ctx, input.requestId)).rejects.toBeInstanceOf(
    NotFoundException,
  );
  await expect(f.owner().create(ctx, f.createInput())).rejects.toBeInstanceOf(NotFoundException);
});
it('checks current editor access without activating invitations during save or readback', async () => {
  const f = fixture(),
    created = await f.owner().create(ctx, f.createInput()),
    editor = { ...ctx, clerkUserId: 'synthetic-editor' };
  f.state.editor = true;
  const input = f.saveInput(f.rows().get(created.documentId)!);
  await f.owner().save(editor, created.documentId, input);
  f.state.editor = false;
  await expect(f.owner().writeReceipt(editor, input.requestId)).rejects.toBeInstanceOf(
    NotFoundException,
  );
  expect(f.prisma.wsNewsletterInvitation.findMany).not.toHaveBeenCalled();
});
it('preserves source-client union and denies a receipt when any retained source is revoked', async () => {
  const f = fixture(),
    created = await f.owner().create(ctx, f.createInput()),
    row = f.rows().get(created.documentId)!;
  row.design.sourceClientIds = [clientId];
  const input = f.saveInput(row);
  input.design.sourceClientIds = [];
  const receipt = await f.owner().save(ctx, created.documentId, input);
  expect(f.rows().get(created.documentId)!.design.sourceClientIds).toEqual([clientId]);
  f.state.denied = true;
  await expect(f.owner().writeReceipt(ctx, receipt.requestId)).rejects.toBeInstanceOf(
    NotFoundException,
  );
  await expect(f.owner().save(ctx, created.documentId, input)).rejects.toBeInstanceOf(
    NotFoundException,
  );
});
it('absent readback is read-only, while missing/malformed request IDs refuse before mutation', async () => {
  const f = fixture();
  expect(await f.owner().writeReceipt(ctx, randomUUID())).toBeNull();
  for (const requestId of [undefined, '', 'not-a-request'])
    await expect(
      f.owner().create(ctx, { ...f.createInput(), requestId } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  expect(f.rows().size).toBe(0);
  expect(f.receipts().size).toBe(0);
  expect(f.library.findFirst).not.toHaveBeenCalled();
});
it('keeps create/save namespaces bound under the same actor request fence', async () => {
  const f = fixture(),
    input = f.createInput(),
    created = await f.owner().create(ctx, input);
  await expect(
    f
      .owner()
      .save(ctx, created.documentId, {
        ...f.saveInput(f.rows().get(created.documentId)!),
        requestId: input.requestId,
      }),
  ).rejects.toBeInstanceOf(ConflictException);
});
it('mounts required request IDs, exact receipts and read-only lookup through the real controller/DTO', async () => {
  const f = fixture();
  const module = await Test.createTestingModule({
    controllers: [NewsletterController],
    providers: [{ provide: NewsletterService, useValue: f.owner() }],
  })
    .overrideGuard(TenantGuard)
    .useValue({
      canActivate: (context: ExecutionContext) => {
        context.switchToHttp().getRequest().tenantContext = ctx;
        return true;
      },
    })
    .compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix('workspace-api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  try {
    await app.init();
    const http = () => request(app.getHttpServer()),
      path = '/workspace-api/newsletters',
      input = f.createInput();
    await http()
      .post(path + '/documents')
      .send({ name: 'Unbound' })
      .expect(400);
    const created = await http()
      .post(path + '/documents')
      .send(input)
      .expect(201);
    expect(created.body).not.toHaveProperty('design');
    const read = await http()
      .get(path + '/write-requests/' + input.requestId)
      .expect(200);
    expect(read.body).toEqual(created.body);
    const save = f.saveInput(f.rows().get(created.body.documentId)!);
    await http()
      .patch(path + '/documents/' + created.body.documentId)
      .send({ ...save, requestId: undefined })
      .expect(400);
    const saved = await http()
      .patch(path + '/documents/' + created.body.documentId)
      .send(save)
      .expect(200);
    expect(saved.body).toMatchObject({ operation: 'save', requestId: save.requestId, revision: 2 });
    await http()
      .post(path + '/documents')
      .send({ ...input, name: 'Changed' })
      .expect(409);
    await http()
      .get(path + '/write-requests/malformed')
      .expect(400);
    f.state.member = false;
    await http()
      .get(path + '/write-requests/' + save.requestId)
      .expect(404);
    expect(f.rows().size).toBe(1);
    expect(f.receipts().size).toBe(2);
  } finally {
    await app.close();
  }
});
