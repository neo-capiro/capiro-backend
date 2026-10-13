/** Actual selected canonical methods only: no service constructor/provider/Engagement import graph. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const recordId = 'a1111111-1111-4111-8111-111111111111';
const stageId = 'b2222222-2222-4222-8222-222222222222';
const clientId = 'c3333333-3333-4333-8333-333333333333';
const otherClient = 'd4444444-4444-4444-8444-444444444444';
const ctx = {
  tenantId: 'e5555555-5555-4555-8555-555555555555',
  userId: 'user-id',
  clerkUserId: 'user_subject',
};
class NotFoundException extends Error {}
class ConflictException extends Error {}
const source = readFileSync(join(__dirname, 'newsletter-outreach.service.ts'), 'utf8');
const ast = ts.createSourceFile(
  'canonical.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const owner = ast.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'NewsletterOutreachService',
);
if (!owner) throw new Error('Canonical owner missing');
const selected = owner.members.filter(
  (node) =>
    ts.isMethodDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    ['record', 'get', 'mutation'].includes(node.name.text),
);
if (selected.length !== 3) throw new Error('Canonical selected method inventory changed');
const text = `const uuid = /^[a-f\\d]{8}-[a-f\\d]{4}-[1-5][a-f\\d]{3}-[89ab][a-f\\d]{3}-[a-f\\d]{12}$/i; class Subject { ${selected.map((node) => node.getText(ast)).join('\n')} }; module.exports = Subject;`;
const compiled = ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const sandbox = { module: { exports: {} }, NotFoundException, ConflictException };
runInNewContext(compiled, sandbox, { timeout: 1000 });
const Subject = sandbox.module.exports as new () => {
  record: (...args: unknown[]) => Promise<unknown>;
  get: (...args: unknown[]) => Promise<unknown>;
  mutation: (...args: unknown[]) => Promise<unknown>;
};
function harness() {
  const events: string[] = [];
  const row: {
    id: string;
    type: string;
    clientId?: string | null;
    status: string;
    subject: string;
    metadata: Record<string, unknown>;
  } = {
    id: recordId,
    type: 'outbound_campaign',
    clientId,
    status: 'draft',
    subject: 'Subject',
    metadata: { newsletterStageId: stageId, newsletterRevision: 4 },
  };
  const stage: {
    id: string;
    revision: number;
    name: string;
    config: { clientId?: string | null; subject: string };
    design: object;
  } = {
    id: stageId,
    revision: 4,
    name: 'Immutable stage',
    config: { clientId, subject: 'Subject' },
    design: {},
  };
  const engagement = {
    getOutreachRecord: jest.fn(async () => {
      events.push('owner');
      return row;
    }),
  };
  const drafts = {
    listForOutreach: jest.fn(async () => {
      events.push('draft-read');
      return [];
    }),
  };
  const stageRead = jest.fn(async () => {
    events.push('stage-authority');
    return stage;
  });
  const assertClient = jest.fn(async () => {
    events.push('client-authority');
  });
  const tx = {
    $queryRaw: jest.fn(async () => {
      events.push('advisory-lock');
      return [{ locked: true }];
    }),
    newsletterRecipientAccess: {
      findMany: jest.fn(async () => {
        events.push('recipient-read');
        return [];
      }),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenant: unknown, body: (tx: unknown) => unknown) => {
      events.push('transaction');
      return body(tx);
    }),
  };
  const service = Object.assign(new Subject(), {
    engagement,
    drafts,
    stage: stageRead,
    assertClient,
    prisma,
  });
  const operation = jest.fn(async () => {
    events.push('effectful-operation');
    return 'committed';
  });
  return {
    row,
    stage,
    events,
    engagement,
    drafts,
    stageRead,
    assertClient,
    tx,
    prisma,
    service,
    operation,
  };
}
async function refuses(h: ReturnType<typeof harness>) {
  await expect(h.service.get(ctx, recordId)).rejects.toBeInstanceOf(NotFoundException);
  await expect(h.service.mutation(ctx, recordId, h.operation)).rejects.toBeInstanceOf(
    NotFoundException,
  );
  expect(h.drafts.listForOutreach).not.toHaveBeenCalled();
  expect(h.tx.$queryRaw).not.toHaveBeenCalled();
  expect(h.tx.newsletterRecipientAccess.findMany).not.toHaveBeenCalled();
  expect(h.operation).not.toHaveBeenCalled();
  expect(h.prisma.withTenant).not.toHaveBeenCalled();
}
describe('canonical rich newsletter admission', () => {
  test('rechecks canonical record stage and client authority before draft reads', async () => {
    const h = harness();
    await h.service.get(ctx, recordId);
    expect(h.events).toEqual([
      'owner',
      'stage-authority',
      'client-authority',
      'draft-read',
      'transaction',
      'recipient-read',
    ]);
    expect(h.engagement.getOutreachRecord).toHaveBeenCalledWith(ctx, recordId);
    expect(h.stageRead).toHaveBeenCalledWith(ctx, stageId);
    expect(h.assertClient).toHaveBeenCalledWith(ctx, clientId);
  });
  test('valid mutation keeps authority before existing advisory lock and operation', async () => {
    const h = harness();
    await expect(h.service.mutation(ctx, recordId, h.operation)).resolves.toBe('committed');
    expect(h.events).toEqual([
      'owner',
      'stage-authority',
      'client-authority',
      'transaction',
      'advisory-lock',
      'effectful-operation',
    ]);
  });
  test('wrong persisted type refuses before even loading a stage', async () => {
    const h = harness();
    h.row.type = 'outreach_email';
    await refuses(h);
    expect(h.stageRead).not.toHaveBeenCalled();
  });
  test('missing persisted type refuses', async () => {
    const h = harness();
    delete (h.row as Partial<typeof h.row>).type;
    await refuses(h);
  });
  test('missing reserved stage hint refuses', async () => {
    const h = harness();
    delete h.row.metadata.newsletterStageId;
    await refuses(h);
  });
  test('malformed reserved stage hint refuses', async () => {
    const h = harness();
    h.row.metadata.newsletterStageId = null;
    await refuses(h);
  });
  test('a foreign current stage client refuses before drafting or locking', async () => {
    const h = harness();
    h.stage.config.clientId = otherClient;
    await refuses(h);
  });
  test('case-insensitive client identity preserves uppercase stage JSON', async () => {
    const h = harness();
    h.stage.config.clientId = clientId.toUpperCase();
    await h.service.get(ctx, recordId);
    expect(h.stage.config.clientId).toBe(clientId.toUpperCase());
    expect(h.drafts.listForOutreach).toHaveBeenCalledTimes(1);
  });
  test('both null primary client bindings retain the existing legacy profile', async () => {
    const h = harness();
    h.row.clientId = null;
    h.stage.config.clientId = null;
    await h.service.get(ctx, recordId);
    expect(h.assertClient).toHaveBeenCalledWith(ctx, null);
  });
  test.each(['row', 'stage'] as const)('one-null %s binding refuses', async (side) => {
    const h = harness();
    if (side === 'row') h.row.clientId = null;
    else h.stage.config.clientId = null;
    await refuses(h);
  });
  test.each(['row', 'stage'] as const)('missing %s client binding refuses', async (side) => {
    const h = harness();
    if (side === 'row') delete h.row.clientId;
    else delete h.stage.config.clientId;
    await refuses(h);
  });
  test.each(['row', 'stage'] as const)('invalid %s UUID binding refuses', async (side) => {
    const h = harness();
    if (side === 'row') h.row.clientId = 'n_node';
    else h.stage.config.clientId = 'n_node';
    await refuses(h);
  });
  test('absent reserved revision remains legacy-compatible', async () => {
    const h = harness();
    delete h.row.metadata.newsletterRevision;
    await h.service.get(ctx, recordId);
    expect(h.drafts.listForOutreach).toHaveBeenCalledTimes(1);
  });
  test('stale positive reserved revision refuses before all draft/effectful calls', async () => {
    const h = harness();
    h.row.metadata.newsletterRevision = 3;
    await refuses(h);
  });
  test.each([null, undefined, '4', 0, -1, 4.5, Number.MAX_SAFE_INTEGER + 1, false])(
    'malformed present reserved revision %s refuses',
    async (value) => {
      const h = harness();
      h.row.metadata.newsletterRevision = value;
      await refuses(h);
    },
  );
  test('owner record denial propagates without stage or effectful calls', async () => {
    const h = harness();
    const error = new Error('current owner denial');
    h.engagement.getOutreachRecord.mockRejectedValue(error);
    await expect(h.service.get(ctx, recordId)).rejects.toBe(error);
    expect(h.stageRead).not.toHaveBeenCalled();
    expect(h.drafts.listForOutreach).not.toHaveBeenCalled();
  });
  test('stage authority denial propagates without draft reads or effects', async () => {
    const h = harness();
    const error = new Error('current stage denial');
    h.stageRead.mockRejectedValue(error);
    await expect(h.service.get(ctx, recordId)).rejects.toBe(error);
    expect(h.drafts.listForOutreach).not.toHaveBeenCalled();
    expect(h.assertClient).not.toHaveBeenCalled();
  });
  test('current client wall revocation propagates before draft data', async () => {
    const h = harness();
    const error = new Error('current wall denial');
    h.assertClient.mockRejectedValue(error);
    await expect(h.service.get(ctx, recordId)).rejects.toBe(error);
    expect(h.drafts.listForOutreach).not.toHaveBeenCalled();
    expect(h.operation).not.toHaveBeenCalled();
  });
  test('invalid requested record UUID refuses before canonical lookup', async () => {
    const h = harness();
    await expect(h.service.get(ctx, 'n_node')).rejects.toBeInstanceOf(NotFoundException);
    expect(h.engagement.getOutreachRecord).not.toHaveBeenCalled();
  });
});
