import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SourceVerification } from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import { markdownishToHtml } from '../../engagement/outreach/v2/richtext.js';
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

/** §4.5: agency rulemaking facts, normalized by intel-api from the flat rule writer. */
export interface AlertMemoRegulation {
  ruleTitle?: string | null;
  agency?: string | null;
  ruleType?: string | null;
  commentEndDate?: string | null;
  effectiveDate?: string | null;
  docketId?: string | null;
  url?: string | null;
}

/** §4.5: state cutoff/crossover context, from the normalized evidence's `extra`. */
export interface AlertMemoDeadline {
  cutoffType?: string | null;
  cutoffDate?: string | null;
  daysUntil?: number | null;
}

export interface AlertMemoAlertInput {
  alertId: string;
  sourceType: 'bill' | 'hearing' | 'combined' | 'program_element' | 'state_bill' | 'regulation';
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
  jurisdiction?: string | null;
  /** Gate L (HP-03) followup: the state legislative session's display name
   *  (e.g. "2026 Regular Session"). Only ever set for sourceType='state_bill'. */
  session?: string | null;
  deadline?: AlertMemoDeadline | null;
  regulation?: AlertMemoRegulation;
}

/** §4.6: a cited source, with when it was pulled and how well it is attested. */
export interface AlertMemoSource {
  claimId: string;
  label: string;
  url?: string | null;
  retrievedAt?: string;
  verification?: SourceVerification;
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
  /** §4.7: paragraphs the entailment gate judged unsupported. Under shadow they are still
   *  in the memo and this is what WOULD have been dropped; under enforce they are gone. */
  entailmentDropped?: Array<{ heading: string; text: string; reason: string }>;
  held: boolean;
  reviewRequestId: string | null;
  heldReason: string;
  /** Gate I (CG-01): round-trip this on save so the server-owned-record lock can
   *  fire. Optional so a not-yet-deployed apps/api degrades cleanly. */
  generationId?: string | null;
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
  // §4.5: intel-api normalizes the flat rule writer into evidence.regulation, and the
  // state-deadline emitter's cutoff fields ride in evidence.extra.
  const reg = item.evidence?.regulation as AlertMemoRegulation | undefined;
  const extra = item.evidence?.extra as
    | { cutoffType?: string | null; cutoffDate?: string | null; daysUntil?: number | null }
    | undefined;
  const deadline =
    extra && (extra.cutoffType || extra.cutoffDate || extra.daysUntil != null)
      ? {
          cutoffType: extra.cutoffType ?? null,
          cutoffDate: extra.cutoffDate ?? null,
          daysUntil: extra.daysUntil ?? null,
        }
      : null;
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
    // P0-08 / §4.5: EVERY source type is now a first-class memo source — apps/api's
    // @IsIn accepts all six and each has its own prompt, section order, claim builder,
    // and scaffold. Sending a state bill or a rulemaking as 'bill' (as this used to)
    // dropped every state deadline and every regulatory date, which was the bug. No
    // defensive downgrade remains here; see feedItemToDistrictBriefAlert, whose DTO was
    // NOT widened and therefore still downgrades.
    sourceType: item.sourceType,
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
    url: bill?.url ?? pe?.href ?? reg?.url ?? null,
    matchedTags: tags.length ? tags : undefined,
    ...(item.evidence?.provenance?.jurisdiction
      ? { jurisdiction: item.evidence.provenance.jurisdiction }
      : {}),
    ...(item.evidence?.provenance?.session ? { session: item.evidence.provenance.session } : {}),
    ...(deadline ? { deadline } : {}),
    ...(reg
      ? {
          regulation: {
            ruleTitle: reg.ruleTitle,
            agency: reg.agency,
            ruleType: reg.ruleType,
            commentEndDate: reg.commentEndDate,
            effectiveDate: reg.effectiveDate,
            docketId: reg.docketId,
            url: reg.url,
          },
        }
      : {}),
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
 * The district-brief generator's DTO has the same shape as the memo's (Phase 1 M1.5).
 * HP-03 (Gate L phase a) widened its @IsIn to also accept state_bill —
 * district-brief.controller.ts:30 now accepts bill | hearing | combined | state_bill,
 * so a state bill's jurisdiction/deadline facts reach buildClaims instead of being
 * stripped here. program_element and regulation are still NOT accepted (a district
 * brief for either stays out of HP-03's scope) and are still downgraded below.
 *
 * This used to be a bare ALIAS of feedItemToMemoAlert, which made it a live trap: every
 * time the memo mapper learned a new sourceType, this surface silently started sending a
 * value its own DTO rejects. The source-specific blocks for what's still rejected are
 * stripped too: the district-brief DTO does not whitelist them, and forbidNonWhitelisted
 * would 400 on the extra keys even with an accepted sourceType.
 */
const DISTRICT_BRIEF_SOURCE_TYPES = new Set(['bill', 'hearing', 'combined', 'state_bill']);

export function feedItemToDistrictBriefAlert(item: FeedItem): AlertMemoAlertInput {
  const a = feedItemToMemoAlert(item);
  if (DISTRICT_BRIEF_SOURCE_TYPES.has(a.sourceType)) return a;
  return {
    ...a,
    sourceType: 'bill',
    programElement: undefined,
    regulation: undefined,
    deadline: undefined,
    jurisdiction: undefined,
    session: undefined,
  };
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
      /** Gate I (CG-01): round-tripped from AlertMemoResult.generationId so
       *  saveEdited's server-owned-record lock can fire. Optional — omitting it
       *  (a stale bundle, or a loaded-not-regenerated memo with no known id)
       *  falls back to the pre-Gate-I compatibility checks. */
      generationId?: string | null;
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
          generationId: input.generationId ?? undefined,
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

/** The saved memo-link row for an alert, if one exists — read-only, no generation. */
export interface MemoLinkRecord {
  documentAttachmentId: string | null;
  title: string | null;
  /** The persisted markdown (Gate H a-5). Null for a memo drafted before this shipped. */
  text: string | null;
}

export function useGetMemoLink() {
  const api = useApi();
  return useMutation({
    mutationFn: async (input: { clientId: string; alertId: string }) =>
      (
        await api.get<MemoLinkRecord | null>(
          `/intel-api/clients/${encodeURIComponent(input.clientId)}/alerts/${encodeURIComponent(input.alertId)}/memo-link`,
        )
      ).data,
  });
}

/**
 * RB-04 / Gate H a-1: "Edit in Workspace" on an alert that already has a memo —
 * NO generation, NO replacement. Reads back the content already saved (a-5) and
 * opens it as an editable Workspace draft directly; never calls the generate
 * endpoint, never sends a replaceAttachmentId, never touches the filed
 * .docx/EngagementAttachment at all.
 */
export function useEditMemoInWorkspace() {
  const api = useApi();
  const getMemoLink = useGetMemoLink();
  return useMutation({
    mutationFn: async (input: {
      clientId: string;
      alertId: string;
      clientName: string;
      fallbackTitle: string;
    }) => {
      const memo = await getMemoLink.mutateAsync({
        clientId: input.clientId,
        alertId: input.alertId,
      });
      if (!memo?.text) {
        // a-4: surface the inconsistent state rather than silently opening an
        // empty draft or falling back to generating a replacement.
        throw new Error(
          'No saved memo content on record for this alert — use Redraft memo instead.',
        );
      }
      const title = memo.title || input.fallbackTitle;
      const created = await api.post<{ id: string }>('/workspace-api/drafts', {
        docTitle: title,
        client: input.clientName,
      });
      const draftId = created.data.id;
      await api.patch(`/workspace-api/drafts/${encodeURIComponent(draftId)}`, {
        config: { sections: ['Memo'], sectionContent: { Memo: markdownishToHtml(memo.text) } },
      });
      return draftId;
    },
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

// ── P2-04 (Gate D phase e): per-user alert work state ────────────────────────

export type WorkStateValue =
  | 'new'
  | 'in_review'
  | 'assigned'
  | 'actioned'
  | 'snoozed'
  | 'dismissed';

/** Mirrors intel-api's BULK_MAX. The web chunks above this and REPORTS it. */
export const WORK_STATE_BULK_MAX = 200;

export interface WorkStatePatchInput {
  state?: WorkStateValue;
  assignedTo?: string | null;
  snoozedUntil?: string | null;
  note?: string | null;
}

/**
 * Set THIS user's triage state on one alert. Idempotent server-side (upsert on
 * (alertId, userId)), so a double-click cannot create a second row.
 *
 * P2-06: no toast here. The caller reports success from `onSuccess` and shows a
 * pending state meanwhile — never fire-and-toast.
 */
export function useSetWorkState() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: { clientId: string; alertId: string } & WorkStatePatchInput,
    ) => {
      const { clientId, alertId, ...patch } = input;
      return (
        await api.post(
          `/intel-api/clients/${encodeURIComponent(clientId)}/alerts/${encodeURIComponent(alertId)}/work-state`,
          patch,
        )
      ).data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['intel-feed'] }),
  });
}

/**
 * Bulk triage. Chunks at WORK_STATE_BULK_MAX and returns per-chunk outcomes so
 * the caller can report PARTIAL failure — never a blanket success (P2-06).
 */
export function useBulkWorkState() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: { clientId: string; alertIds: string[] } & WorkStatePatchInput,
    ): Promise<{ ok: number; failed: number; total: number }> => {
      const { clientId, alertIds, ...patch } = input;
      const chunks: string[][] = [];
      for (let i = 0; i < alertIds.length; i += WORK_STATE_BULK_MAX) {
        chunks.push(alertIds.slice(i, i + WORK_STATE_BULK_MAX));
      }
      const results = await Promise.allSettled(
        chunks.map((ids) =>
          api.post<{ updated: number }>(
            `/intel-api/clients/${encodeURIComponent(clientId)}/alerts/work-state/bulk`,
            { alertIds: ids, ...patch },
          ),
        ),
      );
      let ok = 0;
      let failed = 0;
      results.forEach((r, i) => {
        const size = chunks[i]!.length;
        if (r.status === 'fulfilled') ok += r.value.data?.updated ?? size;
        else failed += size;
      });
      return { ok, failed, total: alertIds.length };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['intel-feed'] }),
  });
}
