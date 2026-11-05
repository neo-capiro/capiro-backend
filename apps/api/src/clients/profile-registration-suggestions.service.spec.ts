jest.mock('./profile-suggestion-sources.service.js', () => ({
  ProfileSuggestionSourcesService: class {},
}));
import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { ProfileRegistrationSuggestionsService } from './profile-registration-suggestions.service.js';
import { PortfolioAgentError, type PortfolioAgentRequest } from './portfolio-agent.service.js';

const ctx = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '10000000-0000-4000-8000-000000000002',
  clerkUserId: 'fixture',
  role: 'standard_user',
} as TenantContext;
const request = {
  requestId: '10000000-0000-4000-8000-000000000003',
  field: 'naicsCodes',
  identity: {
    name: 'Fixture engineering',
    description: 'Engineering design services for aircraft',
  },
};
const supported = {
  code: '541330',
  reason: 'Engineering service description matches this classification.',
  sourceId: 'person_context',
  quote: 'Engineering design services for aircraft',
  confidence: 0.9,
};
function fixture(suggestions: unknown[] = [supported]) {
  const membership = jest.fn().mockResolvedValue({ role: 'standard_user' });
  const tx = { tenantMembership: { findFirst: membership }, auditLog: { create: jest.fn() } };
  const prisma = {
    withTenantUser: jest.fn((_tenant, _user, callback) => callback(tx)),
    ldaIssueCode: { findMany: jest.fn().mockResolvedValue([{ code: 'DEF', name: 'Defense' }]) },
  };
  const extract = jest.fn(async (_input: PortfolioAgentRequest) => ({
    data: { suggestions },
    audit: {},
  }));
  const reader = { website: jest.fn(), document: jest.fn() };
  return {
    service: new ProfileRegistrationSuggestionsService(
      prisma as never,
      { extract } as never,
      reader as never,
    ),
    prisma,
    tx,
    membership,
    extract,
    reader,
  };
}

describe('manual registration suggestions', () => {
  it('uses bounded source-only SDK input and official labels without saving a profile', async () => {
    const f = fixture();
    const result = await f.service.suggest(ctx, request);
    expect(result).toMatchObject({
      status: 'complete',
      field: 'naicsCodes',
      suggestions: [
        {
          code: '541330',
          label: 'Engineering Services',
          evidence: [{ excerpt: supported.quote, source: 'person_context' }],
          reference: { kind: 'naics', sourceUrl: expect.stringMatching(/^https:\/\//) },
        },
      ],
    });
    expect(f.extract).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: { kind: 'draft', id: request.requestId },
        task: 'registration_suggestions',
        maxTurns: 4,
        maxBudgetUsd: 0.5,
        timeoutMs: 60_000,
      }),
    );
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
    expect(f.prisma.withTenantUser).toHaveBeenCalledWith(
      ctx.tenantId,
      ctx.userId,
      expect.any(Function),
    );
  });
  it.each([
    { ...supported, code: '999999' },
    { ...supported, quote: 'A claim absent from the supplied source' },
    { ...supported, sourceId: 'reference_0' },
  ])(
    'omits unknown codes, fabricated quotes and catalog-only company evidence',
    async (suggestion) => {
      expect((await fixture([suggestion]).service.suggest(ctx, request)).status).toBe('empty');
    },
  );
  it('does not suggest a code the person already entered', async () => {
    expect(
      (await fixture().service.suggest(ctx, { ...request, currentValue: ['541330'] })).suggestions,
    ).toEqual([]);
  });
  it('requires a literal complete identifier in its quoted company source', async () => {
    const f = fixture([{ ...supported, code: 'ABCDE1234567' }]);
    expect((await f.service.suggest(ctx, { ...request, field: 'uei' })).suggestions).toEqual([]);
    const identifier = { ...supported, code: 'ABCDE1234567', quote: 'Our UEI is ABCDE1234567' };
    const response = await fixture([identifier]).service.suggest(ctx, {
      ...request,
      field: 'uei',
      contextText: identifier.quote,
    });
    expect(response.suggestions[0]).toMatchObject({
      code: identifier.code,
      label: 'Unique Entity ID (UEI)',
    });
  });
  it('validates LDA issue codes against the canonical directory and exposes its official reference', async () => {
    const result = await fixture([{ ...supported, code: 'DEF' }]).service.suggest(ctx, {
      ...request,
      field: 'issueCodes',
    });
    expect(result.suggestions[0]).toMatchObject({
      code: 'DEF',
      label: 'Defense',
      reference: {
        sourceUrl: 'https://lobbyingdisclosure.house.gov/help/WordDocuments/lobbyingissuecodes.htm',
      },
    });
  });
  it('reports an unavailable official catalog without invoking a model', async () => {
    const f = fixture();
    f.prisma.ldaIssueCode.findMany.mockResolvedValue([]);
    expect((await f.service.suggest(ctx, { ...request, field: 'issueCodes' })).status).toBe(
      'unavailable',
    );
    expect(f.extract).not.toHaveBeenCalled();
  });
  it('reports a website outage while retaining supported person-context suggestions', async () => {
    const f = fixture();
    f.reader.website.mockRejectedValue(new Error('fixture outage'));
    const result = await f.service.suggest(ctx, {
      ...request,
      identity: { ...request.identity, website: 'fixture.example' },
    });
    expect(result.status).toBe('complete');
    expect(result.sourceGaps).toHaveLength(1);
  });
  it('does not return private source output after actor access is revoked during SDK work', async () => {
    const f = fixture();
    f.extract.mockImplementation(async () => {
      f.membership.mockResolvedValue(null);
      return { data: { suggestions: [supported] }, audit: {} };
    });
    await expect(f.service.suggest(ctx, request)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('turns bounded SDK failure into an explicit unavailable result', async () => {
    const f = fixture();
    f.extract.mockRejectedValue(new PortfolioAgentError('unavailable', {} as never));
    expect((await f.service.suggest(ctx, request)).status).toBe('unavailable');
  });
  it('rejects attachments without a saved subject and pre-aborted work before model execution', async () => {
    const f = fixture();
    await expect(
      f.service.suggest(ctx, { ...request, attachmentIds: [request.requestId] }),
    ).rejects.toThrow('saved profile');
    const abort = new AbortController();
    abort.abort();
    await expect(f.service.suggest(ctx, request, abort.signal)).rejects.toThrow();
    expect(f.extract).not.toHaveBeenCalled();
  });
});
