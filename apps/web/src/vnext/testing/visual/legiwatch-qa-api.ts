import type { AxiosRequestConfig, AxiosResponse } from 'axios';

const clients = [
  { id: 'qa-client', name: 'QA Policy Group', status: 'active' },
];
const bills = [
  {
    id: 'qa-bill-8800', billId: 'hr8800-119', referenceId: 'H.R. 8800', title: 'A deterministic bill fixture',
    congress: 119, billType: 'hr', number: 'H.R. 8800', jurisdiction: 'US', sessionKey: '119', status: 'Introduced', sponsor: 'QA Sponsor',
    updatedAt: '2026-09-18T10:00:00.000Z',
  },
];
const hearings = [
  { id: 'qa-hearing-1', hearingId: 'qa-hearing-1', title: 'Oversight hearing fixture', committeeName: 'QA Committee',
    startsAt: '2026-09-19T14:00:00.000Z', status: 'scheduled', chamber: 'House' },
];
const feedItem = {
  id: 'qa-alert-1', alertId: 'qa-alert-1', clientId: 'qa-client', title: 'QA policy update',
  summary: 'Deterministic LegiWatch alert fixture', source: 'Congress', occurredAt: '2026-09-18T09:00:00.000Z',
  workState: 'new', severity: 'medium', entityType: 'bill', entityId: 'qa-bill-8800',
};

const response = <T>(data: T): AxiosResponse<T> => ({ data, status: 200, statusText: 'OK', headers: {}, config: {} as AxiosResponse['config'] });

function dataFor(url: string): unknown {
  if (url === '/api/clients') return clients;
  if (url === '/api/me') return { user: { id: 'qa-user', clerkUserId: 'qa-user' } };
  if (url.includes('/archive/search')) return { rows: [], total: 0, corpusTotal: 0, page: 1, pageSize: 20, hasMore: false, query: null, matchMode: null, facets: { chamber: [], committee: [], eventStatus: [] } };
  if (url.includes('/tracker/watchlists/')) return { topics: ['health'], issueAreas: ['health'], suggestedIssueAreas: [] };
  if (url.includes('/feed')) return { items: [feedItem], hasMore: false, nextCursor: null, workStateCounts: { new: 1, in_review: 0, assigned: 0, actioned: 0, snoozed: 0, dismissed: 0 } };
  if (url.includes('/hearings/history')) return { items: [], hasMore: false, nextCursor: null };
  if (url.includes('/tracker/board')) return { columns: [{ id: 'introduced', label: 'Introduced', cards: [{
    billId: 'qa-bill-8800', displayNum: 'H.R. 8800', title: 'A deterministic bill fixture',
    stage: 'introduced', passageProbability: 0.5, latestActionText: 'Introduced',
    latestActionDate: '2026-09-18', note: null, isManual: true, unread: false,
    trackedAt: '2026-09-18T10:00:00.000Z', matchedTags: ['health'], changeChip: null,
    clientId: 'qa-client', clientName: 'QA Policy Group', jurisdiction: 'US',
  }] }], total: 1, hasMore: false, nextCursor: null };
  if (url.includes('feature-flags')) return { tracker_v2: true, legiwatch_internal_workflows_v1: true, legiwatch_folder_tracker_v1: false, legiwatch_reports_updates_v1: true, legiwatch_research_v1: true };
  if (url.includes('/analytics/summary')) return { signalsTotal: 0, sourceFamiliesInvolved: 0, clientDecisions: 0, billsMoved: 0, billsTrackedTotal: 0, sourceCoveragePct: null, sourceFamiliesCurrent: 0, sourceFamiliesTotal: 0 };
  if (url.includes('/analytics/signal-volume')) return { total: 0, days: [] };
  if (url.includes('/analytics/issue-momentum')) return { topics: [] };
  if (url.includes('/analytics/client-exposure')) return { rows: [] };
  if (url.includes('/analytics/committee-activity')) return { total: 0, rows: [] };
  if (url.includes('/analytics/source-coverage')) return { sources: [] };
  if (url.includes('/digest/history')) return { rows: [] };
  if (url.includes('/digest/schedule/config')) return { cadence: 'off', hourUtc: 11, emailEnabled: false };
  if (url === '/intel-api/legiwatch/reports') return [];
  if (url.includes('/sessions/')) return [{ key: '119', label: '119th Congress' }];
  if (url === '/intel-api/legiwatch/bills/search') return { rows: bills, total: bills.length, hasMore: false, nextCursor: null };
  if (url === '/intel-api/legiwatch/research/search') return { items: [{ id: 'qa-bill-text-8800', billId: 'qa-bill-8800', billIdentifier: 'H.R. 8800', billTitle: 'A deterministic bill fixture', title: 'A deterministic bill fixture', excerpt: { quote: 'Deterministic bill-document text fixture.' } }], cursor: null };
  if (url.includes('/legiwatch/reports/recipients')) return { contacts: [], lists: [], senderEmail: null };
  if (url === '/intel-api/legiwatch/folders') return [];
  if (url.includes('live-hearings/committees')) return { committees: [{ systemCode: 'qa', name: 'QA Committee', chamber: 'House' }], folders: [{ id: 'qa-folder', name: 'QA Folder', clientId: 'qa-client' }] };
  if (url.includes('live-hearings/calendar/coverage')) return { rows: [
    { chamber: 'house', status: 'ok', checkedAt: '2026-09-18T10:00:00.000Z', items: 1, details: { expected: 1, found: 1 } },
    { chamber: 'senate', status: 'ok', checkedAt: '2026-09-18T10:00:00.000Z', items: 0, details: { expected: 0, found: 0 } },
  ] };
  if (url.includes('live-hearings/calendar')) return { items: hearings, total: hearings.length };
  if (url.includes('/folders')) return { folders: [{ id: 'qa-folder', name: 'QA Folder', clientId: 'qa-client', billCount: 1 }], rows: [{ id: 'qa-folder', name: 'QA Folder', clientId: 'qa-client', billCount: 1 }] };
  if (url.includes('foldered-bills') || url.includes('/bills')) return { items: bills, rows: bills, bills, total: bills.length, hasMore: false, nextCursor: null };
  if (url.includes('analytics')) return {};
  return {};
}

export function createLegiWatchQaApi() {
  const request = async <T>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> => response(dataFor(String(config.url ?? '')) as T);
  return {
    get: <T = unknown>(url: string, config?: AxiosRequestConfig) => request<T>({ ...config, method: 'GET', url }),
    post: async <T = unknown>(url: string, _body?: unknown, config?: AxiosRequestConfig) => request<T>({ ...config, method: 'POST', url }),
    put: async <T = unknown>(url: string, _body?: unknown, config?: AxiosRequestConfig) => request<T>({ ...config, method: 'PUT', url }),
    patch: async <T = unknown>(url: string, _body?: unknown, config?: AxiosRequestConfig) => request<T>({ ...config, method: 'PATCH', url }),
    delete: async <T = unknown>(url: string, config?: AxiosRequestConfig) => request<T>({ ...config, method: 'DELETE', url }),
  };
}

export function useApi(): LegiWatchQaApi {
  return createLegiWatchQaApi();
}

export type LegiWatchQaApi = ReturnType<typeof createLegiWatchQaApi>;
