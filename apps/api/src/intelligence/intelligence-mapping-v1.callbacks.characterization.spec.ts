import {
  type Call,
  clientId,
  confirmationInput,
  deferred,
  harness,
  installHooks,
  manualInput,
  mappingId,
  mappingRow,
  tenantId,
} from '../../test/fixtures/intelligence-mapping.js';

installHooks();
type Path = 'manual' | 'confirm';
const paths: Path[] = ['manual', 'confirm'];
function invoke(h: ReturnType<typeof harness>, path: Path) {
  return path === 'manual'
    ? h.service.createManualMapping(clientId, tenantId, manualInput())
    : h.service.confirmMapping(mappingId, confirmationInput(), tenantId);
}
function fixture(rows: Record<string, unknown> = {}, prepopulation?: false) {
  const saved = mappingRow({ source: 'lda', confirmed: true });
  return {
    saved,
    h: harness({
      prepopulation,
      rows: { existing: mappingRow(), upsert: saved, update: saved, ...rows },
    }),
  };
}

describe('LDA mapping awaited postcommit cascade', () => {
  test.each(paths)(
    '%s awaits the callback after commit and ignores its returned value',
    async (path) => {
      const cascade = deferred<unknown>();
      const { h, saved } = fixture({ prepopulate: cascade.promise });
      let settled = false;
      const pending = invoke(h, path).then((value) => {
        settled = true;
        return value;
      });
      await h.started('prepopulate');
      expect(h.transactions.every((tx) => tx.outcome === 'commit')).toBe(true);
      expect(h.events.at(-2)).toBe('tenant:commit');
      expect(h.callsOf('prepopulate')[0]!.args).toEqual([tenantId, clientId]);
      expect(settled).toBe(false);
      cascade.resolve({ ignored: true });
      expect(await pending).toBe(saved);
    },
  );
  test.each(paths)('%s preserves committed writes when the callback rejects', async (path) => {
    const error = new Error('Cascade failed after commit');
    const { h } = fixture({ prepopulate: error });
    await expect(invoke(h, path)).rejects.toBe(error);
    expect(h.transactions.map((tx) => tx.outcome)).toEqual(
      path === 'manual' ? ['commit', 'commit'] : ['commit'],
    );
    expect(h.callsOf('audit')).toHaveLength(1);
    expect(h.events.at(-1)).toBe('prepopulate');
  });
  test.each(paths)('%s tolerates an absent optional collaborator', async (path) => {
    const { h, saved } = fixture({}, false);
    expect(await invoke(h, path)).toBe(saved);
    expect(h.prepopulation.prepopulate).not.toHaveBeenCalled();
  });
});

describe('LDA mapping current optional collaborator lookup', () => {
  test.each(paths)('%s uses a replacement installed while the audit is pending', async (path) => {
    const audit = deferred<unknown>();
    const { h, saved } = fixture({ audit: audit.promise });
    const replacement = { prepopulate: jest.fn(async () => undefined) };
    const pending = invoke(h, path);
    await h.started('audit');
    expect(h.transactions.at(-1)!.outcome).toBe('');
    h.setPrepopulation(replacement);
    audit.resolve({});
    expect(await pending).toBe(saved);
    expect(h.prepopulation.prepopulate).not.toHaveBeenCalled();
    expect(replacement.prepopulate).toHaveBeenCalledWith(tenantId, clientId);
    expect(replacement.prepopulate.mock.contexts[0]).toBe(replacement);
    expect(h.transactions.at(-1)!.outcome).toBe('commit');
  });
  test.each(paths)('%s observes collaborator removal across the database await', async (path) => {
    const audit = deferred<unknown>();
    const { h, saved } = fixture({ audit: audit.promise });
    const pending = invoke(h, path);
    await h.started('audit');
    h.setPrepopulation(undefined);
    audit.resolve({});
    expect(await pending).toBe(saved);
    expect(h.prepopulation.prepopulate).not.toHaveBeenCalled();
  });
});

describe('LDA mapping late collaborator addition and actual identity route', () => {
  test.each(paths)(
    '%s observes addition after an absent constructor collaborator',
    async (path) => {
      const audit = deferred<unknown>();
      const { h, saved } = fixture({ audit: audit.promise }, false);
      const added = { prepopulate: jest.fn(async () => undefined) };
      const pending = invoke(h, path);
      await h.started('audit');
      h.setPrepopulation(added);
      audit.resolve({});
      expect(await pending).toBe(saved);
      expect(added.prepopulate).toHaveBeenCalledWith(tenantId, clientId);
    },
  );
  test('lets the inert cascade call the real confirmed-LDA reader after the mapping commit', async () => {
    let h!: ReturnType<typeof harness>;
    h = harness({
      rows: {
        mappings: [mappingRow({ externalId: '12' }), mappingRow({ externalId: '99' })],
        prepopulate: (call: Call) =>
          h.identity.confirmedLdaIds(call.args[1] as string, call.args[0] as string),
      },
    });
    const result = await h.service.createManualMapping(clientId, tenantId, manualInput());
    expect(result.source).toBe('lda');
    expect(h.callsOf('mappings')[0]).toMatchObject({
      scope: 'tenant',
      tenantId,
      transaction: 3,
      args: [{ where: { clientId, source: 'lda', confirmed: true }, select: { externalId: true } }],
    });
    expect(h.events.slice(-5)).toEqual([
      'prepopulate',
      'withTenant',
      'tenant:begin',
      'mappings',
      'tenant:commit',
    ]);
    expect(h.transactions.map((tx) => tx.outcome)).toEqual(['commit', 'commit', 'commit']);
  });
});

describe('Mapping confirmation saved-row callback authority', () => {
  test('passes the saved mapping client ID to the cascade after checking the original owning client', async () => {
    const saved = mappingRow({ source: 'lda', clientId: 'saved-client' });
    const { h } = fixture({ update: saved });
    expect(await invoke(h, 'confirm')).toBe(saved);
    expect(h.callsOf('client')[0]!.args).toEqual([
      { where: { id: clientId }, select: { id: true } },
    ]);
    expect(h.prepopulation.prepopulate).toHaveBeenCalledWith(tenantId, 'saved-client');
  });
  test('decides the cascade from saved source rather than the pre-update row source', async () => {
    const saved = mappingRow({ source: 'fec_employer' });
    const { h } = fixture({ update: saved });
    expect(await invoke(h, 'confirm')).toBe(saved);
    expect(h.prepopulation.prepopulate).not.toHaveBeenCalled();
    expect(h.transactions[0]!.outcome).toBe('commit');
  });
});
