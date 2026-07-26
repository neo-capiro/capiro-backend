// Outreach v2 — Phase 0 send-intent client (plan §3.g6).
//
// Replaces the raw send mutation. The wizard no longer POSTs subject/body: it
// submits DRAFT VERSION IDS and then polls one durable intent.
//
// The three behaviours that used to be wrong:
//   • A double Send click fired two independent sends. Now one request key is
//     minted per click and REUSED across network retries, so the server dedupes.
//   • An oversized attachment was reported as "skipped" AFTER the emails went
//     out. Now it is caught before submission.
//   • Every failure looked retryable. An `unknown` delivery is now explicitly
//     NOT retryable — the message may already have been delivered.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AxiosInstance } from 'axios';
import type { OutreachTarget } from './targets.js';
import { audienceIdOf } from './generation.js';
import { recipientKey, type WizardV2State } from './types.js';
import { isDraftSendable } from './versioned-drafts.js';

export type DeliveryStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'unknown'
  | 'skipped'
  | 'held';

export type SendIntentStatus =
  | 'queued'
  | 'running'
  | 'partial'
  | 'complete'
  | 'failed'
  | 'canceled';

export interface DeliveryView {
  id: string;
  generationKey: string;
  recipientKey: string;
  status: DeliveryStatus;
  attempt: number;
  provider: string;
  correlationId: string;
  to: Array<{ email: string; name?: string | null }>;
  cc: string[];
  bcc: string[];
  subject: string;
  providerMessageId: string | null;
  providerThreadId: string | null;
  providerDraftId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  acceptedAt: string | null;
}

export interface SendIntentView {
  id: string;
  outreachRecordId: string;
  status: SendIntentStatus;
  testMode: boolean;
  requestKey: string;
  totals: Record<string, number>;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  deliveries: DeliveryView[];
}

/** One logical send unit: a version id and the slot it came from. */
export interface SendUnit {
  genKey: string;
  draftVersionId: string;
}

/**
 * Project the targets to the version ids that may be sent.
 *
 * Replaces projectDraftsForSend() for the versioned path. It returns IDS ONLY —
 * there is no subject/body here, by design, so the wizard structurally cannot
 * submit unaudited text. Non-sendable slots (pending / held / unavailable /
 * rejected / dirty) are excluded.
 */
export function projectVersionIdsForSend(
  targets: OutreachTarget[],
  generated: WizardV2State['generatedEmails'],
): SendUnit[] {
  const out: SendUnit[] = [];
  const seenVersion = new Set<string>();

  const take = (genKey: string) => {
    const draft = generated[genKey];
    if (!draft?.versionId) return;
    if (!isDraftSendable(draft)) return;
    if (seenVersion.has(draft.versionId)) return;
    seenVersion.add(draft.versionId);
    out.push({ genKey, draftVersionId: draft.versionId });
  };

  // Groups first, then lists, then individuals — the same precedence the legacy
  // projection used, so send ordering is unchanged.
  for (const t of targets) {
    if (t.type !== 'group') continue;
    take(`group:${audienceIdOf(t)}`);
  }
  for (const t of targets) {
    if (t.type !== 'list') continue;
    const aid = audienceIdOf(t);
    for (const m of t.recipients) take(`list:${aid}:${recipientKey(m)}`);
  }
  for (const t of targets) {
    if (t.type !== 'individual') continue;
    const r = t.recipients[0];
    if (r) take(`individual:${recipientKey(r)}`);
  }
  return out;
}

/**
 * Mint a request key ONCE per Send click.
 *
 * `existing` is returned unchanged so a retry after a network error reuses the
 * same key and resolves to the same intent instead of starting a second send.
 */
export function ensureRequestKey(existing: string | null | undefined): string {
  if (existing && existing.length >= 8) return existing;
  return `snd-${crypto.randomUUID()}`;
}

/** A test send is a DIFFERENT logical operation, so it gets its own key space. */
export function ensureTestRequestKey(existing: string | null | undefined): string {
  if (existing && existing.length >= 8) return existing;
  return `tst-${crypto.randomUUID()}`;
}

/** Worth polling? Terminal intents stop the poll. */
export function isIntentActive(status: SendIntentStatus | undefined): boolean {
  return status === 'queued' || status === 'running';
}

/**
 * Can the user retry this delivery (by creating a NEW intent)?
 *
 * ONLY a clear pre-acceptance failure. `unknown` is deliberately excluded: the
 * provider may already have delivered it, so a retry risks a duplicate email to a
 * congressional office. This is the client half of the at-most-once guarantee.
 */
export function isDeliveryRetryable(status: DeliveryStatus): boolean {
  return status === 'failed';
}

/** Per-status copy. `unknown` tells the user exactly what to do instead of retrying. */
export const DELIVERY_STATUS_COPY: Record<DeliveryStatus, string> = {
  pending: 'Queued',
  sending: 'Sending…',
  sent: 'Sent',
  failed: 'Failed',
  unknown: 'Delivery outcome unknown — verify Sent Items before retrying.',
  skipped: 'Not sent (cancelled)',
  held: 'Held for review',
};

/** Should a Retry control render for this row? */
export function showRetryControl(status: DeliveryStatus): boolean {
  return isDeliveryRetryable(status);
}

/**
 * The generation keys a "retry failed" action may resubmit.
 *
 * Only clear failures — `unknown` is excluded by isDeliveryRetryable, and `sent`
 * rows must never be included: resubmitting a delivered draft would collide with
 * the server's (tenant, idempotencyKey) unique index, which rolls the ENTIRE new
 * intent back and makes a partial-failure retry fail outright.
 */
export function retryableGenKeys(intent: SendIntentView | undefined): string[] {
  if (!intent) return [];
  return [
    ...new Set(
      intent.deliveries.filter((d) => showRetryControl(d.status)).map((d) => d.generationKey),
    ),
  ];
}

/**
 * Narrow the projected send units to an explicit generation-key scope.
 *
 * `null`/empty scope means "everything currently sendable" (a first send). A
 * non-empty scope is a retry and is honoured exactly: a unit that is no longer
 * sendable is simply absent from `units`, so a retry can only ever shrink, never
 * silently pick up a draft the user did not select.
 */
export function scopeUnitsToGenKeys(
  units: SendUnit[],
  onlyGenKeys?: string[] | null,
): SendUnit[] {
  if (!onlyGenKeys?.length) return units;
  const scope = new Set(onlyGenKeys);
  return units.filter((u) => scope.has(u.genKey));
}

export interface AttachmentPreflightIssue {
  id: string;
  fileName: string;
  byteSize: number;
  reason: 'too_large';
}

/** Graph/Gmail simple-send inline ceiling, mirrored from the server. */
export const INLINE_ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;

/**
 * Catch oversized attachments BEFORE submitting. The server also rejects them,
 * but showing it here means the user fixes it without a failed round-trip — and
 * nothing is ever silently omitted from a sent email.
 */
export function attachmentPreflight(
  attachmentIds: string[],
  docs: Array<{ id: string; fileName: string; byteSize?: number | null }>,
): AttachmentPreflightIssue[] {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const issues: AttachmentPreflightIssue[] = [];
  for (const id of attachmentIds) {
    const doc = byId.get(id);
    if (!doc?.byteSize) continue; // unknown size: the server is the backstop
    if (doc.byteSize > INLINE_ATTACHMENT_MAX_BYTES) {
      issues.push({ id, fileName: doc.fileName, byteSize: doc.byteSize, reason: 'too_large' });
    }
  }
  return issues;
}

/** Roll deliveries into the summary the Send step shows. */
export function summarizeIntent(intent: SendIntentView | undefined): {
  sent: number;
  failed: number;
  unknown: number;
  skipped: number;
  inFlight: number;
  total: number;
  /** True while ANY outcome is undetermined — never report a blanket success. */
  hasUnknown: boolean;
} {
  const rows = intent?.deliveries ?? [];
  const count = (s: DeliveryStatus) => rows.filter((r) => r.status === s).length;
  const unknown = count('unknown');
  return {
    sent: count('sent'),
    failed: count('failed'),
    unknown,
    skipped: count('skipped'),
    inFlight: count('pending') + count('sending'),
    total: rows.length,
    hasUnknown: unknown > 0,
  };
}

// ── API calls ────────────────────────────────────────────────────────────────

export interface CreateSendIntentBody {
  outreachRecordId: string;
  requestKey: string;
  senderConnectionId: string;
  draftVersionIds: string[];
  attachmentIds?: string[];
  appendSignature?: boolean;
  testMode?: boolean;
}

export async function createSendIntent(
  api: AxiosInstance,
  body: CreateSendIntentBody,
): Promise<{ intentId: string; deduped: boolean }> {
  const res = await api.post<{ intentId: string; deduped: boolean }>(
    '/api/engagement/outreach/send-intents',
    body,
  );
  return res.data;
}

export async function cancelSendIntent(
  api: AxiosInstance,
  intentId: string,
): Promise<{ canceled: boolean; skipped: number; inFlight: number; terminal: number }> {
  const res = await api.post<{
    canceled: boolean;
    skipped: number;
    inFlight: number;
    terminal: number;
  }>(`/api/engagement/outreach/send-intents/${intentId}/cancel`, {});
  return res.data;
}

/**
 * Poll ONE intent every two seconds while queued/running, then stop. Actively
 * watched progress, so a tighter interval than the passive pollers elsewhere is
 * intentional; not refetched in the background.
 */
export function useSendIntent(
  api: AxiosInstance,
  intentId: string | null,
): { intent: SendIntentView | undefined; isPolling: boolean } {
  const query = useQuery({
    queryKey: ['outreach-send-intent', intentId] as const,
    enabled: !!intentId,
    queryFn: async () =>
      (await api.get<SendIntentView>(`/api/engagement/outreach/send-intents/${intentId}`)).data,
    refetchInterval: (q: { state: { data?: SendIntentView } }) =>
      isIntentActive(q.state.data?.status) ? 2000 : (false as const),
    refetchIntervalInBackground: false,
  });
  return useMemo(
    () => ({
      intent: query.data,
      isPolling: !!intentId && isIntentActive(query.data?.status),
    }),
    [intentId, query.data],
  );
}
