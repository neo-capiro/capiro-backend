import { EventEmitter } from 'node:events';
import { ConnectedAppReadController } from './connected-app-read.controller.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import { ObjectiveJobReadSources } from './objective-job-read-sources.js';
import type { TenantContext } from '@capiro/shared';
const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'standard_user',
} as TenantContext;
const selectors = {
  connectionId: '33333333-3333-4333-8333-333333333333',
  teamId: '44444444-4444-4444-8444-444444444444',
};
function request(verified = true) {
  const req = Object.assign(new EventEmitter(), {
    headers: { 'x-internal-service-secret': 'synthetic-service' },
  });
  if (verified)
    new ToolServiceSecretGuard({
      get: (key: string) =>
        key === 'INTERNAL_SERVICE_SECRET'
          ? 'synthetic-service'
          : key === 'NODE_ENV'
            ? 'test'
            : false,
    } as never).verifyRequest(req as never);
  return req;
}
test('fixed connected/Teams controllers require actual service proof, not a header alone', async () => {
  const connected = { read: jest.fn(async () => ({ status: 'unavailable' })) },
    teams = { readTeams: jest.fn(async () => ({ kind: 'unavailable' })) };
  const controller = new ConnectedAppReadController(connected as never, teams as never);
  for (const [method, body] of [
    ['list', { clientId: null }],
    ['read', {}],
    ['channels', selectors],
    ['messages', { ...selectors, channelId: '19:fixture' }],
  ] as const)
    expect(() => controller[method](ctx, body, request(false) as never)).toThrow(
      'Internal service required',
    );
  expect(connected.read).not.toHaveBeenCalled();
  expect(teams.readTeams).not.toHaveBeenCalled();
  await controller.list(ctx, { clientId: null }, request() as never);
  await controller.channels(ctx, selectors, request() as never);
  expect(connected.read).toHaveBeenCalledWith(ctx, 'list_connected_app_reads', { clientId: null });
  expect(teams.readTeams).toHaveBeenCalledWith(ctx, 'list_teams_channels', selectors);
});
test('deployment allowlist still refuses an unallocated fixed read', () => {
  const previous = process.env.MERI_TOOL_ALLOWLIST;
  process.env.MERI_TOOL_ALLOWLIST = 'search_emails';
  try {
    expect(() =>
      new ConnectedAppReadController({} as never, {} as never).channels(
        ctx,
        selectors,
        request() as never,
      ),
    ).toThrow();
  } finally {
    if (previous === undefined) delete process.env.MERI_TOOL_ALLOWLIST;
    else process.env.MERI_TOOL_ALLOWLIST = previous;
  }
});
test('saved-job dispatch binds the current job client and uses the same concrete owners', async () => {
  const connected = { read: jest.fn(async () => ({})) },
    teams = { readTeams: jest.fn(async () => ({})) };
  const sources = new ObjectiveJobReadSources(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    connected as never,
    teams as never,
  );
  await sources.read(ctx, null, 'list_connected_app_reads', { clientId: null });
  await sources.read(ctx, null, 'list_teams_channels', selectors);
  await expect(
    sources.read(ctx, ctx.userId, 'list_connected_app_reads', { clientId: null }),
  ).rejects.toThrow();
  await expect(sources.read(ctx, ctx.userId, 'list_teams_channels', selectors)).rejects.toThrow();
  expect(connected.read).toHaveBeenCalledTimes(1);
  expect(teams.readTeams).toHaveBeenCalledTimes(1);
});
