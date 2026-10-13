import {
  clientId,
  harness,
  installHooks,
  now,
  tenantId,
  userId,
} from '../../test/fixtures/intelligence-supporting.js';

const select = {
  id: true,
  title: true,
  body: true,
  sourceAlertId: true,
  sourceType: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
};
installHooks();

it('brief list preserves tenant/client selection, descending order and the exact selected result array', async () => {
  const rows = [{ id: 'one', createdAt: now, updatedAt: now }];
  const h = harness({ results: { briefs: rows } });
  expect(await h.service.listClientBriefs(tenantId, clientId)).toBe(rows);
  expect(h.callsOf('briefs')[0]).toMatchObject({
    scope: 'tenant',
    tenantId,
    transaction: 1,
    args: [{ where: { clientId }, orderBy: { createdAt: 'desc' }, select }],
  });
  expect(h.transactions).toEqual([{ id: 1, tenantId, outcome: 'commit' }]);
});

it('brief creation validates tenant client then writes in a second transaction with defaults and actor provenance', async () => {
  const row = { id: 'created', createdAt: now };
  const h = harness({ results: { createBrief: row } });
  const input = { title: '  Watch NDAA  ', body: '  markup next week  ' };
  expect(await h.service.addClientBrief(tenantId, clientId, userId, input)).toBe(row);
  expect(h.callsOf('client')[0]).toMatchObject({
    scope: 'tenant',
    tenantId,
    transaction: 1,
    args: [{ where: { id: clientId }, select: { id: true } }],
  });
  expect(h.callsOf('createBrief')[0]).toMatchObject({
    scope: 'tenant',
    tenantId,
    transaction: 2,
    args: [
      {
        data: {
          tenantId,
          clientId,
          createdBy: userId,
          title: 'Watch NDAA',
          body: 'markup next week',
          sourceAlertId: null,
          sourceType: 'manual',
        },
        select,
      },
    ],
  });
  expect(h.transactions).toEqual([
    { id: 1, tenantId, outcome: 'commit' },
    { id: 2, tenantId, outcome: 'commit' },
  ]);
  expect(h.events).toEqual([
    'tenant.begin',
    'client',
    'tenant.commit',
    'tenant.begin',
    'createBrief',
    'tenant.commit',
  ]);
  expect(input).toEqual({ title: '  Watch NDAA  ', body: '  markup next week  ' });
});

it('brief creation trims before the 300-code-unit title cap and preserves the entire trimmed body', async () => {
  const h = harness();
  const title = `  ${'T'.repeat(340)}  `;
  const body = `  ${'body '.repeat(100)}  `;
  await h.service.addClientBrief(tenantId, clientId, userId, { title, body });
  expect(h.callsOf('createBrief')[0]!.args).toEqual([
    {
      data: {
        tenantId,
        clientId,
        createdBy: userId,
        title: 'T'.repeat(300),
        body: body.trim(),
        sourceAlertId: null,
        sourceType: 'manual',
      },
      select,
    },
  ]);
});

it.each([
  { sourceAlertId: null, sourceType: null, expectedAlert: null, expectedType: 'manual' },
  { sourceAlertId: '', sourceType: '', expectedAlert: '', expectedType: '' },
  {
    sourceAlertId: 'alert-one',
    sourceType: 'catalog',
    expectedAlert: 'alert-one',
    expectedType: 'catalog',
  },
])(
  'brief creation preserves nullish/default and explicit-empty source operands: $sourceType',
  async (row) => {
    const h = harness();
    await h.service.addClientBrief(tenantId, clientId, userId, {
      title: 'Title',
      body: 'Body',
      sourceAlertId: row.sourceAlertId,
      sourceType: row.sourceType,
    });
    expect(h.callsOf('createBrief')[0]!.args).toEqual([
      {
        data: {
          tenantId,
          clientId,
          createdBy: userId,
          title: 'Title',
          body: 'Body',
          sourceAlertId: row.expectedAlert,
          sourceType: row.expectedType,
        },
        select,
      },
    ]);
  },
);

it('brief creation preserves blank trimmed title/body without adding new service validation', async () => {
  const h = harness();
  await h.service.addClientBrief(tenantId, clientId, userId, { title: '  ', body: '\n  ' });
  expect(h.callsOf('createBrief')[0]!.args).toEqual([
    {
      data: {
        tenantId,
        clientId,
        createdBy: userId,
        title: '',
        body: '',
        sourceAlertId: null,
        sourceType: 'manual',
      },
      select,
    },
  ]);
});

it('brief creation refuses a missing tenant client before opening a write transaction', async () => {
  const h = harness({ results: { client: null } });
  await expect(
    h.service.addClientBrief(tenantId, clientId, userId, { title: 'Title', body: 'Body' }),
  ).rejects.toThrow('Client not found');
  expect(h.callsOf('createBrief')).toEqual([]);
  expect(h.transactions).toEqual([{ id: 1, tenantId, outcome: 'commit' }]);
});

it('brief creation propagates validation I/O failure and rolls back without any write', async () => {
  const failure = new Error('Client read failed');
  const h = harness({ errors: { client: failure } });
  await expect(
    h.service.addClientBrief(tenantId, clientId, userId, { title: 'Title', body: 'Body' }),
  ).rejects.toBe(failure);
  expect(h.callsOf('createBrief')).toEqual([]);
  expect(h.transactions).toEqual([{ id: 1, tenantId, outcome: 'rollback' }]);
});

it('brief creation retains the committed validation read when the separate write transaction fails', async () => {
  const failure = new Error('Create failed');
  const h = harness({ errors: { createBrief: failure } });
  await expect(
    h.service.addClientBrief(tenantId, clientId, userId, { title: 'Title', body: 'Body' }),
  ).rejects.toBe(failure);
  expect(h.transactions).toEqual([
    { id: 1, tenantId, outcome: 'commit' },
    { id: 2, tenantId, outcome: 'rollback' },
  ]);
});

it.each([0, 3])(
  'brief deletion retains tenant/client/brief constraints and returns ok independently of deleted count %s',
  async (count) => {
    const h = harness({ results: { deleteBrief: { count } } });
    await expect(h.service.deleteClientBrief(tenantId, clientId, 'brief-one')).resolves.toEqual({
      ok: true,
    });
    expect(h.callsOf('deleteBrief')[0]).toMatchObject({
      scope: 'tenant',
      tenantId,
      transaction: 1,
      args: [{ where: { id: 'brief-one', clientId } }],
    });
    expect(h.transactions).toEqual([{ id: 1, tenantId, outcome: 'commit' }]);
  },
);

it.each(['briefs', 'deleteBrief'])(
  'brief %s propagates its I/O error and transaction rollback',
  async (operation) => {
    const failure = new Error(`${operation} failed`);
    const h = harness({ errors: { [operation]: failure } });
    const pending =
      operation === 'briefs'
        ? h.service.listClientBriefs(tenantId, clientId)
        : h.service.deleteClientBrief(tenantId, clientId, 'one');
    await expect(pending).rejects.toBe(failure);
    expect(h.transactions).toEqual([{ id: 1, tenantId, outcome: 'rollback' }]);
  },
);
