/**
 * Visual fixture for Client CRM / 01 Overview (`906:2503`).
 *
 * This exists ONLY for the Clerk-free capture harness, so the rendered screen
 * can be diffed against the Figma frame at 1600×1000. It is deliberately NOT
 * importable from product code and is never used as a fallback when a query
 * fails — the contract's Definition of Done forbids placeholder Figma records
 * acting as production data, and the product path returns explicit
 * `unavailable` metrics instead.
 *
 * Values mirror the Figma frame so a diff shows layout drift, not content drift.
 */
import type { ClientCrmOverviewModel } from '../../adapters/legacy/useClientCrmOverviewModel.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

const ready = { state: 'ready' as const, retry: () => undefined };

export const CLIENT_CRM_VISUAL_CLIENT: Client = {
  id: 'visual-fixture',
  name: 'Overland AI',
  website: 'overland.ai',
  description:
    'Autonomy software and unmanned-ground systems for defense and national-security missions.',
  productDescription: null,
  primaryContactName: 'Stephanie Bonk',
  primaryContactEmail: null,
  primaryContactPhone: null,
  logoS3Key: null,
  logoContentType: null,
  logoUploadedAt: null,
  intakeData: {
    portfolio: ['FY27 Ground Robotics'],
    tags: ['Army Procurement', 'Autonomy'],
    city: 'Seattle',
    state: 'Washington',
    engagementStartDate: '2026-01-05T00:00:00.000Z',
  },
  status: 'active',
  sectorTag: null,
  createdAt: '2026-01-05T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

export const CLIENT_CRM_VISUAL_FIXTURE: ClientCrmOverviewModel = {
  profile: {
    name: 'Overland AI',
    initials: 'OA',
    logoUrl: null,
    description:
      'Autonomy software and unmanned-ground systems for defense and national-security missions.',
    sectorLabel: 'Defense technology',
    website: 'overland.ai',
    location: 'Seattle, Washington',
    clientSince: 'JAN 2026',
  },
  account: {
    accountOwner: null,
    primaryContact: 'Stephanie Bonk',
    nextMeeting: { id: 'm1', label: 'Aug 14 · 10:00 AM', startsAt: '2026-08-14T10:00:00.000Z' },
    briefState: 'ready',
    accountTeam: [],
    accountTeamAvailable: false,
  },
  accountStatus: ready,
  attention: [
    {
      id: 'a0',
      kind: 'budget',
      urgent: true,
      title: 'FY27 Ground Robotics reduced by $22.7M',
      meta: 'Appropriations change · linked to active strategy',
      when: 'TODAY',
      status: 'OPEN',
      href: null,
      rank: 130,
    },
    {
      id: 'a1',
      kind: 'hearing',
      urgent: false,
      title: 'HASC autonomous-systems hearing scheduled',
      meta: 'Relevant to autonomy and ground robotics',
      when: 'AUG 13',
      status: 'OPEN',
      href: null,
      rank: 120,
    },
    {
      id: 'a2',
      kind: 'work',
      urgent: false,
      title: 'Committee outreach milestone is due',
      meta: 'FY27 Ground Robotics strategy · owner Sarah Martinez',
      when: 'AUG 14',
      status: 'OPEN',
      href: null,
      rank: 110,
    },
    {
      id: 'a3',
      kind: 'regulatory',
      urgent: false,
      title: 'EPA comment period closes in 11 days',
      meta: 'Federal Register matter linked to client watchlist',
      when: 'AUG 21',
      status: 'OPEN',
      href: null,
      rank: 100,
    },
  ],
  attentionTotal: 8,
  attentionStatus: ready,
  work: {
    currentStrategies: { kind: 'value', value: 3 },
    remainingActions: { kind: 'value', value: 7 },
    upcomingMilestones: { kind: 'value', value: 2 },
    openRisk: { kind: 'value', value: 1 },
    readiness: 0.68,
    readinessReason: null,
    nextStep: 'Next: HASC member outreach · Aug 14',
  },
  workStatus: ready,
  intelligence: {
    trackedBills: { kind: 'value', value: 12 },
    opportunities: { kind: 'value', value: 7 },
    districts: { kind: 'value', value: 8 },
    regulatoryMatters: { kind: 'value', value: 3 },
    signals: ['3 HIGH-PRIORITY CHANGES', 'NEXT HEARING AUG 13', '8 DISTRICTS MAPPED'],
    lastRefresh: '2 hours ago',
  },
  intelligenceStatus: ready,
};
