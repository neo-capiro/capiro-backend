import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import type { SelectedRecordBrief } from './RecordBriefSelection.js';

export const REPORT_BASE = '/intel-api/legiwatch/reports';
export const reportKey = (scope: string) => ['legiwatch-reports', scope] as const;
export function useReportsFlag() {
  const api = useApi(),
    scope = useApiScope();
  const q = useQuery({
    queryKey: [...reportKey(scope), 'flag'],
    queryFn: async () => (await api.get<Record<string, boolean>>('/intel-api/feature-flags')).data,
    staleTime: 30000,
    retry: false,
  });
  return {
    enabled: q.data?.legiwatch_reports_updates_v1 === true,
    deliveryEnabled: q.data?.legiwatch_report_delivery_v1 === true,
    scope,
  };
}
export interface Settings {
  committees: string;
  actions: string;
  relations: string;
  order: string;
  links: string;
  summary: boolean;
  priority: boolean;
  internalComments: boolean;
  externalComments: boolean;
  billNotes: boolean;
  reportComments: boolean;
  priorityOnly: boolean;
  acceptOptionalGaps: boolean;
  includeArchived: boolean;
  actionDateFrom?: string;
  actionDateTo?: string;
}
export const defaultSettings: Settings = {
  committees: 'off',
  actions: 'last',
  relations: 'off',
  summary: true,
  order: 'number',
  links: 'subscribers',
  priority: false,
  internalComments: false,
  externalComments: false,
  billNotes: false,
  reportComments: false,
  priorityOnly: false,
  acceptOptionalGaps: false,
  includeArchived: false,
};
export interface Report {
  id: string;
  name: string;
  folderIds: string[];
  jurisdiction: string;
  sessionKey: string;
  settings: Settings;
  version: number;
  canEdit?: boolean;
  sourceId?: string;
  lastGeneratedAt?: string;
}
export interface Run {
  id: string;
  reportId: string;
  complete: boolean;
  generatedAt: string;
  cutoff: string;
  audience: string;
  definitionVersion: number;
  contentHash: string;
  rendered?: { html: string; text: string };
}
export interface Contact {
  id: string;
  name: string;
  email: string | null;
  verified: boolean;
  active: boolean;
  optedOut: boolean;
  version: number;
}
export interface List {
  id: string;
  name: string;
  contactIds: string[];
  private: boolean;
  active: boolean;
  version: number;
}
export interface Directory {
  contacts: Contact[];
  lists: List[];
  senderEmail: string | null;
}
export interface Selection {
  kind: 'contact' | 'list' | 'manual';
  id?: string;
  email?: string;
  role: 'to' | 'bcc';
}
export interface Recipient {
  email: string;
  role: 'to' | 'bcc';
  name: string;
  contacts: Array<{ id: string; version: number }>;
  lists: Array<{ id: string; version: number }>;
  manual: boolean;
}
export interface Composition {
  approvalHash: string;
  complete: boolean;
  composition: {
    recipients: Recipient[];
    html: string;
    plainText?: string;
    subject: string;
    introduction: string;
  };
}
export interface Subscription {
  recordBriefs?: import('./RecordBriefSelection.js').SelectedRecordBrief[];
  id: string;
  reportId: string;
  mode: string;
  enabled: boolean;
  timezone: string;
  localMinutes: number;
  version: number;
  nextDueAt: string | null;
  baselineAt: string | null;
  subject: string;
  introduction: string;
  recipients: Recipient[];
  sendNoChange: boolean;
}
export interface Occurrence {
  composition?: { plainText: string; subject: string; recordBriefs?: SelectedRecordBrief[] } | null;
  id: string;
  state: string;
  intendedAt: string;
  windowStart: string;
  windowEnd: string;
  runId: string | null;
  error: string | null;
}
export interface Rule {
  id: string;
  name: string;
  folderIds: string[];
  cadence: string;
  timezone: string | null;
  localMinutes: number | null;
  state: string;
  version: number;
  issues: string[];
  recipients: Array<{ userId: string; email: boolean; inApp: boolean }>;
}
export interface Staged {
  id: string;
  sourceId: string;
  kind: string;
  state: string;
  version: number;
}
export const statusLabel = (state: string) =>
  state === 'provider_accepted'
    ? 'Accepted by provider'
    : state === 'uncertain'
      ? 'Outcome unconfirmed — review required'
      : state.replaceAll('_', ' ');
