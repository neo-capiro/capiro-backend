import { researchStartRequest } from '../client-profile-fill-start-request.js';
import { readResearchInputs, researchTaskInput } from '../client-profile-fill-research-inputs.js';
const ctx = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  clerkUserId: 'fixture',
  tenantSlug: 'fixture',
  role: 'user_admin',
} as const;
const clientId = '30000000-0000-4000-8000-000000000003';
const requestId = '40000000-0000-4000-8000-000000000004';
const businessUnit = {
  id: '50000000-0000-4000-8000-000000000005',
  name: 'Fixture reviewed unit',
  annualReportYear: 2026,
  sourceUrls: ['https://company.example/annual-report'],
};
describe('durable business unit input binding', () => {
  it('includes selected business unit in the request identity while preserving omitted historic input', () => {
    const old = researchStartRequest(ctx, clientId, { requestId, sources: ['public_web'] });
    expect(
      researchStartRequest(ctx, clientId, {
        requestId,
        sources: ['public_web'],
        businessUnitId: undefined,
      }),
    ).toEqual(old);
    expect(
      researchStartRequest(ctx, clientId, {
        requestId,
        sources: ['public_web'],
        businessUnitId: businessUnit.id,
      })?.sha256,
    ).not.toBe(old?.sha256);
  });
  it.each(['public_web', 'client_document'])(
    'retains approved unit snapshot for %s retries',
    (task) => {
      const saved = researchTaskInput(task, 'https://company.example', [], businessUnit);
      expect(readResearchInputs(saved, task).businessUnit).toEqual(businessUnit);
    },
  );
  it('rejects malformed saved unit scope instead of widening research to the whole company', () => {
    expect(() =>
      readResearchInputs(
        {
          researchInputVersion: 1,
          website: 'https://company.example',
          businessUnit: { id: 'unbound', name: 'Fixture' },
        },
        'public_web',
      ),
    ).toThrow('Invalid saved business unit');
  });
});
