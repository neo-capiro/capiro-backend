import { describe, expect, it } from 'vitest';
import {
  serializeUnsavedWorkspace,
  settleSaveTargets,
  shouldCreateAutosaveCheckpoint,
  type SaveTarget,
} from './save-state';

/** Counting stub — keeps this suite free of runner-specific mock generics. */
function persistStub(...outcomes: Array<'ok' | 'fail'>): {
  persist: () => Promise<unknown>;
  calls: () => number;
} {
  let call = 0;
  return {
    persist: async () => {
      const outcome = outcomes[Math.min(call, outcomes.length - 1)];
      call += 1;
      if (outcome === 'fail') throw new Error(`attempt ${call} failed`);
      return { ok: true };
    },
    calls: () => call,
  };
}

describe('settleSaveTargets', () => {
  it('reports a mixed fulfilled/rejected save without erasing the failed target', async () => {
    const targets: SaveTarget[] = [
      {
        key: 'draft-config',
        kind: 'draft-config',
        label: 'Draft settings and main document',
        persist: persistStub('ok').persist,
      },
      {
        key: 'document:doc-2',
        kind: 'packet-document',
        label: 'Packet document: Cover letter',
        persist: persistStub('fail').persist,
      },
    ];

    await expect(settleSaveTargets(targets)).resolves.toEqual({
      ok: false,
      attempted: ['draft-config', 'document:doc-2'],
      succeeded: ['draft-config'],
      failed: [
        expect.objectContaining({
          key: 'document:doc-2',
          kind: 'packet-document',
          label: 'Packet document: Cover letter',
          error: expect.any(Error),
        }),
      ],
    });
  });

  it('supports retrying only failed targets and returns success after recovery', async () => {
    const flaky = persistStub('fail', 'ok');
    const target: SaveTarget = {
      key: 'document:doc-2',
      kind: 'packet-document',
      label: 'Packet document: Cover letter',
      persist: flaky.persist,
    };

    const first = await settleSaveTargets([target]);
    expect(first.ok).toBe(false);
    const second = await settleSaveTargets([target]);
    expect(second).toEqual({
      ok: true,
      attempted: ['document:doc-2'],
      succeeded: ['document:doc-2'],
      failed: [],
    });
    expect(flaky.calls()).toBe(2);
  });

  it('treats an empty target set as trivially durable', async () => {
    await expect(settleSaveTargets([])).resolves.toEqual({
      ok: true,
      attempted: [],
      succeeded: [],
      failed: [],
    });
  });
});

describe('autosave checkpoint safety', () => {
  it('suppresses checkpoints after partial failure', () => {
    expect(
      shouldCreateAutosaveCheckpoint(
        {
          ok: false,
          attempted: ['draft-config', 'document:doc-2'],
          succeeded: ['draft-config'],
          failed: [
            {
              key: 'document:doc-2',
              kind: 'packet-document',
              label: 'Cover letter',
              error: new Error('failed'),
            },
          ],
        },
        true,
        0,
        600_000,
        300_000,
      ),
    ).toBe(false);
  });

  it('allows a checkpoint only after all attempted writes are durable', () => {
    expect(
      shouldCreateAutosaveCheckpoint(
        {
          ok: true,
          attempted: ['draft-config'],
          succeeded: ['draft-config'],
          failed: [],
        },
        true,
        0,
        600_000,
        300_000,
      ),
    ).toBe(true);
  });

  it('never checkpoints a run that attempted nothing', () => {
    expect(
      shouldCreateAutosaveCheckpoint(
        { ok: true, attempted: [], succeeded: [], failed: [] },
        true,
        0,
        600_000,
        300_000,
      ),
    ).toBe(false);
  });
});

describe('serializeUnsavedWorkspace', () => {
  it('creates a recovery payload containing failed targets and current content', () => {
    const parsed = JSON.parse(
      serializeUnsavedWorkspace({
        docTitle: 'Test draft',
        config: { sectionContent: { Overview: '<p>unsaved</p>' } },
        packetBodies: { doc2: { blocks: [{ content: 'also unsaved' }] } },
        failedKeys: ['draft-config', 'document:doc2'],
      }),
    ) as Record<string, unknown>;
    expect(parsed).toEqual(
      expect.objectContaining({
        reason: 'workspace_save_failed',
        failedTargets: ['draft-config', 'document:doc2'],
        docTitle: 'Test draft',
      }),
    );
    // The user's unsaved content must actually be recoverable from the payload.
    expect(JSON.stringify(parsed.config)).toContain('unsaved');
    expect(JSON.stringify(parsed.packetBodies)).toContain('also unsaved');
  });
});
