import type { ActionCardDto, ActionStatus } from '../actions/types.js';
import type { Meeting } from '../engagement/meetings/meetings-types.js';
import type { Client, ClientAttachment } from './clientTypes.js';

export interface ClientPerson {
  id: string;
  clientId: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  role: string | null;
  lastContact: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface CapabilityRecord {
  id: string;
  clientId: string;
  name: string;
  type: string;
  description: string | null;
  sector: string | null;
  tags: string[];
  issueCodes?: string[];
  trl: number | null;
  mrl: number | null;
  peNumber: string | null;
  peNumbers: string[];
  keywords: string[];
  appropriationAccount: string | null;
  serviceBranch: string | null;
  targetSubcommittee: string | null;
  fundingAsk: number | null;
  fundingAskLabel: string | null;
  justification: string | null;
  districtNexus: string | null;
  existingContracts: string | null;
  notes: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface SubmissionHistory {
  id: string;
  clientId: string;
  capabilityId: string | null;
  fiscalYear: string;
  title: string;
  meta: string | null;
  outcome: string | null;
  outcomeType: 'success' | 'partial' | 'failed' | 'in_progress' | string;
  notes: string | null;
  createdAt: string;
}

export interface KbStatusResponse {
  counts: {
    client_profile?: number;
    client_person?: number;
    client_facility?: number;
    client_doc_chunk?: number;
  };
  lastIndexedAt: string | null;
}

export type CrmTab =
  | 'overview'
  | 'activity'
  | 'capabilities'
  | 'intelligence'
  | 'relationships'
  | 'files';
export type RelationshipView = 'contacts' | 'government' | 'locations';
export type IntelligenceView = 'summary' | 'client' | 'legiwatch';
export type ActivityKind = 'meeting' | 'action' | 'file';

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  at: string;
  title: string;
  meta: string;
}

export interface AttentionItem {
  id: string;
  urgent: boolean;
  title: string;
  copy: string;
  action: 'activity' | 'intelligence' | 'edit';
  rank: number;
}

export const CLOSED_ACTION_STATUSES = new Set<ActionStatus>(['dismissed', 'archived']);

export const TAB_LABELS: Array<{ key: CrmTab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'activity', label: 'Activity' },
  { key: 'capabilities', label: 'Capabilities' },
  { key: 'intelligence', label: 'Intelligence' },
  { key: 'relationships', label: 'Relationships' },
  { key: 'files', label: 'Files' },
];

export function buildActivityItems(
  actions: ActionCardDto[],
  meetings: Meeting[],
  documents: ClientAttachment[],
): ActivityItem[] {
  const rows: ActivityItem[] = [
    ...actions.map((action) => ({
      id: action.id,
      kind: 'action' as const,
      at: action.updatedAt,
      title: action.issueTitle,
      meta: action.recommendedAction,
    })),
    ...meetings.map((meeting) => ({
      id: meeting.id,
      kind: 'meeting' as const,
      at: meeting.startsAt,
      title: meeting.subject,
      meta: `${meeting.attendees.length} attendee${meeting.attendees.length === 1 ? '' : 's'}${meeting.notes.length ? ' · Notes' : ''}${meeting.debriefs.length ? ' · Debrief' : ''}`,
    })),
    ...documents.map((document) => ({
      id: document.id,
      kind: 'file' as const,
      at: document.createdAt,
      title: document.fileName,
      meta: `${documentSourceLabel(document.source)}${document.uploadedByName ? ` · ${document.uploadedByName}` : ''}`,
    })),
  ];
  const seen = new Set<string>();
  return rows
    .sort((a, b) => dateValue(b.at) - dateValue(a.at))
    .filter((row) => {
      const key = `${row.kind}:${row.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function buildAttentionItems(
  client: Client,
  actions: ActionCardDto[],
  meetings: Meeting[],
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const action of actions.slice(0, 5)) {
    const dueSoon = action.deadline ? daysUntil(action.deadline) <= 7 : false;
    items.push({
      id: `action:${action.id}`,
      urgent: action.priority >= 80 || dueSoon,
      title: action.issueTitle,
      copy: action.whyItMatters || action.recommendedAction,
      action: 'activity',
      rank: action.priority + (dueSoon ? 35 : 0),
    });
  }

  const samExpiration = readText(toRecord(client.intakeData), ['samExpirationDate']);
  const samDays = samExpiration ? daysUntil(samExpiration) : null;
  if (samDays != null && samDays >= 0 && samDays <= 60) {
    items.push({
      id: 'sam-expiration',
      urgent: samDays <= 30,
      title: `SAM.gov registration expires in ${samDays} day${samDays === 1 ? '' : 's'}`,
      copy: 'Keep the client registration current so eligibility and government identifiers remain reliable.',
      action: 'edit',
      rank: samDays <= 30 ? 130 : 95,
    });
  }

  const now = Date.now();
  const upcoming = meetings
    .filter((meeting) => dateValue(meeting.startsAt) >= now)
    .sort((a, b) => dateValue(a.startsAt) - dateValue(b.startsAt))[0];
  if (upcoming && daysUntil(upcoming.startsAt) <= 7) {
    const days = daysUntil(upcoming.startsAt);
    items.push({
      id: `meeting:${upcoming.id}`,
      urgent: days <= 2,
      title: `Upcoming meeting: ${upcoming.subject}`,
      copy: formatDateTime(upcoming.startsAt),
      action: 'activity',
      rank: days <= 2 ? 120 : 85,
    });
  }

  const seen = new Set<string>();
  return items
    .sort((a, b) => b.rank - a.rank)
    .filter((item) => {
      const key = item.title.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
}

export function readInitialRoute(): {
  tab: CrmTab;
  relationshipView: RelationshipView;
  intelligenceView: IntelligenceView;
} {
  let tab: CrmTab = 'overview';
  let relationshipView: RelationshipView = 'contacts';
  let intelligenceView: IntelligenceView = 'summary';
  try {
    const raw = new URLSearchParams(window.location.search).get('tab');
    if (raw && TAB_LABELS.some((entry) => entry.key === raw)) tab = raw as CrmTab;
    if (raw === 'documents') tab = 'files';
    if (raw === 'people') {
      tab = 'relationships';
      relationshipView = 'contacts';
    }
    if (raw === 'targets') {
      tab = 'relationships';
      relationshipView = 'government';
    }
    if (raw === 'facilities') {
      tab = 'relationships';
      relationshipView = 'locations';
    }
    if (raw === 'tracker' || raw === 'radar' || raw === 'legiwatch') {
      tab = 'intelligence';
      intelligenceView = 'legiwatch';
    }
  } catch {
    // Browser history is best effort.
  }
  return { tab, relationshipView, intelligenceView };
}

export function documentSourceLabel(source: string | null | undefined): string {
  const value = (source ?? '').toLowerCase();
  if (value.startsWith('capability:')) return 'Capability';
  if (value.includes('hearing')) return 'Hearing recap';
  if (value.includes('meeting')) return 'Meeting';
  if (value.includes('memo') || value.includes('generated')) return 'Generated';
  if (value.includes('mail') || value.includes('email')) return 'Email';
  return 'Uploaded';
}

export function kbTotal(status?: KbStatusResponse): number {
  return (Object.values(status?.counts ?? {}) as Array<number | undefined>).reduce<number>(
    (sum, value) => sum + (value ?? 0),
    0,
  );
}

export function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readText(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return undefined;
}

export function optional(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function cleanObject(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      typeof value === 'string' && value.trim() === '' ? null : value,
    ]),
  );
}

export function dateValue(value: string | null | undefined): number {
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

export function deadlineValue(value: string | null | undefined): number {
  const time = value ? new Date(value).getTime() : Number.MAX_SAFE_INTEGER;
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

export function daysUntil(value: string): number {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 9999;
  return Math.ceil((time - Date.now()) / 86_400_000);
}

export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatOptionalDate(value: string | undefined): string | null {
  return value ? formatDate(value) : null;
}

export function formatMonthYear(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatActivityDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatMoney(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return `$${Math.round(value).toLocaleString()}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const message = (error as { response?: { data?: { message?: unknown } } }).response?.data?.message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.join(', ');
  }
  return error instanceof Error ? error.message : 'Request failed';
}
