import { jest } from '@jest/globals';
import type { CatalogOpportunityRecord } from './funding-opportunity-v2-search.service.js';
import { enrichPipelineCatalogRows } from './funding-opportunity-pipeline-source-enrichment.js';
import { readEnabledFundingSources } from './funding-opportunity-source-access.js';
import { readCanonicalOpportunityProfile } from './funding-opportunity-v2-search.service.js';
import { readExactSourceSql } from './funding-opportunity-v2-search.sql.js';
import { sourceRecordTypeFor } from './funding-opportunity-identity.js';

jest.mock('./funding-opportunity-source-access.js', () => ({ readEnabledFundingSources: jest.fn() }));
jest.mock('./funding-opportunity-v2-search.service.js', () => ({ readCanonicalOpportunityProfile: jest.fn() }));
jest.mock('./funding-opportunity-v2-search.sql.js', () => ({ readExactSourceSql: jest.fn() }));

const TENANT = 'tenant-source-enrichment';
const CLIENT = 'client-source-enrichment';
const INPUT = { rowId: 'workflow-row', source: 'sbir_sttr', sourceRecordId: 'provider-topic', sourceRecordType: 'sbir_topic' };
const SOLICITATION_INPUT = { rowId: 'workflow-solicitation', source: 'sbir_sttr', sourceRecordId: 'provider-topic', sourceRecordType: 'sbir_solicitation' };

function record(overrides: Partial<CatalogOpportunityRecord> = {}): CatalogOpportunityRecord {
  return {
    id: 'catalog-row', source: 'sbir_sttr', sourceRecordId: 'provider-topic', title: 'Current topic title',
    agency: null, sourceUrl: null, type: 'grant', lifecycle: 'active', postedDate: null,
    deadline: '2099-10-15T00:00:00.000Z', closeOrArchiveDate: null, isPursuable: true,
    summary: null, naicsCodes: [], pscCodes: [], setAside: null, applicantTypes: [], geography: [],
    value: null, valueBasis: 'not_stated_by_source', sourceFacts: { provenance: 'tango_sbir_topic', topicNumber: 'PUBLIC-TOPIC' },
    relevanceScore: 71, matchedSignals: [{ signal: 'naicsExact', strength: 'strong', matchedOn: '541715' }],
    eligibility: { state: 'eligible', reason: 'Eligible based on current source facts.' }, clientId: CLIENT,
    clientCapability: { state: 'eligible', allowed: true, reason: 'Currently pursuable.' }, decoration: undefined,
    sectors: [], funding: [], costShare: [], methods: [], disbursement: [], grantPrerequisites: [], codes: [],
    internalEligibility: 'eligible', internalEligibilityReason: 'Eligible.', syncedAt: null, updatedAt: null,
    ...overrides,
  };
}

describe('enrichPipelineCatalogRows current-source access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(readCanonicalOpportunityProfile).mockResolvedValue({
      clientId: CLIENT, naicsCodes: [], pscCodes: [], agencies: [], sectors: [], applicantTypes: [],
    });
  });

  it('checks canonical enabled sources before any low-level exact read', async () => {
    jest.mocked(readEnabledFundingSources).mockResolvedValue(['grants_gov', 'sam_gov', 'dibbs', 'ca_portal']);
    const result = await enrichPipelineCatalogRows({} as never, TENANT, CLIENT, [INPUT]);
    expect(readEnabledFundingSources).toHaveBeenCalledWith({}, TENANT);
    expect(readExactSourceSql).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({ rowId: INPUT.rowId, title: null, deadline: null, currentSourceAvailable: false, currentEvidence: null, capability: { allowed: false } });
  });

  it('keeps enabled-source reads batched and exposes canonical current evidence', async () => {
    jest.mocked(readEnabledFundingSources).mockResolvedValue(['grants_gov', 'sam_gov', 'dibbs', 'ca_portal', 'sbir_sttr']);
    jest.mocked(readExactSourceSql).mockResolvedValue({ records: [record(), record({ sourceFacts: { provenance: 'tango_sbir_solicitation', solicitationNumber: 'PUBLIC-SOLICITATION' } })], count: 2 });
    const result = await enrichPipelineCatalogRows({} as never, TENANT, CLIENT, [INPUT, SOLICITATION_INPUT]);
    expect(readExactSourceSql).toHaveBeenCalledTimes(1);
    expect(sourceRecordTypeFor('sbir_sttr', { provenance: 'tango_sbir_topic' })).toBe('sbir_topic');
    expect(sourceRecordTypeFor('sbir_sttr', { provenance: 'tango_sbir_solicitation' })).toBe('sbir_solicitation');
    expect(readExactSourceSql).toHaveBeenCalledWith(expect.anything(), 'sbir_sttr', expect.objectContaining({ mode: 'matched', clientId: CLIENT }), expect.anything(), ['provider-topic', 'provider-topic']);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ title: 'Current topic title', sourceReference: 'PUBLIC-TOPIC', currentSourceAvailable: true, currentEvidence: { relevanceScore: 71, eligibility: { state: 'eligible' } } });
  });

  it('fails closed for missing current identity without provider-id invention', async () => {
    jest.mocked(readEnabledFundingSources).mockResolvedValue(['grants_gov', 'sam_gov', 'dibbs', 'ca_portal', 'sbir_sttr']);
    jest.mocked(readExactSourceSql).mockResolvedValue({ records: [record({ sourceRecordId: 'different-provider-id' })], count: 1 });
    const result = await enrichPipelineCatalogRows({} as never, TENANT, CLIENT, [INPUT]);
    expect(result[0]).toMatchObject({ title: null, sourceReference: null, currentSourceAvailable: false, currentEvidence: null, capability: { allowed: false } });
  });

  it('fails closed when one provider key resolves to two record types', async () => {
    jest.mocked(readEnabledFundingSources).mockResolvedValue(['grants_gov', 'sam_gov', 'dibbs', 'ca_portal', 'sbir_sttr']);
    jest.mocked(readExactSourceSql).mockResolvedValue({ records: [record(), record({ sourceFacts: { provenance: 'tango_sbir_solicitation' } })], count: 2 });
    const result = await enrichPipelineCatalogRows({} as never, TENANT, CLIENT, [{ ...INPUT, sourceRecordType: null }]);
    expect(result[0]).toMatchObject({ title: null, sourceReference: null, currentSourceAvailable: false, currentEvidence: null, capability: { allowed: false } });
  });
});
