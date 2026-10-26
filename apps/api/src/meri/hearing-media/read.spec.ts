import { readHearingMediaRequest, readSavedHearingMedia } from './read.js';
import { withMeriToolExecutionControl } from '../meri-tool-request-control.js';

const ctx = { tenantId: 'tenant', userId: 'actor' } as never;
const request = () => ({
  schemaVersion: 'capiro.hearing-media-read/1',
  selection: {
    recordsView: 'published',
    hearingId: 'hearing',
    recordId: 'saved-record',
    clientId: null,
    asOf: null,
    cursor: null,
  },
  source: {
    recordId: 'published:saved-record:' + 'a'.repeat(64) + ':0',
    contentHash: 'a'.repeat(64),
  },
  playback: null as null | { epochId: string; positionMs: number },
});
function fixture() {
  const input = request();
  const result = {
    records: [
      {
        recordId: input.source.recordId,
        provenance: { hearingId: 'hearing', contentHash: input.source.contentHash },
      },
    ],
  };
  const tools = { executeFromAuthenticatedUser: jest.fn(async () => result) };
  const actor = jest.fn(async () => [{ actor: 'clerk-actor' }]);
  const prisma = {
    withTenantUser: jest.fn(async (_tenant, _actor, run) => run({ $queryRaw: actor })),
  };
  const fetchImpl = jest.fn(async () =>
    Response.json({ manifest: { hearingId: 'hearing', epochs: [] }, playback: null }),
  );
  return {
    input,
    result,
    tools,
    actor,
    prisma,
    fetchImpl,
    read: () =>
      readSavedHearingMedia(prisma as never, tools as never, ctx, input, fetchImpl as never),
  };
}
const originalSecret = process.env.INTERNAL_SERVICE_SECRET;
beforeEach(() => {
  process.env.INTERNAL_SERVICE_SECRET = 'synthetic-media-owner-secret';
});
afterAll(() => {
  if (originalSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
  else process.env.INTERNAL_SERVICE_SECRET = originalSecret;
});

it('binds current authorized source identity and forwards only the saved hearing and selected time to Intel', async () => {
  for (const playback of [null, { epochId: 'epoch', positionMs: 1200 }]) {
    const f = fixture();
    f.input.playback = playback;
    const value = await f.read();
    expect(value.source).toEqual({ hearingId: 'hearing', ...f.input.source });
    expect(f.tools.executeFromAuthenticatedUser).toHaveBeenCalledWith(
      ctx,
      'search_committee_hearings',
      f.input.selection,
    );
    expect(f.tools.executeFromAuthenticatedUser).toHaveBeenCalledTimes(2);
    expect(f.prisma.withTenantUser).toHaveBeenCalledWith('tenant', 'actor', expect.any(Function));
    const [url, init] = f.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/intel-api\/internal\/hearing-record-retrieval\/media$/);
    expect(JSON.parse(String(init.body))).toEqual({
      tenantId: 'tenant',
      actor: 'clerk-actor',
      eventId: 'hearing',
      playback,
    });
    expect(init.redirect).toBe('error');
  }
});

it('withholds owner media when client/wall or actor access changes during the owner call', async () => {
  for (const change of [
    (f) =>
      f.tools.executeFromAuthenticatedUser.mockRejectedValueOnce(new Error('client wall denied')),
    (f) => f.actor.mockResolvedValueOnce([]),
    (f) => f.actor.mockResolvedValueOnce([{ actor: 'replacement-actor' }]),
  ] as Array<(f: ReturnType<typeof fixture>) => void>) {
    const f = fixture();
    const ownerReply = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementationOnce(async () => {
      change(f);
      return ownerReply();
    });
    await expect(f.read()).rejects.toThrow();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  }
});

it('withholds owner media when the exact saved source changes during the owner call', async () => {
  for (const change of [
    (f) => {
      f.result.records[0]!.recordId = 'replacement-record';
    },
    (f) => {
      f.result.records[0]!.provenance.hearingId = 'replacement-hearing';
    },
    (f) => {
      f.result.records[0]!.provenance.contentHash = 'b'.repeat(64);
    },
    (f) => {
      f.result.records = [];
    },
  ] as Array<(f: ReturnType<typeof fixture>) => void>) {
    const f = fixture();
    const ownerReply = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementationOnce(async () => {
      change(f);
      return ownerReply();
    });
    await expect(f.read()).rejects.toThrow('Saved hearing record');
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  }
});

it('stops release if cancellation arrives during either final access check', async () => {
  for (const during of ['source', 'actor']) {
    const f = fixture(),
      controller = new AbortController();
    if (during === 'source') {
      f.tools.executeFromAuthenticatedUser
        .mockResolvedValueOnce(f.result)
        .mockImplementationOnce(async () => {
          controller.abort();
          return f.result;
        });
    } else {
      f.actor.mockResolvedValueOnce([{ actor: 'clerk-actor' }]).mockImplementationOnce(async () => {
        controller.abort();
        return [{ actor: 'clerk-actor' }];
      });
    }
    await expect(
      withMeriToolExecutionControl({ signal: controller.signal }, f.read),
    ).rejects.toThrow();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  }
});
it('withholds media for another source, hearing, content version or missing record', async () => {
  for (const mutate of [
    (f) => {
      f.result.records[0]!.recordId = 'other';
    },
    (f) => {
      f.result.records[0]!.provenance.hearingId = 'other';
    },
    (f) => {
      f.result.records[0]!.provenance.contentHash = 'b'.repeat(64);
    },
    (f) => {
      f.result.records = [];
    },
  ] as Array<(f: ReturnType<typeof fixture>) => void>) {
    const f = fixture();
    mutate(f);
    await expect(f.read()).rejects.toThrow('Saved hearing record');
    expect(f.fetchImpl).not.toHaveBeenCalled();
  }
});
it('preserves governed client/wall denial and current actor revocation before requesting media', async () => {
  const denied = fixture();
  denied.tools.executeFromAuthenticatedUser.mockRejectedValueOnce(new Error('client wall denied'));
  await expect(denied.read()).rejects.toThrow('client wall denied');
  expect(denied.fetchImpl).not.toHaveBeenCalled();
  const revoked = fixture();
  revoked.actor.mockResolvedValueOnce([]);
  await expect(revoked.read()).rejects.toThrow('Current hearing access');
  expect(revoked.fetchImpl).not.toHaveBeenCalled();
});
it('rejects URLs, caller authority and malformed time selectors instead of forwarding them', () => {
  for (const raw of [
    { ...request(), url: 'https://not-media.example.test/' },
    { ...request(), tenantId: 'forged' },
    { ...request(), playback: { epochId: 'epoch', positionMs: -1 } },
    { ...request(), playback: { epochId: 'epoch', positionMs: 1.5 } },
  ])
    expect(() => readHearingMediaRequest(raw)).toThrow();
});
it('preserves owner denial and rejects oversized media responses', async () => {
  const denied = fixture();
  denied.fetchImpl.mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(denied.read()).rejects.toThrow('Hearing media access unavailable');
  const large = fixture();
  large.fetchImpl.mockResolvedValueOnce(Response.json({ value: 'x'.repeat(65536) }));
  await expect(large.read()).rejects.toThrow('exceeded its bound');
});
it('cancels a denied response body and stops a cancelled request before the media owner', async () => {
  const f = fixture(),
    cancel = jest.fn();
  f.fetchImpl.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 403 }));
  await expect(f.read()).rejects.toThrow('Hearing media access unavailable');
  expect(cancel).toHaveBeenCalledTimes(1);
  const aborted = fixture(),
    controller = new AbortController();
  aborted.actor.mockImplementationOnce(async () => {
    controller.abort();
    return [{ actor: 'clerk-actor' }];
  });
  await expect(
    withMeriToolExecutionControl({ signal: controller.signal }, aborted.read),
  ).rejects.toThrow();
  expect(aborted.fetchImpl).not.toHaveBeenCalled();
});
