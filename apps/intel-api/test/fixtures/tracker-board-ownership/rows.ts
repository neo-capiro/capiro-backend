import type {
  RecommendationBillRow,
  SourceBill,
} from '../../../src/sourcedata/source-data.repository.js';
import type { SourceStateBill } from '../../../src/sourcedata/state-source-data.repository.js';

export const tenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const clientId = '11111111-1111-1111-1111-111111111111';
export const otherClientId = '22222222-2222-2222-2222-222222222222';
export const userId = 'clerk-user';
export const billId = '119-hr-7';
export const stateId = 'ca-2025-ab1234';
export const now = new Date('2026-10-13T16:00:00.000Z');

export function federal(over: Partial<RecommendationBillRow & SourceBill> = {}) {
  return {
    id: billId,
    congress: 119,
    billType: 'hr',
    billNumber: '7',
    title: 'Grid modernization',
    latestActionText: 'Referred to committee',
    latestActionDate: new Date('2026-10-01T12:00:00.000Z'),
    policyArea: 'Energy',
    subjects: ['Energy'],
    sponsorName: 'Sponsor',
    sponsorParty: 'D',
    cosponsorsCount: 2,
    peCodes: [],
    status: 'introduced',
    statusAt: null,
    updateDateIncludingText: null,
    committees: [],
    url: 'https://example.invalid/federal',
    ...over,
  } satisfies RecommendationBillRow & SourceBill;
}

export function state(over: Partial<SourceStateBill> = {}): SourceStateBill {
  return {
    id: stateId,
    state: 'CA',
    sessionKey: '2025',
    session: '2025 Session',
    identifier: 'AB 1234',
    title: 'Grid modernization',
    status: 'committee',
    statusAt: null,
    latestActionText: 'Referred to committee',
    latestActionDate: new Date('2026-10-01T12:00:00.000Z'),
    textDate: null,
    sponsorName: 'State Sponsor',
    sponsorParty: 'R',
    sponsorCount: 1,
    stateUrl: 'https://example.invalid/state',
    url: 'https://example.invalid/provider',
    subjects: ['Energy'],
    committees: [],
    ...over,
  };
}

export function tracked(over: Partial<ReturnType<typeof trackedDefaults>> = {}) {
  return { ...trackedDefaults(), ...over };
}

function trackedDefaults() {
  return {
    id: 'tracked-row',
    tenantId,
    clientId,
    billId,
    stage: 'introduced',
    trackedAt: new Date('2026-10-02T12:00:00.000Z'),
    note: null as string | null,
    isManual: true,
    unread: false,
    trackedBy: userId as string | null,
    lastSeenActionText: null as string | null,
    lastSeenActionDate: null as Date | null,
    lastHearingSessionId: null as string | null,
    lastHearingAt: null as Date | null,
  };
}

export function watchlist(over: Partial<ReturnType<typeof watchlistDefaults>> = {}) {
  return { ...watchlistDefaults(), ...over };
}

function watchlistDefaults() {
  return {
    id: `wl:${clientId}`,
    tenantId,
    clientId,
    issueAreas: ['Energy'],
    jurisdictions: ['US'],
    version: 1,
    updatedBy: null as string | null,
    updatedAt: now,
    _count: { topics: 1 },
  };
}

export function topic(over: Partial<ReturnType<typeof topicDefaults>> = {}) {
  return { ...topicDefaults(), ...over };
}

function topicDefaults() {
  return {
    id: 'topic-grid',
    watchlistId: `wl:${clientId}`,
    tenantId,
    label: 'Grid',
    issueArea: null as string | null,
    position: 'support',
    priority: 'high',
  };
}

export function term(over: Partial<ReturnType<typeof termDefaults>> = {}) {
  return { ...termDefaults(), ...over };
}

function termDefaults() {
  return {
    id: 'term-grid',
    watchlistId: `wl:${clientId}`,
    tenantId,
    topicId: 'topic-grid' as string | null,
    termType: 'keyword',
    value: 'grid',
    weight: 1,
  };
}

export function alert(over: Partial<ReturnType<typeof alertDefaults>> = {}) {
  return { ...alertDefaults(), ...over };
}

function alertDefaults() {
  return {
    sourceRef: billId,
    clientId,
    sourceType: 'bill',
    createdAt: now,
    title: 'Material change',
    changeType: 'bill_enacted',
    severity: 'critical',
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export function cursor(value: { t: string; id: string; c?: string }) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
