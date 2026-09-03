import { describe, expect, it, jest, afterEach } from '@jest/globals';
import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { HillDayGenerationService } from './hillday-generation.service.js';

const doc = { id: 'doc-1', tenantId: 't', ownerId: 'user-1', clientId: 'client-1', timeZone: 'America/New_York', lookbackDays: 90 };
const meeting = {
  id: 'm-1',
  eventId: 'e-1',
  ordinal: 0,
  event: { subject: 'Meeting with Sen. Wicker', startsAt: '2026-09-14T13:00:00.000Z', endsAt: '2026-09-14T13:30:00.000Z' },
  resolution: { office: { member: 'Sen. Roger Wicker (R-MS)' }, attendees: [] },
  context: null,
  section: null,
};

function makeHarness(opts: { credential?: { provider: 'anthropic'; secret: string; model: string; usedTenantKey: boolean } | null } = {}) {
  const prisma = {
    wsHillDayDocument: { findFirst: jest.fn(async () => doc) },
    wsHillDayMeeting: { findFirst: jest.fn(async () => meeting) },
  };
  const credentials = {
    resolveAnthropic: jest.fn(async () => (opts.credential === undefined ? { provider: 'anthropic' as const, secret: 'sk-test', model: 'claude-sonnet-4-6', usedTenantKey: false } : opts.credential)),
  };
  const service = new HillDayGenerationService(prisma as never, {} as never, credentials as never);
  return { service, prisma, credentials };
}

describe('HillDayGenerationService.refineText', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects when the caller is not the document owner', async () => {
    const { service } = makeHarness();
    await expect(service.refineText('t', 'intruder', 'doc-1', 'm-1', 'focus', 'Some draft text.')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects an unknown section', async () => {
    const { service, prisma } = makeHarness();
    prisma.wsHillDayMeeting.findFirst.mockResolvedValueOnce(null as never);
    await expect(service.refineText('t', 'user-1', 'doc-1', 'missing', 'focus', 'Some draft text.')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects empty text', async () => {
    const { service } = makeHarness();
    await expect(service.refineText('t', 'user-1', 'doc-1', 'm-1', 'focus', '   ')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('surfaces a clear error when no model credential is configured', async () => {
    const { service } = makeHarness({ credential: null });
    await expect(service.refineText('t', 'user-1', 'doc-1', 'm-1', 'focus', 'Some draft text.')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('sends the draft to the model and returns the refined text', async () => {
    const { service } = makeHarness();
    const captured: { body: { system?: string; messages?: Array<{ content: string }> } | null } = { body: null };
    global.fetch = (async (_url: string, init: { body: string }) => {
      captured.body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: 'A tighter, cleaner version of the draft.' }] }),
      };
    }) as unknown as typeof fetch;

    const result = await service.refineText('t', 'user-1', 'doc-1', 'm-1', 'focus', 'a rough draft with some typos');
    expect(result.text).toBe('A tighter, cleaner version of the draft.');
    expect(captured.body?.messages?.[0]?.content).toContain('a rough draft with some typos');
    expect(captured.body?.messages?.[0]?.content).toContain('Sen. Roger Wicker (R-MS)');
    expect(captured.body?.system).toContain('never invent');
  });

  it('surfaces a clear error when the provider call fails', async () => {
    const { service } = makeHarness();
    global.fetch = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(service.refineText('t', 'user-1', 'doc-1', 'm-1', 'focus', 'Some draft text.')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
