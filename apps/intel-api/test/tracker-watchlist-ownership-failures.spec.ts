import {
  fullWriteHarness,
  fullWriteInput,
  writeOperations,
} from './fixtures/tracker-watchlist-ownership/write-case.js';
import {
  CLIENT,
  TENANT,
  USER,
  namesWithoutScopes,
} from './fixtures/tracker-watchlist-ownership/io.js';

it.each(writeOperations)(
  'failure at %s stops the write pipeline without publishing a view',
  async (stage) => {
    const h = fullWriteHarness();
    h.tape.failures.set(stage, new Error(`failure:${stage}`));
    await expect(h.service.putWatchlist(TENANT, CLIENT, USER, fullWriteInput)).rejects.toThrow(
      `failure:${stage}`,
    );
    expect(namesWithoutScopes(h.tape)).toEqual(
      writeOperations.slice(0, writeOperations.indexOf(stage) + 1),
    );
    expect(namesWithoutScopes(h.tape)).not.toContain('view.head');
    expect(h.tape.calls.some((call) => call.name === 'tenant.commit')).toBe(false);
    if (stage.startsWith('write.')) expect(h.tape.calls.at(-1)!.name).toBe('tenant.rollback');
  },
);

it('a view failure after commit reports failure without rolling back the completed write', async () => {
  const h = fullWriteHarness();
  h.tape.failures.set('view.head', new Error('post-commit view failure'));
  await expect(h.service.putWatchlist(TENANT, CLIENT, USER, fullWriteInput)).rejects.toThrow(
    'post-commit view failure',
  );
  expect(namesWithoutScopes(h.tape)).toEqual([...writeOperations, 'view.head']);
  expect(h.tape.calls.find((call) => call.name === 'write.revision')!.scope).toBe(1);
  expect(
    h.tape.calls.filter((call) => call.name === 'tenant.commit').map((call) => call.scope),
  ).toEqual([1]);
  expect(h.tape.calls.at(-1)).toMatchObject({ name: 'tenant.rollback', scope: 2 });
});

it('post-commit name lookup failure is swallowed without losing the accepted save', async () => {
  const h = fullWriteHarness();
  h.tape.failures.set('system.name', new Error('writer unavailable'));
  expect(await h.service.putWatchlist(TENANT, CLIENT, USER, fullWriteInput)).toMatchObject({
    version: 8,
    updatedByName: null,
    rejected: { topics: [], terms: [] },
  });
  expect(h.tape.calls.filter((call) => call.name === 'write.revision')).toHaveLength(1);
  expect(h.logger.warn).toHaveBeenCalledWith('resolveUserName failed: writer unavailable');
});
