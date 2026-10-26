import { HearingRecordRetrievalController } from './hearing-record-retrieval.controller.js';
const original = process.env.INTERNAL_SERVICE_SECRET;
beforeEach(() => {
  process.env.INTERNAL_SERVICE_SECRET = 'synthetic-owner';
});
afterAll(() => {
  if (original === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
  else process.env.INTERNAL_SERVICE_SECRET = original;
});
function fixture() {
  const records = { authorize: jest.fn(async () => undefined) };
  const audio = {
    manifest: jest.fn(async () => ({ hearingId: 'hearing', epochs: [] })),
    playback: jest.fn(async () => ({
      partId: 'part',
      startMs: 1000,
      endMs: 2000,
      url: 'https://media.example.test/synthetic',
      expiresAt: new Date('2026-10-26T00:00:30Z'),
    })),
  };
  const controller = new HearingRecordRetrievalController(records as never, audio as never);
  const body = {
    tenantId: 'tenant',
    actor: 'actor',
    eventId: 'hearing',
    playback: null as unknown,
  };
  return {
    records,
    audio,
    controller,
    body,
    read: () => controller.media('synthetic-owner', body),
  };
}
it('uses the current public audio owner for manifest and exact epoch/time playback', async () => {
  const f = fixture();
  expect((await f.read()).manifest?.hearingId).toBe('hearing');
  expect(f.audio.manifest).toHaveBeenCalledWith(
    { tenantId: 'tenant', clerkUserId: 'actor', role: null },
    'hearing',
  );
  f.body.playback = { epochId: 'epoch', positionMs: 1500 };
  const value = await f.read();
  expect(value.playback?.epochId).toBe('epoch');
  expect(f.audio.playback).toHaveBeenCalledWith(
    { tenantId: 'tenant', clerkUserId: 'actor', role: null },
    'hearing',
    'epoch',
    1500,
  );
});
it('rejects missing service identity and current source denial before the media owner', async () => {
  const f = fixture();
  await expect(f.controller.media(undefined, f.body)).rejects.toThrow();
  expect(f.records.authorize).not.toHaveBeenCalled();
  f.records.authorize.mockRejectedValueOnce(new Error('revoked'));
  await expect(f.read()).rejects.toThrow('revoked');
  expect(f.audio.manifest).not.toHaveBeenCalled();
});
it('refuses malformed or caller-invented media addresses and preserves owner playback denial', async () => {
  const f = fixture();
  f.body.playback = { epochId: 'epoch', positionMs: 1, url: 'https://forged.example.test' };
  await expect(f.read()).rejects.toThrow('VALID_MEDIA_POSITION_REQUIRED');
  expect(f.audio.playback).not.toHaveBeenCalled();
  f.body.playback = { epochId: 'epoch', positionMs: 1500 };
  f.audio.playback.mockRejectedValueOnce(new Error('saved audio expired'));
  await expect(f.read()).rejects.toThrow('saved audio expired');
});
