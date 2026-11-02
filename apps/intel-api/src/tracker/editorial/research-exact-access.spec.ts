import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DraftAccessService } from '../delivery/draft-access.service.js';
import { ResearchService, RESEARCH_FEATURE } from '../research/research.service.js';
import { Phase8Controller } from './editorial.controller.js';
import { Phase8EvidenceService } from './evidence.service.js';

const ctx = { tenantId: 'synthetic-tenant', clerkUserId: 'synthetic-actor', role: null };
const scope = {
  jurisdiction: 'FL',
  sessionKey: '2026',
  folderId: 'folder-one',
  clientId: 'client-one',
};
function harness() {
  const tx = { $queryRaw: jest.fn(async () => [{ id: scope.clientId }]) };
  const folders = {
    source: { activeMember: jest.fn(async () => true) },
    withActor: jest.fn(async (_ctx: unknown, fn: Function) => fn(tx)),
    folder: jest.fn(async () => ({ id: scope.folderId, clientId: scope.clientId })),
  };
  const flags = {
    isEnabled: jest.fn(async (feature: string) => feature !== 'legiwatch_editorial_v1'),
  };
  const reports = new DraftAccessService(folders as never, flags as never);
  const research = new ResearchService({ reports, folder: folders.folder } as never);
  const evidence = new Phase8EvidenceService(research);
  const exact = jest.spyOn(evidence, 'exact').mockResolvedValue({
    id: 'source-one',
    revision: 'revision-one',
    title: 'Published research',
    sourceUrl: 'https://source.example.invalid',
    text: 'Exact retained full text',
    observedAt: '2026-10-01T00:00:00Z',
    complete: true,
    authority: 'Published legislative record',
    rights: 'full_text',
  });
  return { controller: new Phase8Controller(evidence, {} as never), folders, flags, exact, tx };
}

test('research full text and basket citations work with editorial disabled', async () => {
  const { controller, flags, folders, tx } = harness();
  expect(await controller.exact(ctx, 'research', 'source-one', scope)).toMatchObject({
    text: 'Exact retained full text',
    revision: 'revision-one',
  });
  expect(flags.isEnabled).toHaveBeenCalledWith(RESEARCH_FEATURE, ctx.tenantId);
  expect(flags.isEnabled).not.toHaveBeenCalledWith('legiwatch_editorial_v1', ctx.tenantId);
  expect(folders.folder).toHaveBeenCalledWith(tx, ctx, scope.folderId, false);
  const queryValues = tx.$queryRaw.mock.calls[0] as unknown[];
  expect(queryValues).toEqual(
    expect.arrayContaining([ctx.tenantId, ctx.clerkUserId, scope.clientId]),
  );
});

test('exact research denies disabled research and revoked membership before reading', async () => {
  const { controller, flags, folders, exact } = harness();
  flags.isEnabled.mockResolvedValue(false);
  await expect(controller.exact(ctx, 'research', 'source-one', scope)).rejects.toThrow(
    NotFoundException,
  );
  flags.isEnabled.mockResolvedValue(true);
  folders.source.activeMember.mockResolvedValue(false);
  await expect(controller.exact(ctx, 'research', 'source-one', scope)).rejects.toThrow(
    ForbiddenException,
  );
  expect(exact).not.toHaveBeenCalled();
});

test('exact research preserves folder/client matching, walls, and folder revocation', async () => {
  const { controller, folders, tx, exact } = harness();
  await expect(
    controller.exact(ctx, 'research', 'source-one', { ...scope, clientId: 'other-client' }),
  ).rejects.toThrow('RESEARCH_FOLDER_CLIENT_MISMATCH');
  tx.$queryRaw.mockResolvedValueOnce([]);
  await expect(controller.exact(ctx, 'research', 'source-one', scope)).rejects.toThrow(
    'RESEARCH_CLIENT_UNAVAILABLE',
  );
  folders.folder.mockRejectedValueOnce(new ForbiddenException());
  await expect(controller.exact(ctx, 'research', 'source-one', scope)).rejects.toThrow(
    ForbiddenException,
  );
  expect(exact).not.toHaveBeenCalled();
});
