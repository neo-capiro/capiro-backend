import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import type { FeedItem } from './intel-feed-api.js';

/**
 * Client hooks for alert actions. Generation lives in apps/api (Memory files +
 * per-tenant key + docx + Documents), so `alert-memo` calls `/api/...`; the
 * alert-side action state lives in intel-api, so the curation calls hit
 * `/intel-api/...`. The composer orchestrates: generate (apps/api) → record the
 * Document link (intel-api) → refresh the Feed so it shows "memo drafted".
 */

export interface AlertMemoAlertInput {
  alertId: string;
  sourceType: 'bill' | 'hearing' | 'combined';
  title: string;
  whyItMatters?: string | null;
  severity?: string | null;
  band?: string | null;
  sourceRef?: string | null;
  billDisplayNum?: string | null;
  billTitle?: string | null;
  actionText?: string | null;
  actionDate?: string | null;
  committee?: string | null;
  hearingTitle?: string | null;
  quotes?: Array<{ text: string; speaker?: string; atSec?: number }>;
  url?: string | null;
  matchedTags?: string[];
}

export interface AlertMemoResult {
  title: string;
  markdown: string;
  sections: Array<{ heading: string; paragraphs: Array<{ text: string; claimIds: string[] }> }>;
  sources: Array<{ claimId: string; label: string; url?: string | null }>;
  document: { attachmentId: string; fileName: string } | null;
  usedTenantKey: boolean;
  model: string;
  lowConfidence: boolean;
  memoryFilesUsed: string[];
}

/** Map a Feed alert into the memo generator's input. */
export function feedItemToMemoAlert(item: FeedItem): AlertMemoAlertInput {
  const bill = item.evidence?.bill;
  const hearing = item.evidence?.hearing;
  const quotes = (hearing?.mentions ?? [])
    .map((m) => ({
      text: m.quote ?? '',
      speaker: m.speakerName ?? undefined,
      atSec: m.timestampMs != null ? Math.floor(m.timestampMs / 1000) : undefined,
    }))
    .filter((q) => q.text.trim());
  const tags = Array.from(
    new Set((hearing?.mentions ?? []).flatMap((m) => m.issueTags ?? []).filter(Boolean)),
  );
  return {
    alertId: item.id,
    // State Legislation Platform (S7) + Phase 1 M3.3: the memo generator only
    // accepts 'bill'|'hearing'|'combined' — recommendedActionsFor in intel-api
    // never offers "Draft memo"/"Generate district brief" for a state_bill or
    // regulation alert, so this path shouldn't be reachable for either in
    // practice; map defensively to 'bill' rather than sending a value the
    // server's @IsIn(['bill','hearing','combined']) would reject.
    sourceType:
      item.sourceType === 'state_bill' || item.sourceType === 'regulation'
        ? 'bill'
        : item.sourceType,
    title: item.title,
    whyItMatters: item.whyItMatters,
    severity: item.severity,
    band: item.materiality,
    sourceRef: bill?.billId ?? null,
    billDisplayNum: bill?.displayNum ?? null,
    billTitle: bill?.title ?? null,
    actionText: bill?.actionText ?? null,
    actionDate: bill?.actionDate ?? null,
    hearingTitle: hearing?.title ?? null,
    quotes: quotes.length ? quotes : undefined,
    url: bill?.url ?? null,
    matchedTags: tags.length ? tags : undefined,
  };
}

/**
 * The district-brief generator's DTO has the exact same shape/validator as the
 * memo's (Phase 1 M1.5) — including the same 'state_bill' -> 'bill' mapping —
 * so it reuses feedItemToMemoAlert directly rather than duplicating it.
 */
export const feedItemToDistrictBriefAlert = feedItemToMemoAlert;

export function useGenerateAlertMemo() {
  const api = useApi();
  return useMutation({
    mutationFn: async (input: {
      clientId: string;
      clientName: string;
      alert: AlertMemoAlertInput;
      replaceAttachmentId?: string;
    }) =>
      (
        await api.post<AlertMemoResult>(
          `/api/intelligence/clients/${encodeURIComponent(input.clientId)}/alert-memo`,
          {
            clientName: input.clientName,
            alert: input.alert,
            replaceAttachmentId: input.replaceAttachmentId,
          },
        )
      ).data,
  });
}

export interface DistrictBriefResult {
  title: string;
  markdown: string;
  sections: Array<{ heading: string; paragraphs: Array<{ text: string; claimIds: string[] }> }>;
  sources: Array<{ claimId: string; label: string; url?: string | null }>;
  document: { attachmentId: string; fileName: string } | null;
  usedTenantKey: boolean;
  model: string;
  lowConfidence: boolean;
  memoryFilesUsed: string[];
  facility: { id: string; name: string; city: string | null; state: string | null };
}

/** District-impact one-pager (Phase 1 M1.5, PD6) — same alert shape as the memo, plus which facility to ground it in. */
export function useGenerateDistrictBrief() {
  const api = useApi();
  return useMutation({
    mutationFn: async (input: {
      clientId: string;
      facilityId: string;
      alert: AlertMemoAlertInput;
      replaceAttachmentId?: string;
    }) =>
      (
        await api.post<DistrictBriefResult>(
          `/api/intelligence/clients/${encodeURIComponent(input.clientId)}/facilities/${encodeURIComponent(input.facilityId)}/district-brief`,
          { alert: input.alert, replaceAttachmentId: input.replaceAttachmentId },
        )
      ).data,
  });
}

export function useSaveAlertMemo() {
  const api = useApi();
  return useMutation({
    mutationFn: async (input: {
      clientId: string;
      title: string;
      markdown: string;
      clientName: string;
      actionDate?: string;
      replaceAttachmentId?: string;
    }) =>
      (
        await api.post<{
          document: { attachmentId: string; fileName: string } | null;
          title: string;
        }>(`/api/intelligence/clients/${encodeURIComponent(input.clientId)}/alert-memo/save`, input)
      ).data,
  });
}

export function useRecordMemoLink() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      clientId: string;
      alertId: string;
      documentAttachmentId?: string;
      title?: string;
    }) =>
      (
        await api.post(
          `/intel-api/clients/${encodeURIComponent(input.clientId)}/alerts/${encodeURIComponent(input.alertId)}/memo-link`,
          { documentAttachmentId: input.documentAttachmentId, title: input.title },
        )
      ).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['intel-feed'] }),
  });
}

export function useAddTalkingPoint() {
  const api = useApi();
  return useMutation({
    mutationFn: async (input: { clientId: string; alertId: string; text: string }) =>
      (
        await api.post(
          `/intel-api/clients/${encodeURIComponent(input.clientId)}/alerts/${encodeURIComponent(input.alertId)}/talking-point`,
          { text: input.text },
        )
      ).data,
  });
}

export function useSetReport() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { clientId: string; alertId: string; on: boolean }) =>
      (
        await api.post(
          `/intel-api/clients/${encodeURIComponent(input.clientId)}/alerts/${encodeURIComponent(input.alertId)}/report`,
          { on: input.on },
        )
      ).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['intel-feed'] }),
  });
}
