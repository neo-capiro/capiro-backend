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

/** P0-08: the PE funding facts the memo generator now grounds a PE memo in. */
export interface AlertMemoProgramElement {
  peCode: string;
  title?: string | null;
  fiscalYear?: number | null;
  deltaType?: string | null;
  deltaTypeLabel?: string | null;
  fromRef?: string | null;
  toRef?: string | null;
  amountFromMillions?: number | null;
  amountToMillions?: number | null;
  deltaMillions?: number | null;
  deltaPct?: number | null;
  href?: string | null;
}

export interface AlertMemoAlertInput {
  alertId: string;
  sourceType: 'bill' | 'hearing' | 'combined' | 'program_element';
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
  programElement?: AlertMemoProgramElement;
}

/** §4.6: a cited source, with when it was pulled and how well it is attested. */
export interface AlertMemoSource {
  claimId: string;
  label: string;
  url?: string | null;
  retrievedAt?: string;
  verification?: 'official' | 'verified' | 'extracted' | 'unverified';
  page?: number;
}

export interface AlertMemoResult {
  title: string;
  markdown: string;
  sections: Array<{ heading: string; paragraphs: Array<{ text: string; claimIds: string[] }> }>;
  sources: AlertMemoSource[];
  document: { attachmentId: string; fileName: string } | null;
  usedTenantKey: boolean;
  model: string;
  lowConfidence: boolean;
  memoryFilesUsed: string[];
  /** §4.6: context the compiler saw and withheld, with the reason. Optional so a
   *  not-yet-deployed apps/api degrades cleanly. */
  contextExcluded?: Array<{ title: string; reason: string }>;
  held: boolean;
  reviewRequestId: string | null;
  heldReason: string;
}

/**
 * P1-15: the SAME paragraph-anchor format apps/api's withClaimAnchors defines
 * (alert-memo.service.ts) — that function is the definition of the format; this is its
 * web twin for the "Open in Workspace" path, which builds its draft from the structured
 * `sections` rather than from the server's markdown. A test asserts both render
 * "Text. [c1][c2]".
 *
 * Left unescaped on purpose: markdownishToHtml's inline() only linkifies the
 * `[text](url)` form, so a bare `[c1]` survives as literal text (richtext.ts).
 */
export function withClaimAnchors(text: string, claimIds?: string[]): string {
  if (!claimIds?.length) return text;
  return `${text} ${claimIds.map((id) => `[${id}]`).join('')}`;
}

/** Map a Feed alert into the memo generator's input. */
export function feedItemToMemoAlert(item: FeedItem): AlertMemoAlertInput {
  const bill = item.evidence?.bill;
  const hearing = item.evidence?.hearing;
  const pe = item.evidence?.programElement;
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
    // State Legislation Platform (S7) + Phase 1 M3.3 + W4.4: the memo generator
    // only accepts 'bill'|'hearing'|'combined'. recommendedActionsFor (intel-api)
    // does NOT offer "Draft memo" for a state_bill or a regulation alert (and a
    // regulation gets no bill-shaped action at all — no memo, district brief, or
    // open-bill), so this memo path shouldn't be reachable for those in practice.
    // (A state_bill DOES still get "Generate district brief" — that has its own
    // endpoint below and accepts state bills.) Map defensively to 'bill' rather
    // than send a value the server's @IsIn(['bill','hearing','combined']) rejects.
    // P0-08: program_element is now a FIRST-CLASS memo source — apps/api's @IsIn
    // accepts it and it has a PE-shaped prompt, section order, and claim builder. Sending
    // it as 'bill' would drop every funding fact, which was the bug. state_bill and
    // regulation still have no memo DTO and get no memo chip, so they keep the
    // defensive map rather than a value the server rejects.
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
    // P0-07: `committee` is in AlertMemoAlertInput and buildClaims uses it, but this
    // mapper never set it — so every hearing memo lost the committee.
    committee: hearing?.committeeId ?? null,
    hearingTitle: hearing?.title ?? null,
    quotes: quotes.length ? quotes : undefined,
    url: bill?.url ?? pe?.href ?? null,
    matchedTags: tags.length ? tags : undefined,
    ...(pe
      ? {
          programElement: {
            peCode: pe.peCode,
            title: pe.title,
            fiscalYear: pe.fiscalYear,
            deltaType: pe.deltaType,
            deltaTypeLabel: pe.deltaTypeLabel,
            fromRef: pe.fromRef,
            toRef: pe.toRef,
            amountFromMillions: pe.amountFromMillions,
            amountToMillions: pe.amountToMillions,
            deltaMillions: pe.deltaMillions,
            deltaPct: pe.deltaPct,
            href: pe.href,
          },
        }
      : {}),
  };
}

/**
 * The district-brief generator's DTO has the same shape as the memo's (Phase 1 M1.5) but
 * has NOT been widened for program_element — sending it sourceType:'program_element'
 * would 400 on its @IsIn. This used to be a bare alias of feedItemToMemoAlert, so
 * widening the memo mapper for PE silently armed that 400. `recommendedActionsFor` does
 * not offer district_brief for a PE alert, so the path is not reachable from the UI
 * today; it is mapped defensively anyway rather than left as a trap.
 */
export function feedItemToDistrictBriefAlert(item: FeedItem): AlertMemoAlertInput {
  const a = feedItemToMemoAlert(item);
  return a.sourceType === 'program_element'
    ? { ...a, sourceType: 'bill', programElement: undefined }
    : a;
}

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
  sources: AlertMemoSource[];
  document: { attachmentId: string; fileName: string } | null;
  usedTenantKey: boolean;
  model: string;
  lowConfidence: boolean;
  memoryFilesUsed: string[];
  /**
   * c-8: the server has ALWAYS returned `held` (district-brief.service.ts:348) but the
   * web type never declared it, so a governed hold rendered as "auto-file to Documents
   * failed" — a governance state mislabeled as a bug. reviewRequestId/heldReason are
   * returned as of Gate C. All three optional so an older apps/api degrades cleanly.
   */
  held?: boolean;
  reviewRequestId?: string | null;
  heldReason?: string;
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
      /** REQUIRED (P0-01): the alert this memo came from — the review-hold guard keys on it. */
      alertId: string;
      actionDate?: string;
      replaceAttachmentId?: string;
    }) =>
      (
        await api.post<{
          document: { attachmentId: string; fileName: string } | null;
          title: string;
        }>(`/api/intelligence/clients/${encodeURIComponent(input.clientId)}/alert-memo/save`, {
          // Pre-existing defect (P0-01, c-2): `input` also carries `clientId`,
          // which SaveAlertMemoDto does not whitelist — the global
          // ValidationPipe's forbidNonWhitelisted would 400 every save if it
          // were sent verbatim. Send an explicit body instead.
          title: input.title,
          markdown: input.markdown,
          clientName: input.clientName,
          alertId: input.alertId,
          actionDate: input.actionDate,
          replaceAttachmentId: input.replaceAttachmentId,
        })
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
