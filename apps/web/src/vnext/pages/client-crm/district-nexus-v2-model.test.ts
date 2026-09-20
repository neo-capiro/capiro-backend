import { describe, expect, it } from 'vitest';
import type { ClientDistrictNexusV2 } from '../../../pages/clients/intelligence-v1/district-nexus-api.js';
import {
  clientDistrictContractSummary,
  contractAmountByDistrict,
} from './district-nexus-v2-model.js';

function nexus(): ClientDistrictNexusV2 {
  return {
    clientId: 'client-1',
    districts: [
      {
        districtKey: 'FL-08',
        state: 'FL',
        districtCode: '08',
        name: 'FL-08',
        status: 'C',
        score: 55,
        coveragePercent: 80,
        clientCount: 1,
        employeeCount: null,
        employeesUnreported: true,
        awarded: { contractObligations: 125, grantObligations: null, grantOutlays: null },
        opportunities: { opportunityEstimatedFunding: null, opportunityAwardCeiling: null },
        breakdown: [],
        freshness: [],
        evidence: [],
        warnings: [],
      },
      {
        districtKey: 'CA-47',
        state: 'CA',
        districtCode: '47',
        name: 'CA-47',
        status: 'C',
        score: 20,
        coveragePercent: 40,
        clientCount: 1,
        employeeCount: null,
        employeesUnreported: true,
        awarded: { contractObligations: null, grantObligations: 50, grantOutlays: null },
        opportunities: { opportunityEstimatedFunding: null, opportunityAwardCeiling: null },
        breakdown: [],
        freshness: [],
        evidence: [],
        warnings: [],
      },
    ],
    representativesByFacility: [],
    linkage: {
      contractingLinked: true,
      contractorNames: ['Acme'],
      assistanceLinked: false,
      recipientNames: [],
      ueiConfirmedCount: 1,
    },
    facilityFootprint: {
      facilityCount: 2,
      facilitiesWithoutDistrict: 0,
      employeeCount: null,
      facilitiesMissingEmployeeCount: 2,
    },
    awarded: { contractObligations: 125, grantObligations: 50, grantOutlays: null },
    opportunities: { opportunityEstimatedFunding: null, opportunityAwardCeiling: null },
    opportunitySummary: {
      activeOpportunityCount: 0,
      closedOpportunityCount: 0,
      totalEstimatedFunding: null,
      maximumAwardCeiling: null,
      topOpportunities: [],
    },
    unmapped: {
      unmappedContractAmount: null,
      unmappedGrantAmount: null,
    },
    score: 55,
    bestDistrictKey: 'FL-08',
    coveragePercent: 80,
    breakdown: [],
    strongestDrivers: [],
    freshness: [],
    warnings: [],
    generatedAt: '2026-09-20T00:00:00.000Z',
  };
}

describe('District Nexus v2 client-CRM model', () => {
  it('derives federal contract summary without the legacy spend endpoint', () => {
    const data = nexus();
    data.unmapped.unmappedContractAmount = 75;
    expect(clientDistrictContractSummary(data)).toEqual({
      totalAmount: 200,
      districtCount: 1,
      contractorNames: ['Acme'],
      linked: true,
    });
  });

  it('keeps unknown district contract money absent rather than zero', () => {
    expect([...contractAmountByDistrict(nexus().districts)]).toEqual([['FL-08', 125]]);
  });
});
