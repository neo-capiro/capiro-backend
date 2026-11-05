import type { TenantContext } from '@capiro/shared';
import { ClientProfileFillService } from './client-profile-fill.service.js';
import { writeProfileFact } from './profile-facts.js';
jest.mock('./profile-facts.js', () => ({
  ...jest.requireActual('./profile-facts.js'),
  writeProfileFact: jest.fn(async () => ({ conflict: false })),
}));

const ctx = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '10000000-0000-4000-8000-000000000002',
  role: 'standard_user',
} as TenantContext;
const clientId = '10000000-0000-4000-8000-000000000003';
const runId = '10000000-0000-4000-8000-000000000004';
const sourceUrl = 'https://synthetic.example/news/shipyard';
const quote = 'Synthetic Systems announced a shipyard under construction in Franklin, Louisiana.';
const publishedAt = '2026-10-20';
function engine() {
  // Execute the production gather/apply methods with only I/O boundaries replaced.
  const service = Object.create(ClientProfileFillService.prototype) as any;
  Object.assign(service, {
    getClientSnapshot: jest.fn(async () => ({
      id: clientId,
      name: 'Synthetic Systems',
      website: null,
      description: 'Saved description',
    })),
    searchCompany: jest.fn(async () => []),
    searchPublicWeb: jest.fn(async () => [
      { url: sourceUrl, title: 'Synthetic shipyard announcement', snippet: quote, publishedAt },
    ]),
    people: { listPeople: jest.fn(async () => []) },
    facilities: {
      listFacilities: jest.fn(async () => []),
      createFacilityInTransaction: jest.fn(async (_tx, _ctx, _id, input) => ({
        id: 'saved-site',
        ...input,
      })),
      afterFacilityCreated: jest.fn(),
    },
    capabilities: { listCapabilities: jest.fn(async () => []) },
    addFinding: jest.fn(async () => true),
    audit: jest.fn(async () => undefined),
    applyClientField: jest.fn(),
    extractPublicWeb: jest.fn(async () => ({
      officialWebsite: { value: null },
      description: { value: null },
      people: [],
      capabilities: [],
      facilities: [
        {
          name: 'Synthetic shipyard',
          addressLine: null,
          city: 'Franklin',
          state: 'LA',
          zip: null,
          country: 'US',
          siteRole: 'manufacturing',
          siteStatus: 'under_construction',
          sourceKind: 'company',
          quote,
          evidenceUrl: sourceUrl,
        },
      ],
      news: [
        {
          title: 'Synthetic shipyard announcement',
          summary: quote,
          publishedAt,
          evidenceUrl: sourceUrl,
          quote,
          dateQuote: null,
        },
      ],
    })),
  });
  return service;
}
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-11-04T12:00:00Z'));
  jest.mocked(writeProfileFact).mockClear();
});
afterEach(() => jest.useRealTimers());
test.each(['client', 'prospect'])(
  'public research stages current sourced news for %s',
  async (kind) => {
    const service = engine();
    expect(await service.gatherPublicWeb(ctx, clientId, runId, null, { kind, id: clientId })).toBe(
      2,
    );
    const findings = service.addFinding.mock.calls.map((args: unknown[]) => args[3]);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'profile_field',
          targetKey: expect.stringMatching(/^news\./),
          proposedValue: expect.objectContaining({
            publisher: 'synthetic.example',
            publishedAt: '2026-10-20T00:00:00.000Z',
          }),
        }),
      ]),
    );
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'facility',
          proposedValue: expect.objectContaining({
            country: 'US',
            siteRole: 'manufacturing',
            siteStatus: 'under_construction',
            siteVerificationStatus: 'unverified',
          }),
          evidence: [
            expect.objectContaining({ excerpt: quote, observedAt: '2026-11-04T12:00:00.000Z' }),
          ],
        }),
      ]),
    );
  },
);
test('approved facility metadata reaches the canonical facility writer', async () => {
  const service = engine();
  const scope = { tx: { clientFacility: { findMany: jest.fn(async () => []) } }, afterCommit: [] };
  await service.applyFacility(scope, ctx, clientId, {
    proposedValue: {
      name: 'Synthetic shipyard',
      country: 'US',
      siteRole: 'manufacturing',
      siteStatus: 'under_construction',
      sourceObservedAt: '2026-11-04T12:00:00Z',
    },
    evidence: [{ url: sourceUrl, source: 'company', excerpt: quote }],
  });
  expect(service.facilities.createFacilityInTransaction).toHaveBeenCalledWith(
    scope.tx,
    ctx,
    clientId,
    expect.objectContaining({
      country: 'US',
      siteRole: 'manufacturing',
      siteStatus: 'under_construction',
      siteVerificationStatus: 'unverified',
      sourceEvidence: [{ sourceType: 'company', sourceUrl, evidence: quote }],
    }),
  );
  expect(scope.afterCommit).toHaveLength(1);
});
test('approved news remains a sourced fact without a legacy scalar-field write', async () => {
  const service = engine();
  const finding = {
    id: 'finding',
    runId,
    kind: 'profile_field',
    targetKey: 'news.event',
    proposedValue: { title: 'Synthetic award' },
    evidence: [{ url: sourceUrl }],
    confidence: 0.75,
  };
  await service.applyFindingInTransaction({ tx: {}, afterCommit: [] }, ctx, clientId, finding);
  expect(writeProfileFact).toHaveBeenCalledWith(
    {},
    ctx,
    { kind: 'client', id: clientId },
    expect.objectContaining({
      fieldKey: 'news.event',
      value: finding.proposedValue,
      evidence: finding.evidence,
    }),
  );
  expect(service.applyClientField).not.toHaveBeenCalled();
  expect(service.audit).toHaveBeenCalled();
});
