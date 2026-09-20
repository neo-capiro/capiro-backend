import { describe, expect, jest, test } from '@jest/globals';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ClientPeRelevanceService } from '../intelligence/client-pe-relevance.service.js';
import { DistrictNexusStrategicService } from './district-nexus-strategic.service.js';
import type { DistrictNexusService } from './district-nexus.service.js';
import type { StrategicComponentInput } from './district-nexus-strategic-scoring.js';
import {
  assembleStrategicPostQuery,
  buildDistrictStrategicComponents,
  type StrategicMemberRow,
} from './district-nexus-strategic.helpers.js';

const house: StrategicMemberRow = {
  bioguideId: 'H001',
  fullName: 'Rep. House',
  party: 'I',
  state: 'Texas',
  district: 23,
  chamber: 'house',
};
const senator: StrategicMemberRow = {
  bioguideId: 'S001',
  fullName: 'Sen. Statewide',
  party: 'I',
  state: 'Texas',
  district: null,
  chamber: 'senate',
};

describe('strategic scoreDistrict pure builders', () => {
  test('builds member identity and all seven synchronous components without blending scores', () => {
    const built = buildDistrictStrategicComponents(
      {
        relevantPes: [
          {
            peCode: '0600001A',
            title: 'Direct PE',
            score: 0.9,
            paths: [{ path: 'capability_pe_direct', score: 0.9, evidence: ['capability'] }],
          },
        ],
        capabilityTargets: [
          { targetSubcommittee: 'hsas', peNumbers: ['0600001A'], peNumber: null },
        ],
        membershipsByBioguide: new Map([
          [
            'H001',
            [
              {
                bioguideId: 'H001',
                systemCode: 'hsas',
                committeeName: 'House Armed Services',
                parentSystemCode: null,
                title: 'Member',
              },
            ],
          ],
        ]),
        trackedBills: [
          {
            billId: '119-hr-1',
            title: 'Defense bill',
            status: 'introduced',
            sponsorBioguideId: 'S001',
            cosponsorBioguides: [],
            committeeCodes: ['hsas'],
            latestActionDate: '2026-01-02T00:00:00.000Z',
            peCodes: [],
          },
        ],
        strategyTargets: [
          {
            strategyId: 'strategy-1',
            strategyTitle: 'Win authorization',
            nodeId: 'node-1',
            nodeTitle: 'Meet senator',
            subject: 'member',
            memberId: 'S001',
            systemCode: null,
          },
        ],
        engagements: [
          {
            kind: 'client_target',
            memberId: 'H001',
            label: 'Target: Rep. House',
            sourceRecordId: 'target-1',
            observedAt: '2026-01-03T00:00:00.000Z',
          },
        ],
        hearings: [
          {
            hearingId: 'hearing-1',
            title: 'Defense hearing',
            committeeCode: 'hsas',
            startsAt: '2026-01-04T00:00:00.000Z',
            billId: '119-hr-1',
          },
        ],
        allMembers: [house, senator],
        opportunityDistrictKeys: new Set(['TX-23']),
      },
      'TX-23',
      [house],
    );

    expect([...built.identity.bioguides]).toEqual(['H001', 'S001']);
    expect(built.identity.stateCode).toBe('TX');
    expect(Object.keys(built.components)).toEqual([
      'committeeJurisdiction',
      'programElementBudget',
      'activeLegislation',
      'activeStrategyTarget',
      'relationshipEngagement',
      'hearingTiming',
      'opportunityFunding',
    ]);
    expect(built.components.committeeJurisdiction).toMatchObject({
      strength: 'verified',
      evidenceCount: 1,
    });
    expect(built.components.programElementBudget).toMatchObject({
      strength: 'verified',
      evidenceCount: 1,
    });
    expect(built.components.activeLegislation).toMatchObject({
      strength: 'verified',
      evidenceCount: 1,
    });
    expect(built.components.activeStrategyTarget).toMatchObject({
      strength: 'verified',
      evidenceCount: 1,
    });
    expect(built.components.relationshipEngagement).toMatchObject({
      strength: 'verified',
      evidenceCount: 1,
    });
    expect(built.components.hearingTiming).toMatchObject({
      strength: 'sourceAuthoritative',
      evidenceCount: 1,
    });
    expect(built.components.opportunityFunding).toMatchObject({
      strength: 'partial',
      evidenceCount: 1,
    });
    expect(built.components).not.toHaveProperty('memberHistoricalPriorities');
    expect(built.components).not.toHaveProperty('nexusStrength');
  });

  test('service keeps member-priority loading and final scoring around the pure builders', async () => {
    const service = new DistrictNexusStrategicService(
      {} as PrismaService,
      {} as ClientPeRelevanceService,
      {} as DistrictNexusService,
    );
    const memberPriority: StrategicComponentInput = {
      strength: 'sourceAuthoritative',
      evidenceCount: 1,
      evidence: [],
      rationale: 'characterized member-priority evidence',
    };
    const loadMemberPriorityEvidence = jest.fn(async () => memberPriority);
    (
      service as unknown as {
        loadMemberPriorityEvidence: typeof loadMemberPriorityEvidence;
      }
    ).loadMemberPriorityEvidence = loadMemberPriorityEvidence;
    const scoreDistrict = (
      service as unknown as {
        scoreDistrict: (
          bundle: unknown,
          districtKey: string,
          members: StrategicMemberRow[],
        ) => Promise<{
          score: number | null;
          breakdown: Array<{ component: string; credit: number | null }>;
          conflicts: Array<{ code: string }>;
        }>;
      }
    ).scoreDistrict.bind(service);

    const result = await scoreDistrict(
      {
        relevantPes: [],
        capabilityTargets: [],
        membershipsByBioguide: new Map(),
        trackedBills: [],
        strategyTargets: [],
        engagements: [],
        hearings: [],
        allMembers: [house, senator],
        opportunityDistrictKeys: new Set(),
        freshness: [],
        conflicts: [],
        geographyVintageConflicts: new Set(['TX-23']),
      },
      'TX-23',
      [house],
    );

    expect(loadMemberPriorityEvidence).toHaveBeenCalledTimes(1);
    const priorityCalls = loadMemberPriorityEvidence.mock.calls as unknown as Array<
      [ReadonlySet<string>, string, string]
    >;
    expect([...priorityCalls[0]![0]]).toEqual(['H001', 'S001']);
    expect(priorityCalls[0]![1]).toBe('TX');
    expect(
      result.breakdown.find((row) => row.component === 'memberHistoricalPriorities')?.credit,
    ).toBe(5);
    expect(result.conflicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'geography_vintage_conflict' })]),
    );
    expect(result).not.toHaveProperty('nexusScore');
  });
});

describe('loadClientBundle pure post-query assembly', () => {
  test('assembles indexes and mapped facts while preserving nulls, filtering, and insertion order', () => {
    const assembled = assembleStrategicPostQuery({
      bills: [
        {
          id: 'bill-1',
          title: null,
          status: null,
          sponsorBioguideId: null,
          latestActionDate: new Date('2026-02-01T00:00:00.000Z'),
          peCodes: null,
        },
      ],
      cosponsors: [
        { billId: 'bill-1', bioguideId: 'H001' },
        { billId: 'bill-1', bioguideId: 'S001' },
      ],
      billCommittees: [
        { billId: 'bill-1', committeeCode: 'hsas' },
        { billId: 'bill-1', committeeCode: null },
      ],
      memberships: [
        {
          bioguideId: 'H001',
          systemCode: 'hsas',
          title: null,
          committee: { name: 'House Armed Services', parentSystemCode: null, isCurrent: true },
        },
        {
          bioguideId: 'H001',
          systemCode: 'old',
          title: null,
          committee: { name: 'Old Committee', parentSystemCode: null, isCurrent: false },
        },
      ],
      strategyRows: [
        {
          strategyId: 'strategy-1',
          strategyTitle: 'Strategy',
          nodeId: 'node-1',
          nodeTitle: 'Structured target',
          subject: 'member',
          targetRef: { bioguideId: ' H001 ', committeeSystemCode: ' HSAS ' },
        },
        {
          strategyId: 'strategy-1',
          strategyTitle: 'Strategy',
          nodeId: 'node-2',
          nodeTitle: 'Free text only',
          subject: 'member',
          targetRef: { memberName: 'Rep. House' },
        },
      ],
      targets: [
        {
          id: 'target-1',
          memberId: 'H001',
          memberName: null,
          addedAt: new Date('2026-02-02T00:00:00.000Z'),
        },
      ],
      reportTargets: [
        {
          id: 'report-1',
          memberPrincipal: ' S001 ',
          officeKey: 'senate-office',
          updatedAt: new Date('2026-02-03T00:00:00.000Z'),
        },
        {
          id: 'report-empty',
          memberPrincipal: ' ',
          officeKey: 'ignored',
          updatedAt: new Date('2026-02-03T00:00:00.000Z'),
        },
      ],
      sharedMeetings: [
        {
          id: 'meeting-1',
          subject: 'Private subject is not copied',
          startsAt: new Date('2026-02-04T00:00:00.000Z'),
          attendees: [
            { contactId: null, name: null, email: null, metadata: { bioguideId: 'H001' } },
            { contactId: null, name: null, email: null, metadata: {} },
          ],
        },
      ],
      outreach: [
        {
          id: 'outreach-1',
          title: '',
          sentAt: null,
          metadata: { memberId: 'S001' },
          recipients: null,
        },
      ],
      hearingBills: [{ hearingId: 'hearing-1', billId: 'bill-1' }],
      hearings: [
        {
          id: 'hearing-1',
          title: 'Hearing',
          committeeCode: null,
          startsAt: null,
          date: new Date('2026-02-05T00:00:00.000Z'),
        },
      ],
      allCurrentMembers: [house, senator],
    });

    expect(assembled.trackedBills).toEqual([
      {
        billId: 'bill-1',
        title: null,
        status: null,
        sponsorBioguideId: null,
        cosponsorBioguides: ['H001', 'S001'],
        committeeCodes: ['hsas'],
        latestActionDate: '2026-02-01T00:00:00.000Z',
        peCodes: [],
      },
    ]);
    expect(assembled.membershipsByBioguide.get('H001')).toEqual([
      expect.objectContaining({ systemCode: 'hsas', committeeName: 'House Armed Services' }),
    ]);
    expect(assembled.strategyTargets).toEqual([
      expect.objectContaining({ nodeId: 'node-1', memberId: 'H001', systemCode: 'hsas' }),
    ]);
    expect(
      assembled.engagements.map((fact) => [fact.kind, fact.memberId, fact.observedAt]),
    ).toEqual([
      ['client_target', 'H001', '2026-02-02T00:00:00.000Z'],
      ['report_target', 'S001', '2026-02-03T00:00:00.000Z'],
      ['shared_meeting', 'H001', '2026-02-04T00:00:00.000Z'],
      ['outreach', 'S001', null],
    ]);
    expect(assembled.engagements[2]?.label).toBe('Shared meeting with office');
    expect(assembled.hearingLinks).toEqual([
      expect.objectContaining({
        hearingId: 'hearing-1',
        startsAt: '2026-02-05T00:00:00.000Z',
        billId: 'bill-1',
      }),
    ]);
    expect(assembled.membersByDistrict.get('TX-23')).toEqual([house]);
    expect([...assembled.membersByDistrict.keys()]).toEqual(['TX-23']);
  });
});
