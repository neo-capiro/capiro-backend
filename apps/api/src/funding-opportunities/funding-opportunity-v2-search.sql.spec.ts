import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  GRANTS_GOV_APPLICANT_TYPES as TYPES,
  GRANTS_GOV_OTHER_APPLICANTS,
  normalizeOpportunitySearchCriteria,
  type OpportunitySourceV2,
} from '@capiro/shared';
import { healthSql, readExactSourceSql, searchSourceSql } from './funding-opportunity-v2-search.sql.js';

const TEST_DATABASE_URL = process.env.FUNDING_OPPORTUNITIES_TEST_DATABASE_URL;
const parsedUrl = TEST_DATABASE_URL ? new URL(TEST_DATABASE_URL) : null;
if (TEST_DATABASE_URL && !(
  parsedUrl?.protocol === 'postgresql:' && parsedUrl.hostname === '127.0.0.1'
    && parsedUrl.port === '5486' && parsedUrl.pathname === '/fo_v2_search'
    && parsedUrl.searchParams.get('schema') === 'public' && parsedUrl.username === 'fo_test'
    && parsedUrl.password.length > 0
)) {
  throw new Error('FUNDING_OPPORTUNITIES_TEST_DATABASE_URL must be the explicit isolated fo_v2_search URL.');
}
const useIsolatedDatabase = Boolean(
  parsedUrl && parsedUrl.protocol === 'postgresql:' && parsedUrl.hostname === '127.0.0.1'
    && parsedUrl.port === '5486' && parsedUrl.pathname === '/fo_v2_search'
    && parsedUrl.searchParams.get('schema') === 'public' && parsedUrl.username === 'fo_test'
    && parsedUrl.password.length > 0,
);
const describeDb = useIsolatedDatabase ? describe : describe.skip;

jest.setTimeout(60_000);

const db = useIsolatedDatabase
  ? new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } })
  : null;
const prefix = `sql-applicants-${Date.now()}-`;
const adapter = { withSystem: async <T>(fn: (tx: PrismaClient) => Promise<T>) => fn(db!) };
const profile = {
  clientId: '11111111-1111-4111-8111-111111111111',
  naicsCodes: [],
  pscCodes: [],
  agencies: [],
  sectors: [],
  applicantTypes: [TYPES[13]],
};

function criteria(patch: Record<string, unknown> = {}) {
  return normalizeOpportunitySearchCriteria({
    mode: 'all', lifecycle: [], query: '', page: 1, pageSize: 100, ...patch,
  }).criteria;
}

describeDb('funding opportunity applicant SQL correction (isolated Postgres)', () => {
  const ids: string[] = [];

  beforeAll(async () => {
    await db!.$connect();
    const rows: Array<[string, string]> = [
      ['forprofit', TYPES[12]], ['smallbiz', TYPES[13]],
      ['nonprofit', TYPES[1]], ['nonprofit-unc', TYPES[9]],
      ['localgov', TYPES[7]], ['tribal', TYPES[2]], ['tribal-org', TYPES[6]],
      ['academic', TYPES[4]], ['academic-private', TYPES[5]],
      ['mixed-nonprofit', TYPES[1]], ['mixed-academic', TYPES[4]],
    ];
    await db!.federalGrant.createMany({
      data: rows.map(([name, label]) => {
        const id = `${prefix}${name}`;
        ids.push(id);
        return {
          id, title: `${prefix}${name}`, agency: 'SQL applicant QA', status: 'posted',
          fundingInstrument: 'Grant', eligibility: [`  ${label.toUpperCase()}  `],
          closeDate: new Date(Date.now() + 86_400_000),
        };
      }),
    });
    const extras: Array<[string, string | null]> = [
      ['incompatible', TYPES[1]], ['other', GRANTS_GOV_OTHER_APPLICANTS],
      ['unknown', 'Cooperatives subject to grant rules'], ['unrestricted', TYPES[15]], ['missing', null],
    ];
    await db!.federalGrant.createMany({
      data: extras.map(([name, label]) => {
        const id = `${prefix}${name}`;
        ids.push(id);
        return {
          id, title: `${prefix}${name}`, agency: 'SQL applicant QA', status: 'posted',
          fundingInstrument: 'Grant', eligibility: label ? [label] : [],
          closeDate: new Date(Date.now() + 86_400_000),
        };
      }),
    });
    await db!.federalGrant.createMany({
      data: Array.from({ length: 101 }, (_, i) => {
        const id = `${prefix}limit-${String(i).padStart(3, '0')}`;
        ids.push(id);
        return {
          id, title: `${prefix}limit-${String(i).padStart(3, '0')}`, agency: 'SQL applicant QA',
          status: 'posted', fundingInstrument: 'Grant', eligibility: [TYPES[1]],
          closeDate: new Date(Date.now() + 86_400_000),
        };
      }),
    });
    const lateId = `${prefix}limit-qualifying`;
    ids.push(lateId);
    await db!.federalGrant.create({
      data: {
        id: lateId, title: `${prefix}limit-zzqualifying`, agency: 'SQL applicant QA',
        status: 'posted', fundingInstrument: 'Grant', eligibility: [TYPES[12]],
        closeDate: new Date(Date.now() + 86_400_000),
      },
    });
  });

  afterAll(async () => {
    try {
      await db!.federalGrant.deleteMany({ where: { id: { in: ids } } });
    } finally {
      await db!.$disconnect();
    }
  });

  test('matches all six UI aliases against canonical vendor labels before LIMIT', async () => {
    for (const alias of ['forprofit', 'smallbiz', 'nonprofit', 'localgov', 'tribal', 'academic']) {
      const result = await searchSourceSql(adapter, 'grants_gov', criteria({
        query: `${prefix}${alias}`, applicantTypes: [`  ${alias.toUpperCase()}  `],
      }), null);
      expect(result.records.some((row) => row.sourceRecordId === `${prefix}${alias}`)).toBe(true);
    }
    const mixed = await searchSourceSql(adapter, 'grants_gov', criteria({
      query: `${prefix}mixed`, applicantTypes: ['NONPROFIT', '  academic '],
    }), null);
    expect(mixed.records.map((row) => row.sourceRecordId)).toEqual(expect.arrayContaining([
      `${prefix}mixed-nonprofit`, `${prefix}mixed-academic`,
    ]));
    const tribal = await searchSourceSql(adapter, 'grants_gov', criteria({
      query: prefix, applicantTypes: ['tribal'],
    }), null);
    expect(tribal.records.map((row) => row.sourceRecordId)).toEqual(expect.arrayContaining([
      `${prefix}tribal`, `${prefix}tribal-org`,
    ]));
    const beyondLimit = await searchSourceSql(adapter, 'grants_gov', criteria({
      query: `${prefix}limit`, applicantTypes: ['forprofit'], pageSize: 1, sort: 'title',
    }), null);
    expect(beyondLimit.count).toBe(1);
    expect(beyondLimit.records[0]?.sourceRecordId).toBe(`${prefix}limit-qualifying`);
  });

  test('keeps canonical eligibility fine-grained and conservative', async () => {
    const known = (query: string, patch: Record<string, unknown> = {}) => searchSourceSql(
      adapter, 'grants_gov', criteria({
        mode: 'matched', clientId: profile.clientId, query: `${prefix}${query}`, ...patch,
      }), profile,
    );
    expect((await known('smallbiz')).records[0]?.eligibility?.state).toBe('eligible');
    expect((await known('incompatible')).records[0]?.eligibility?.state).toBe('ineligible');
    expect((await known('other')).records[0]?.eligibility?.state).toBe('needs_review');
    expect((await known('unknown')).records[0]?.eligibility?.state).toBe('needs_review');
    expect((await known('unrestricted')).records[0]?.eligibility?.state).toBe('eligible');
    expect((await known('missing')).records[0]?.eligibility?.state).toBe('needs_review');
    const missingClientFacts = await searchSourceSql(
      adapter, 'grants_gov', criteria({ mode: 'matched', clientId: profile.clientId, query: `${prefix}smallbiz` }),
      { ...profile, applicantTypes: [] },
    );
    expect(missingClientFacts.records[0]?.eligibility?.state).toBe('needs_review');
    const unknownProfile = await searchSourceSql(
      adapter, 'grants_gov', criteria({ mode: 'matched', clientId: profile.clientId, query: `${prefix}smallbiz` }),
      { ...profile, applicantTypes: ['Legacy organization label'] },
    );
    expect(unknownProfile.records[0]?.eligibility?.state).toBe('needs_review');
    const expectedByState = {
      eligible: [`${prefix}smallbiz`, `${prefix}unrestricted`],
      ineligible: [`${prefix}incompatible`],
      needs_review: [`${prefix}other`, `${prefix}unknown`, `${prefix}missing`],
    } as const;
    for (const state of ['eligible', 'ineligible', 'needs_review'] as const) {
      const filtered = await searchSourceSql(adapter, 'grants_gov', criteria({
        mode: 'matched', clientId: profile.clientId, eligibility: [state], query: prefix,
      }), profile);
      expect(filtered.records.length).toBeGreaterThan(0);
      expect(filtered.records.every((row) => row.eligibility?.state === state)).toBe(true);
      expect(filtered.records.map((row) => row.sourceRecordId)).toEqual(expect.arrayContaining(expectedByState[state]));
    }
    const exact = async (sourceId: string, clientType: string) => {
      const result = await searchSourceSql(adapter, 'grants_gov', criteria({
        mode: 'matched', clientId: profile.clientId, query: `${prefix}${sourceId}`,
      }), { ...profile, applicantTypes: [clientType] });
      return result.records[0]?.eligibility?.state;
    };
    expect(await exact('nonprofit', TYPES[1])).toBe('eligible');
    expect(await exact('nonprofit-unc', TYPES[1])).toBe('ineligible');
    expect(await exact('academic', TYPES[4])).toBe('eligible');
    expect(await exact('academic-private', TYPES[4])).toBe('ineligible');
    expect(await exact('tribal', TYPES[2])).toBe('eligible');
    expect(await exact('tribal-org', TYPES[2])).toBe('ineligible');
  });
});

describeDb('funding opportunity SQL source contract (isolated Postgres)', () => {
  const sourcePrefix = `sql-contract-${Date.now()}-${randomUUID()}-`;
  const sourceIds = {
    grant: `${sourcePrefix}grant`, sam: randomUUID(), forecast: `${sourcePrefix}forecast`,
    dibbs: `${sourcePrefix}dibbs`, topic: `${sourcePrefix}sbir-topic`, cycle: `${sourcePrefix}sbir-cycle`, ca: `${sourcePrefix}ca`,
  };
  const grantIds = [sourceIds.grant, ...Array.from({ length: 204 }, (_, index) => `${sourcePrefix}grant-${index + 1}`)];
  const agencyPrefix = `sql-agency-${Date.now()}-${randomUUID()}-`;
  const agencyIds: string[] = [];
  const samEdgeIds: string[] = [randomUUID(), randomUUID()];
  const future = new Date(Date.now() + 30 * 86_400_000);
  const posted = new Date(Date.now() - 2 * 86_400_000);

  beforeAll(async () => {
    await db!.$connect();
    await db!.federalGrant.createMany({ data: grantIds.map((id, index) => ({
      id, title: `${sourcePrefix} grant ${String(index).padStart(3, '0')}`, agency: 'Department of Energy', fundingInstrument: 'Grant',
      eligibility: [TYPES[13]], cfdaNumbers: ['99.999'], status: 'posted', openDate: posted, closeDate: future,
      costSharing: true, estimatedFunding: 500000, description: 'hydrogen propulsion research', raw: { synopsis: { fundingActivityCategories: [{ description: 'Energy' }] } },
    })) });
    const literalId = `${randomUUID()}-%_` + String.fromCharCode(92) + 'literal';
    grantIds.push(literalId);
    await db!.federalGrant.create({ data: { id: literalId, title: 'literal %_' + String.fromCharCode(92) + ' marker', agency: 'Department of Energy', fundingInstrument: 'Grant', eligibility: [TYPES[13]], status: 'posted', closeDate: future } });
    const agencyRows: Array<[string, string | null]> = [
      ['army-full', 'Department of the Army'], ['army-acronym', 'Army'],
      ['disa-full', 'Defense Information Systems Agency'], ['disa-acronym', 'DISA'],
      ['doe-full', 'Department of Energy'], ['doe-acronym', 'DOE'],
      ['nasa-full', 'National Aeronautics and Space Administration'], ['nasa-acronym', 'NASA'],
      ['casgc-full', 'California Strategic Growth Council'], ['casgc-acronym', 'CASGC'],
      ['dla-full', 'Defense Logistics Agency'], ['dla-acronym', 'DLA'],
      ['doering', 'Doering Research'], ['null-agency', ''],
    ];
    await db!.federalGrant.createMany({ data: agencyRows.map(([key, agency]) => {
      const id = `${agencyPrefix}${key}`;
      agencyIds.push(id);
      return { id, title: `${agencyPrefix}${key}`, agency: agency ?? '', fundingInstrument: 'Grant', status: 'posted', closeDate: future };
    }) });
    await db!.samOpportunity.create({ data: {
      id: sourceIds.sam, noticeId: `${sourcePrefix}sam-notice`, title: `${sourcePrefix} SAM`, agency: 'Department of Defense', noticeType: 'Solicitation',
      baseType: 'Solicitation', setAside: 'Total Small Business Set-Aside (FAR 19.5)', setAsideCode: 'SBA', naicsCode: '541715', pscCode: 'AR15',
      postedDate: posted, responseDeadline: future, description: 'hydrogen propulsion solicitation', placeOfPerformance: { state: { code: 'MI', name: 'Michigan' } },
      raw: { lastModifiedDate: '2026-09-16T14:00:00Z' },
    } });
    await db!.samOpportunity.createMany({ data: samEdgeIds.map((id, index) => ({
      id, noticeId: `${sourcePrefix}sam-edge-${index}`, title: `${sourcePrefix} SAM edge ${index}`, noticeType: 'Solicitation', active: true,
      responseDeadline: future, raw: { lastModifiedDate: index === 0 ? '2026-99-99T99:99:99Z' : '2026-09-16T14:00:00' },
    })) });
    await db!.tangoProcurementForecast.create({ data: {
      tangoForecastId: sourceIds.forecast, title: `${sourcePrefix} forecast`, description: 'hydrogen forecast', agency: 'NASA', naicsCode: '541715', pscCode: 'AR15',
      setAside: 'Unrestricted', placeOfPerformance: 'Nationwide', anticipatedAwardDate: future, snapshot: { provenance: 'durable SQL fixture' },
    } });
    await db!.tangoDibbsSolicitation.create({ data: {
      tangoDibbsId: sourceIds.dibbs, documentType: 'rfq', solicitation: `${sourcePrefix} DIBBS`, nomenclature: 'hydrogen part', nsn: '1234-00-000-0001',
      partNumber: 'PART-1', setAside: 'HUBZone', statusCode: 'OPEN', issuedDate: posted, closesDate: future, isOpen: true, documentUrl: 'https://example.invalid/dibbs',
    } });
    await db!.tangoSbirSolicitation.create({ data: {
      tangoSbirId: sourceIds.cycle, solicitationNumber: `${sourcePrefix} cycle`, title: `${sourcePrefix} solicitation`, program: 'STTR', cycleName: 'FY26',
      year: 2026, startDate: posted, endDate: future, solicitationStatus: 'Open', solDownloadUrl: 'https://example.invalid/sbir-cycle',
    } });
    await db!.tangoSbirTopic.create({ data: {
      tangoSbirId: sourceIds.topic, topicNumber: `${sourcePrefix} topic`, title: `${sourcePrefix} topic`, agency: 'NASA', year: 2026,
      solicitationNumber: `${sourcePrefix} cycle`, releaseDate: posted, openDate: posted, closeDate: future, activity: 'hydrogen', solicitationStatus: 'Open',
      topicUrl: 'https://example.invalid/sbir-topic', officialSolicitationUrl: 'https://example.invalid/sbir-cycle',
    } });
    await db!.californiaGrantOpportunity.create({ data: {
      portalId: sourceIds.ca, title: `${sourcePrefix} California`, status: 'active', type: 'Grant', agencyDept: 'California Energy Commission', categories: ['Energy'], applicantTypes: ['Business'],
      matchingFundsRaw: '20%', matchingFundsPercent: 20, fundingMethod: 'Reimbursements', loi: 'Yes', estimatedAvailableFundsAmount: 500000,
      openDateCalendarDate: posted, applicationDeadlineCalendarDate: future, electronicSubmissionUrls: ['https://example.invalid/apply'], electronicSubmissionEmails: ['apply@example.invalid'],
      description: 'hydrogen propulsion California grant',
    } });
  });

  afterAll(async () => {
    try {
      await db!.federalGrant.deleteMany({ where: { id: { in: [...grantIds, ...agencyIds] } } });
      await db!.samOpportunity.deleteMany({ where: { id: { in: [sourceIds.sam, ...samEdgeIds] } } });
      await db!.tangoProcurementForecast.deleteMany({ where: { tangoForecastId: sourceIds.forecast } });
      await db!.tangoDibbsSolicitation.deleteMany({ where: { tangoDibbsId: sourceIds.dibbs } });
      await db!.tangoSbirTopic.deleteMany({ where: { tangoSbirId: sourceIds.topic } });
      await db!.tangoSbirSolicitation.deleteMany({ where: { tangoSbirId: sourceIds.cycle } });
      await db!.californiaGrantOpportunity.deleteMany({ where: { portalId: sourceIds.ca } });
    } finally { await db!.$disconnect(); }
  });

  test('maps each UI agency alias to full-name and acronym source values, while any is unrestricted', async () => {
    const aliases = ['army', 'disa', 'doe', 'nasa', 'casgc', 'dla'];
    for (const alias of aliases) {
      const result = await searchSourceSql(adapter, 'grants_gov', criteria({ query: agencyPrefix, agencies: [alias] }), null);
      expect(result.records.map((row) => row.sourceRecordId)).toEqual(expect.arrayContaining([
        `${agencyPrefix}${alias}-full`, `${agencyPrefix}${alias}-acronym`,
      ]));
      expect(result.count).toBe(2);
    }
    const any = await searchSourceSql(adapter, 'grants_gov', criteria({ query: agencyPrefix, agencies: ['any'] }), null);
    expect(any.count).toBe(14);
    expect(any.records).toHaveLength(14);
    expect(any.records.map((row) => row.sourceRecordId)).toContain(`${agencyPrefix}null-agency`);
    const anyAlongsideSpecific = await searchSourceSql(adapter, 'grants_gov', criteria({ query: agencyPrefix, agencies: ['any', 'doe'] }), null);
    expect(anyAlongsideSpecific.count).toBe(14);
    expect(anyAlongsideSpecific.records.map((row) => row.sourceRecordId)).toContain(`${agencyPrefix}doering`);
    const direct = await searchSourceSql(adapter, 'grants_gov', criteria({ query: agencyPrefix, agencies: ['Department of Energy'] }), null);
    expect(direct.records.map((row) => row.sourceRecordId)).toEqual(expect.arrayContaining([
      `${agencyPrefix}doe-full`, `${agencyPrefix}doe-acronym`,
    ]));
    expect(direct.count).toBe(2);
    expect(direct.records.map((row) => row.sourceRecordId)).not.toContain(`${agencyPrefix}doering`);
    const freeText = await searchSourceSql(adapter, 'grants_gov', criteria({ query: agencyPrefix, agencies: ['Doering Research'] }), null);
    expect(freeText.records.map((row) => row.sourceRecordId)).toEqual([`${agencyPrefix}doering`]);
    const orWithin = await searchSourceSql(adapter, 'grants_gov', criteria({ query: agencyPrefix, agencies: ['doe', 'nasa'] }), null);
    expect(orWithin.count).toBe(4);
  });

  test('uses the same agency family for full-name and acronym profile evidence, without Any evidence', async () => {
    const profiles: Array<[string, string]> = [
      ['army', 'Department of the Army'], ['army', 'ARMY'], ['disa', 'Defense Information Systems Agency'], ['disa', 'DISA'],
      ['doe', 'Department of Energy'], ['doe', 'DOE'], ['nasa', 'National Aeronautics and Space Administration'], ['nasa', 'NASA'],
      ['casgc', 'California Strategic Growth Council'], ['casgc', 'CASGC'], ['dla', 'Defense Logistics Agency'], ['dla', 'DLA'],
    ];
    for (const [alias, agency] of profiles) {
      const result = await searchSourceSql(adapter, 'grants_gov', criteria({ mode: 'matched', clientId: profile.clientId, query: agencyPrefix }), {
        ...profile, agencies: [agency],
      });
      const matching = result.records.filter((row) => row.relevanceScore === 45);
      expect(matching.map((row) => row.sourceRecordId)).toEqual(expect.arrayContaining([
        `${agencyPrefix}${alias}-full`, `${agencyPrefix}${alias}-acronym`,
      ]));
      expect(matching).toHaveLength(2);
      const matchedIds = new Set([`${agencyPrefix}${alias}-full`, `${agencyPrefix}${alias}-acronym`]);
      const unrelated = result.records.filter((row) => !matchedIds.has(row.sourceRecordId));
      expect(unrelated).toHaveLength(12);
      expect(unrelated.every((row) => row.relevanceScore === null && row.matchedSignals.length === 0)).toBe(true);
    }
    const any = await searchSourceSql(adapter, 'grants_gov', criteria({ mode: 'matched', clientId: profile.clientId, query: agencyPrefix }), {
      ...profile, agencies: ['any'],
    });
    expect(any.count).toBe(14);
    expect(any.records).toHaveLength(14);
    expect(any.records.every((row) => row.relevanceScore === null && row.matchedSignals.length === 0)).toBe(true);
  });

  test('projects all six source rails and retains both SBIR branches', async () => {
    const rails: Array<[OpportunitySourceV2, string]> = [
      ['grants_gov', sourceIds.grant], ['sam_gov', sourceIds.sam], ['agency_forecast', sourceIds.forecast], ['dibbs', sourceIds.dibbs],
      ['sbir_sttr', sourceIds.topic], ['sbir_sttr', sourceIds.cycle], ['ca_portal', sourceIds.ca],
    ];
    for (const [source, id] of rails) {
      const result = await searchSourceSql(adapter, source, criteria({ query: sourcePrefix, sort: 'title' }), null);
      expect(result.records.map((row) => row.sourceRecordId)).toContain(id);
    }
    const samRows = await searchSourceSql(adapter, 'sam_gov', criteria({ query: sourcePrefix }), null);
    expect(samRows.records.filter((row) => samEdgeIds.includes(row.sourceRecordId)).every((row) => row.updatedAt === null)).toBe(true);
    const exact = await readExactSourceSql(adapter, 'sbir_sttr', criteria({ query: '' }), null, [sourceIds.topic, sourceIds.cycle]);
    expect(exact.records.map((row) => row.sourceRecordId)).toEqual(expect.arrayContaining([sourceIds.topic, sourceIds.cycle]));
    expect(exact.records.find((row) => row.sourceRecordId === sourceIds.topic)?.sourceFacts).toMatchObject({ provenance: 'tango_sbir_topic' });
    expect(exact.records.find((row) => row.sourceRecordId === sourceIds.cycle)?.sourceFacts).toMatchObject({ provenance: 'tango_sbir_solicitation' });
  });

  test('covers representative sixteen filter groups with OR within and AND across', async () => {
    const cases: Array<[OpportunitySourceV2, Record<string, unknown>, string]> = [
      ['grants_gov', { types: ['grant'] }, sourceIds.grant], ['grants_gov', { lifecycle: ['active'] }, sourceIds.grant],
      ['grants_gov', { agencies: ['energy'] }, sourceIds.grant], ['grants_gov', { sectors: ['energy'] }, sourceIds.grant],
      ['sam_gov', { naicsCodes: ['541715'] }, sourceIds.sam], ['sam_gov', { pscCodes: ['AR15'] }, sourceIds.sam],
      ['sam_gov', { setAsideCodes: ['tsb'] }, sourceIds.sam], ['sam_gov', { geography: ['michigan'] }, sourceIds.sam],
      ['grants_gov', { applicantTypes: ['smallbiz'] }, sourceIds.grant], ['grants_gov', { funding: ['u1'] }, sourceIds.grant],
      ['grants_gov', { costShare: ['required'] }, sourceIds.grant], ['ca_portal', { methods: ['agency', 'email'] }, sourceIds.ca],
      ['ca_portal', { disbursement: ['reimbursements'] }, sourceIds.ca], ['ca_portal', { grantPrerequisites: ['loi', 'match'] }, sourceIds.ca],
      ['grants_gov', { codes: ['99.999'] }, sourceIds.grant], ['grants_gov', { posted: ['last_7_days'], deadlineWindow: '45d' }, sourceIds.grant],
    ];
    for (const [source, patch, expectedId] of cases) {
      const result = await searchSourceSql(adapter, source, criteria({ query: sourcePrefix, ...patch }), null);
      expect(result.records.map((row) => row.sourceRecordId)).toContain(expectedId);
    }
    const andAcross = await searchSourceSql(adapter, 'ca_portal', criteria({ query: sourcePrefix, funding: ['u1'], methods: ['agency'], grantPrerequisites: ['loi', 'match'], deadlineWindow: '45d' }), null);
    expect(andAcross.records.map((row) => row.sourceRecordId)).toEqual([sourceIds.ca]);
  });

  test('supports explicit keyword AND matching, quoted spans, phrase mode, and legacy literal matching', async () => {
    const nonAdjacent = await searchSourceSql(adapter, 'grants_gov', criteria({ query: 'hydrogen research', queryMatch: 'keywords' }), null);
    expect(nonAdjacent.count).toBe(205);
    expect(nonAdjacent.records.length).toBeGreaterThan(0);
    const anyKeyword = await searchSourceSql(adapter, 'grants_gov', criteria({ keywordTerms: ['not-present-xyz', sourcePrefix] }), null);
    expect(anyKeyword.count).toBe(205);
    const combined = await searchSourceSql(adapter, 'grants_gov', criteria({ query: 'not-present-xyz', queryMatch: 'keywords', keywordTerms: [sourcePrefix] }), null);
    expect(combined.count).toBe(205);
    const phraseNarrowed = await searchSourceSql(adapter, 'grants_gov', criteria({ query: 'not-present-xyz', queryMatch: 'phrase', keywordTerms: [sourcePrefix] }), null);
    expect(phraseNarrowed.count).toBe(0);
    const phrase = await searchSourceSql(adapter, 'grants_gov', criteria({ query: 'hydrogen research', queryMatch: 'phrase' }), null);
    expect(phrase.count).toBe(0);
    const quoted = await searchSourceSql(adapter, 'grants_gov', criteria({ query: '"hydrogen propulsion" research', queryMatch: 'keywords' }), null);
    expect(quoted.count).toBe(205);
    const legacy = await searchSourceSql(adapter, 'grants_gov', criteria({ query: 'hydrogen research' }), null);
    expect(legacy.count).toBe(0);
    const literal = await searchSourceSql(adapter, 'grants_gov', criteria({ query: '%_' + String.fromCharCode(92), queryMatch: 'phrase', pageSize: 1 }), null);
    expect(literal.count).toBe(1);
    expect(literal.records).toHaveLength(1);
  });

  test('counts are computed before limits and forecast dates are not response deadlines', async () => {
    const page = await searchSourceSql(adapter, 'grants_gov', criteria({ query: sourcePrefix, pageSize: 1, sort: 'title', direction: 'asc' }), null);
    expect(page.count).toBe(205);
    expect(page.records).toHaveLength(1);
    const pageTwo = await searchSourceSql(adapter, 'grants_gov', criteria({ query: sourcePrefix, page: 2, pageSize: 1, sort: 'title', direction: 'asc' }), null);
    expect(pageTwo.count).toBe(205);
    // Per-source SQL returns the bounded candidate window; the global page
    // offset is applied by FundingOpportunityV2SearchService after merging
    // source results. Count-before-limit is the SQL contract here.
    expect(pageTwo.records.length).toBeGreaterThan(0);
    const forecast = await searchSourceSql(adapter, 'agency_forecast', criteria({ query: sourcePrefix }), null);
    expect(forecast.records[0]).toMatchObject({ deadline: null, closeOrArchiveDate: null });
    expect(forecast.records[0]?.sourceFacts).toMatchObject({ anticipatedAwardDate: expect.anything() });
  });
});

describe('funding opportunity multi-keyword SQL shape', () => {
  test('passes separate keyword patterns as one OR set and keeps exact phrase as a separate condition', async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const fake = {
      withSystem: async <T>(fn: (tx: { $queryRaw: <R>(query: { sql: string; values: unknown[] }) => Promise<R> }) => Promise<T>) => fn({
        $queryRaw: async <R>(query: { sql: string; values: unknown[] }) => {
          queries.push(query);
          return [] as R;
        },
      }),
    };
    await searchSourceSql(fake, 'grants_gov', criteria({ query: 'exact phrase', queryMatch: 'phrase', keywordTerms: ['Robot%', 'battery_storage'] }), null);
    const query = queries[0]!;
    expect(query.sql).toContain('EXISTS (SELECT 1 FROM unnest(');
    expect(query.sql).toContain('AS wanted(pattern)');
    expect(query.values).toEqual(expect.arrayContaining(['%exact phrase%', '%robot\\%%', '%battery\\_storage%']));
    expect(query.sql).toMatch(/LIKE.*ESCAPE chr\(92\).*AND.*EXISTS/s);
  });
});

describe('funding opportunity source health SQL shape and semantics', () => {
  test('aggregates lifecycle counts in one catalog scan for every source', async () => {
    const queries: unknown[] = [];
    const adapter = {
      withSystem: async <T>(fn: (tx: { $queryRaw: <R>(query: unknown) => Promise<R> }) => Promise<T>) => fn({
        $queryRaw: async <R>(query: unknown) => {
          queries.push(query);
          return [{
            record_count: 12n,
            active_count: 5n,
            status: 'success',
            error_count: 0,
            latest_attempt_at: new Date(),
            last_success_at: new Date(),
          }] as R;
        },
      }),
    };

    for (const source of ['grants_gov', 'sam_gov', 'agency_forecast', 'dibbs', 'sbir_sttr', 'ca_portal'] as OpportunitySourceV2[]) {
      await expect(healthSql(adapter, source)).resolves.toMatchObject({
        state: 'current', recordCount: 12, activeRecordCount: 5,
        lastSyncedAt: expect.any(String), latestAttemptAt: expect.any(String), lastSuccessAt: expect.any(String),
      });
    }

    expect(queries).toHaveLength(6);
    for (const query of queries) {
      const sql = ((query as { strings?: string[] }).strings ?? []).join('?');
      expect(sql).toContain('counts AS');
      expect(sql).toContain("count(*) FILTER (WHERE lifecycle = 'active') active_count FROM catalog");
      expect(sql).not.toContain('(SELECT count(*) FROM catalog)');
      expect(sql).not.toContain("(SELECT count(*) FROM catalog WHERE lifecycle = 'active')");
    }
  });

  test('preserves cached-error and initial-partial state semantics and timestamps', async () => {
    const rows = [
      { record_count: 8n, active_count: 2n, status: 'error', error_count: 1, latest_attempt_at: new Date('2026-09-17T12:00:00.000Z'), last_success_at: new Date('2026-07-29T12:53:27.551Z') },
      { record_count: 8n, active_count: 2n, status: 'running', error_count: 0, latest_attempt_at: new Date('2026-09-17T12:00:00.000Z'), last_success_at: null },
    ];
    const adapter = {
      withSystem: async <T>(fn: (tx: { $queryRaw: <R>(query: unknown) => Promise<R> }) => Promise<T>) => fn({
        $queryRaw: async <R>(_query: unknown) => [rows.shift()!] as R,
      }),
    };

    await expect(healthSql(adapter, 'sam_gov')).resolves.toMatchObject({
      state: 'error_cached', recordCount: 8, activeRecordCount: 2,
      lastSyncedAt: '2026-07-29T12:53:27.551Z', latestAttemptAt: '2026-09-17T12:00:00.000Z',
      lastSuccessAt: '2026-07-29T12:53:27.551Z',
    });
    await expect(healthSql(adapter, 'dibbs')).resolves.toMatchObject({
      state: 'initial_partial', recordCount: 8, activeRecordCount: 2,
      lastSyncedAt: null, latestAttemptAt: '2026-09-17T12:00:00.000Z', lastSuccessAt: null,
    });
  });
});
