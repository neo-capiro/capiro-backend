// New Outreach Wizard (v2)
//
// Drop-in replacement for the older OutreachWizard, matching the design
// mockup at C:\Users\neoma\Downloads\capiro redesign\src\engagement\outreach.jsx
//
// Architecture: a thin shell that drives a left-rail step list and a body
// pane. The two genuinely new steps (Direction + Context Builder) live in
// their own files; the rest are minimal screens that delegate the heavy
// work to existing API endpoints under /api/engagement/outreach.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUser } from '@clerk/clerk-react';
import { App, Button, Form, Input, Modal, Select, Skeleton, Space, Switch, Tag, Typography } from 'antd';
import {
  ArrowRightOutlined,
  CheckCircleFilled,
  CheckOutlined,
  EyeOutlined,
  PlusOutlined,
  SaveOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { useApi } from '../../../../lib/use-api.js';
import { useMe } from '../../../../lib/me.js';
import type { Client } from '../../../clients/clientTypes.js';
import type { OutreachRecipient, OutreachRecord } from '../../OutreachView.js';
import { StepCampaignSetup } from './StepCampaignSetup.js';
import { StepDirectionLanding } from './StepDirectionLanding.js';
import { StepContext } from './StepContext.js';
import { StepRecipientsSelect } from './StepRecipientsSelect.js';
import { StepGenerate } from './StepGenerate.js';
import {
  expandContextItemScopes,
  flattenTargets,
  individualTarget,
  sanitizeTargets,
} from './targets.js';
import {
  buildGenerationModel,
  genInputSignature,
  projectDraftsForSend,
  type GenSlot,
} from './generation.js';
import { htmlToPlainText, markdownishToHtml, sanitizeHtml } from './richtext.js';
import {
  INITIAL_V2_STATE,
  WIZARD_STEPS,
  recipientKey,
  type ContextKind,
  type ContextPoolItem,
  type WizardV2State,
} from './types.js';
import './outreach.css';

interface Props {
  clients: Client[];
  selectedClientId: string | null;
  aiConfigured: boolean;
  emailConnected: boolean;
  sendFrom: string | null;
  onCancel: () => void;
  onComplete: () => void;
  /**
   * When reopening a saved draft, the already-fetched record. The wizard
   * hydrates its state from this once (guarded by a ref) so the user resumes
   * where they left off instead of restarting at step 1.
   */
  initialRecord?: OutreachRecord | null;
  /**
   * The persisted record id of the draft being resumed. Seeds the wizard's
   * `draftId` so subsequent "Save as draft" clicks PATCH the same record
   * rather than creating duplicates.
   */
  initialDraftId?: string | null;
}

interface InsightsResponse {
  clientName?: string | null;
  recentBills?: Array<{
    id: string;
    billNumber: string;
    title: string;
    policyArea: string | null;
    status: string | null;
    latestAction: string | null;
  }>;
  clientLdaHistory?: Array<{ year: number; filingCount: number; issueAreas: string[] }>;
  // Client-profile intelligence the endpoint already returns; surfaced in the
  // Intel tab so it isn't empty when the client has no LDA filings.
  surgingIssues?: Array<{ code: string; name: string; surgePct: number | null }>;
  trendingTopics?: Array<{ word: string; growthPct: number | null }>;
  clientSpending?: { name?: string | null; total?: number | null } | null;
  topAgencies?: Array<{ name?: string | null; total?: number | null }>;
}

// Tenant-wide context library (GET /api/engagement/outreach/context-library):
// docs/notes, debriefs, preps for ALL clients, each tagged with its client so
// the Build Context tabs group by client. No recipient/client filtering.
interface ContextLibraryItem {
  id: string;
  clientId: string | null;
  clientName: string;
  title: string;
  sub?: string;
  body?: string;
  tag?: string;
  date?: string;
}
interface ContextLibraryResponse {
  documents: ContextLibraryItem[];
  debriefs: ContextLibraryItem[];
  preps: ContextLibraryItem[];
}

// Client documents for the Generate step's email-attachment picker (attach a
// client's files to the outbound email) — distinct from the context pool.
interface AttachmentItem {
  id: string;
  fileName: string;
  contentType: string;
}
interface AttachmentsResponse {
  items: AttachmentItem[];
}

interface MailThreadsResponse {
  items?: Array<{
    id: string;
    subject: string;
    snippet?: string | null;
    lastMessageAt?: string | null;
    clientId?: string | null;
    participants?: Array<{ email?: string | null; name?: string | null }>;
  }>;
}


/** Pull a human-readable message out of an axios-style error, if present. */
function apiErrorMessage(err: unknown): string | null {
  const resp = (err as { response?: { data?: { message?: unknown } } })?.response;
  const msg = resp?.data?.message;
  if (typeof msg === 'string') return msg;
  if (Array.isArray(msg) && typeof msg[0] === 'string') return msg[0];
  return null;
}

export function NewOutreachWizard({
  clients,
  selectedClientId,
  aiConfigured,
  emailConnected,
  sendFrom,
  onCancel,
  onComplete,
  initialRecord,
  initialDraftId,
}: Props) {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { user } = useUser();
  const senderName =
    user?.fullName ||
    [user?.firstName, user?.lastName].filter(Boolean).join(' ') ||
    user?.primaryEmailAddress?.emailAddress ||
    'there';

  const [stepIdx, setStepIdx] = useState(0);
  const [state, setState] = useState<WizardV2State>({
    ...INITIAL_V2_STATE,
    clientId: selectedClientId,
  });
  // Persisted draft record id (set after first Save as draft, reused on
  // subsequent saves so we PATCH instead of creating duplicates). When
  // resuming a saved draft this is seeded from the loaded record so the very
  // first save in the reopened session PATCHes rather than duplicating.
  const [draftId, setDraftId] = useState<string | null>(initialDraftId ?? null);
  // Guards the one-time hydration from a reopened draft (see effect below) so
  // it never clobbers in-progress edits on a re-render or refetch.
  const hydratedRef = useRef(false);
  // Confirmation shown after a real send completes.
  const [sentResult, setSentResult] = useState<{ sent: number; failed: number } | null>(null);
  // Recipient key currently being (re)generated individually, if any.
  const [generatingKey, setGeneratingKey] = useState<string | null>(null);

  // Email signature: the sender's saved-in-Settings default + whether one
  // exists. `appendSigOverride` is the per-campaign choice (null = follow the
  // user's default); the effective value is what we send to the API.
  const me = useMe();
  const signatureDefault = me.data?.user.emailSignatureEnabled ?? false;
  const hasSignature = me.data?.user.hasEmailSignature ?? false;
  const [appendSigOverride, setAppendSigOverride] = useState<boolean | null>(null);
  const appendSignature = appendSigOverride ?? signatureDefault;

  // WIZARD_STEPS is readonly + non-empty, but TS's noUncheckedIndexedAccess
  // narrows the indexed read to `T | undefined`. The clamp on stepIdx
  // guarantees a value, so a fallback keeps the type system happy without
  // bleeding nullability into every downstream usage.
  const step = WIZARD_STEPS[stepIdx] ?? WIZARD_STEPS[0]!;
  const next = () => setStepIdx((i) => Math.min(i + 1, WIZARD_STEPS.length - 1));
  const back = () => setStepIdx((i) => Math.max(i - 1, 0));
  // Leaving the Direction landing. Outreach 2.0 has exactly ONE campaign
  // type — the on-behalf/to-clients fork is gone as a product concept. The
  // legacy `direction` value survives only as a compat shim because the
  // not-yet-rebuilt steps (Setup/Recipients) and the generate payload still
  // branch on it; it gets deleted as each of those steps is rebuilt.
  const startOutreach = () => {
    setState((p) => (p.direction ? p : { ...p, direction: 'on-behalf' }));
    next();
  };

  // ---- Resume a saved draft ----
  // When OutreachView reopens a draft it passes the already-fetched record in.
  // Map it back into wizard state exactly inverse to saveDraftMutation below,
  // so subject/body/recipients/title/tone/template/context and the step all
  // come back. Runs once (hydratedRef) so it can't stomp on edits made after
  // the first paint, even if the record query refetches.
  useEffect(() => {
    if (hydratedRef.current) return;
    if (!initialRecord) return;
    hydratedRef.current = true;

    const record = initialRecord;
    const metadata = (record.metadata ?? {}) as Record<string, unknown>;

    // Per-recipient drafts were saved under metadata.perRecipientEmails as
    // [{ recipientId, subject, body }] — the same array buildDrafts() emits.
    const perRecipient = Array.isArray(metadata.perRecipientEmails)
      ? (metadata.perRecipientEmails as Array<{
          recipientId?: unknown;
          subject?: unknown;
          body?: unknown;
        }>)
      : [];
    // Prefer the lossless per-target map (keyed by GenerationTargetKey) saved
    // by the v2 Generate step; fall back to the flat per-recipient projection
    // (older drafts, keyed by recipientId) otherwise.
    const rawByKey =
      metadata.generatedByKey && typeof metadata.generatedByKey === 'object'
        ? (metadata.generatedByKey as WizardV2State['generatedEmails'])
        : null;
    // Only trust the map if its keys are GenerationTargetKeys (v2 saves). A
    // legacy/recipientId-keyed map would miss every lookup and blank the UI, so
    // fall through to the flat per-recipient projection in that case.
    const byKey =
      rawByKey && Object.keys(rawByKey).some((k) => /^(individual:|list:|group:)/.test(k))
        ? rawByKey
        : null;
    const generatedEmails: WizardV2State['generatedEmails'] = byKey ? { ...byKey } : {};
    if (!byKey) {
      for (const d of perRecipient) {
        if (typeof d.recipientId !== 'string') continue;
        generatedEmails[d.recipientId] = {
          subject: typeof d.subject === 'string' ? d.subject : '',
          body: typeof d.body === 'string' ? d.body : '',
          status: 'ready',
        };
      }
      // Fallback: if no per-recipient map was saved (older save), seed the first
      // recipient from the top-level subject/body so the draft isn't blank.
      if (Object.keys(generatedEmails).length === 0 && (record.subject || record.body)) {
        const firstRecipient = Array.isArray(record.recipients) ? record.recipients[0] : undefined;
        if (firstRecipient) {
          generatedEmails[recipientKey(firstRecipient)] = {
            subject: record.subject ?? '',
            body: record.body ?? '',
            status: 'ready',
          };
        }
      }
    }

    // direction is persisted inside metadata (the API merges it there).
    const rawDirection = metadata.direction;
    const direction: WizardV2State['direction'] =
      rawDirection === 'on-behalf' || rawDirection === 'to-clients' ? rawDirection : null;

    const rawTone = metadata.tone;
    const tone: WizardV2State['tone'] =
      rawTone === 'Professional' ||
      rawTone === 'Friendly' ||
      rawTone === 'Formal' ||
      rawTone === 'Concise'
        ? rawTone
        : INITIAL_V2_STATE.tone;

    // Rich v2 context items are round-tripped losslessly under
    // metadata.contextItems (the top-level contextPool the API also stores is
    // a lossy projection used for generation, not for the wizard UI).
    const contextItems = Array.isArray(metadata.contextItems)
      ? (metadata.contextItems as WizardV2State['contextItems'])
      : [];

    const attachmentIds = Array.isArray(metadata.attachmentIds)
      ? (metadata.attachmentIds as unknown[]).filter((a): a is string => typeof a === 'string')
      : [];

    // Outreach 2.0 targets round-trip via metadata (saved alongside the flat
    // recipients projection), normalized defensively so a malformed or
    // cross-version entry degrades instead of crashing the resume. Drafts
    // saved before the target model (or whose targets don't survive
    // sanitizing) wrap their flat recipients as individual targets.
    const targetsFromMetadata = sanitizeTargets(metadata.targets);
    const savedTargets = targetsFromMetadata.length
      ? targetsFromMetadata
      : Array.isArray(record.recipients)
        ? record.recipients.map((r) => individualTarget(r))
        : [];

    setState((prev) => ({
      ...prev,
      direction,
      clientId: record.clientId ?? prev.clientId,
      campaignName: record.title ?? prev.campaignName,
      targets: savedTargets,
      recipients: savedTargets.length
        ? flattenTargets(savedTargets)
        : Array.isArray(record.recipients)
          ? record.recipients
          : prev.recipients,
      contextItems,
      templateId: typeof metadata.templateId === 'string' ? metadata.templateId : prev.templateId,
      tone,
      generatedEmails:
        Object.keys(generatedEmails).length > 0 ? generatedEmails : prev.generatedEmails,
      attachmentIds: attachmentIds.length > 0 ? attachmentIds : prev.attachmentIds,
      // Stamp the restored context signature so resumed drafts aren't instantly
      // flagged stale (they were generated against this exact context).
      generatedInputSig:
        Object.keys(generatedEmails).length > 0
          ? genInputSignature({
              contextItems,
              templateId:
                typeof metadata.templateId === 'string' ? metadata.templateId : prev.templateId,
              tone,
              direction,
            })
          : prev.generatedInputSig,
    }));

    // Resume step: prefer the step *id* persisted in metadata.lastStepId — it's
    // stable when the step list is reordered or resized (e.g. removing the
    // standalone Template step), so a draft always resumes on the same screen.
    // Fall back to the numeric lastStep ordinal (top-level column, then
    // metadata.lastStep) for drafts written before lastStepId existed. Both are
    // 1-based; stepIdx is 0-based. Clamp so a bad value can't push past the last
    // step.
    const lastStepId = typeof metadata.lastStepId === 'string' ? metadata.lastStepId : undefined;
    const idxFromId = lastStepId ? WIZARD_STEPS.findIndex((s) => s.id === lastStepId) : -1;
    if (idxFromId >= 0) {
      setStepIdx(idxFromId);
    } else {
      const metadataStep = typeof metadata.lastStep === 'number' ? metadata.lastStep : undefined;
      const resumeStep =
        record.lastStep && record.lastStep > 1
          ? record.lastStep
          : (metadataStep ?? record.lastStep);
      if (resumeStep && resumeStep > 1) {
        setStepIdx(Math.min(resumeStep - 1, WIZARD_STEPS.length - 1));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRecord]);

  // ---- Context pool ----
  // The Context Builder displays a multi-tab catalog (bills/intel/emails/
  // meetings/notes). The backend has these split across three existing
  // endpoints rather than a single context-pool route, so we fan out from
  // the wizard and bucket the results client-side. Each source is loaded
  // independently so a 404 on one doesn't blank the whole pool.
  const insightsQuery = useQuery<InsightsResponse>({
    enabled: step.id === 'context',
    queryKey: ['outreach-insights', state.clientId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (state.clientId) params.set('clientId', state.clientId);
      const res = await api.get<InsightsResponse>(`/api/engagement/outreach/insights?${params}`);
      return res.data;
    },
    retry: false,
  });

  // Emails of the chosen recipients. Passed to the meetings/mail queries so the
  // context pool also surfaces past interactions with the people being
  // contacted — not just the client's stored contacts, which are often sparse.
  const recipientEmailsParam = useMemo(
    () =>
      Array.from(
        new Set(
          state.recipients
            .map((r) => r.email?.trim().toLowerCase())
            .filter((e): e is string => Boolean(e)),
        ),
      ).join(','),
    [state.recipients],
  );

  // Docs/notes, debriefs, and preps for the Build Context step come from ONE
  // tenant-wide library, grouped by client — NOT filtered by the campaign's
  // client or recipients. (Previously these were client/recipient-gated, which
  // left the tabs empty for no-single-client or congressional campaigns.)
  const contextLibraryQuery = useQuery<ContextLibraryResponse>({
    enabled: step.id === 'context',
    queryKey: ['outreach-context-library'],
    queryFn: async () =>
      (await api.get<ContextLibraryResponse>('/api/engagement/outreach/context-library')).data,
    retry: false,
    staleTime: 60_000,
  });

  // Documents for the Generate step's email-attachment picker (NOT the context
  // pool — that's the tenant-wide library above). With a client selected we show
  // that client's files; with no client we show the tenant's general (unlinked)
  // outreach attachments so a file can be reused across campaigns. Either way an
  // attachment is sent by id at send time, so a client is never required.
  const docsQuery = useQuery<AttachmentsResponse>({
    enabled: step.id === 'generate',
    queryKey: ['outreach-pool-docs', state.clientId ?? 'general'],
    queryFn: async () => {
      const res = await api.get<AttachmentItem[]>('/api/engagement/attachments', {
        params: state.clientId ? { clientId: state.clientId } : { unlinked: true },
      });
      return { items: res.data };
    },
    retry: false,
  });

  const mailQuery = useQuery<MailThreadsResponse>({
    enabled: step.id === 'context',
    queryKey: ['outreach-pool-mail', state.clientId, recipientEmailsParam],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (state.clientId) params.set('clientId', state.clientId);
      if (recipientEmailsParam) params.set('recipientEmails', recipientEmailsParam);
      // Bare MailThread[] from the API → wrap so the pool's `.items` read works
      // (same empty-tab bug as meetings).
      const res = await api.get<NonNullable<MailThreadsResponse['items']>>(
        `/api/engagement/mail-threads?${params}`,
      );
      return { items: res.data };
    },
    retry: false,
  });

  const pool: Record<ContextKind, ContextPoolItem[]> = useMemo(() => {
    const out: Record<ContextKind, ContextPoolItem[]> = {
      bill: [],
      intel: [],
      email: [],
      // `meeting` retained for back-compat with saved drafts (the Past Meetings
      // tab was replaced by Meeting preps); never populated now.
      meeting: [],
      note: [],
      document: [],
      debrief: [],
      prep: [],
    };

    // ---- Docs & Notes, Debriefs, Preps: one tenant-wide library, per client ----
    // These tabs show EVERY item across all clients (the UI groups by client) —
    // independent of the campaign's client or selected recipients. Document text
    // is still extracted lazily on select, so doc items keep their `doc-…` id and
    // arrive body-less here.
    const lib = contextLibraryQuery.data;
    const mapLib = (kind: ContextKind, items?: ContextLibraryItem[]): ContextPoolItem[] =>
      (items ?? []).map((it) => ({
        id: it.id,
        kind,
        title: it.title,
        body: it.body,
        sub: it.date ? new Date(it.date).toLocaleDateString() : it.sub,
        tag: it.tag,
        clientId: it.clientId,
        clientName: it.clientName,
        date: it.date,
      }));
    out.document = mapLib('document', lib?.documents);
    out.debrief = mapLib('debrief', lib?.debriefs);
    out.prep = mapLib('prep', lib?.preps);

    // Bills come from /outreach/insights → recentBills.
    for (const b of insightsQuery.data?.recentBills ?? []) {
      out.bill.push({
        id: `bill-${b.id}`,
        kind: 'bill',
        title: `${b.billNumber}, ${b.title}`,
        body: b.latestAction ?? undefined,
        tag: b.policyArea ?? undefined,
        sub: b.status ?? undefined,
      });
    }

    // LDA history rows surface as "intel" so the user can attach them to
    // contextualize what the client has historically lobbied on.
    for (const row of insightsQuery.data?.clientLdaHistory ?? []) {
      out.intel.push({
        id: `lda-${row.year}`,
        kind: 'intel',
        title: `${row.year} LDA filings (${row.filingCount})`,
        body: row.issueAreas.length ? `Issue areas: ${row.issueAreas.join(', ')}` : undefined,
        tag: 'LDA',
      });
    }

    // Client-profile intelligence the insights endpoint already returns:
    // surging issues, trending topics, and the client's federal-spending
    // footprint. Surfaced here so the Intel tab has content beyond LDA history.
    for (const issue of insightsQuery.data?.surgingIssues ?? []) {
      out.intel.push({
        id: `intel-issue-${issue.code}`,
        kind: 'intel',
        title: issue.name,
        body: issue.surgePct != null ? `Lobbying activity up ${issue.surgePct}%` : undefined,
        tag: 'Surging issue',
      });
    }
    for (const topic of insightsQuery.data?.trendingTopics ?? []) {
      out.intel.push({
        id: `intel-topic-${topic.word}`,
        kind: 'intel',
        title: topic.word,
        body:
          topic.growthPct != null
            ? `Trending ${topic.growthPct > 0 ? '+' : ''}${topic.growthPct}%`
            : undefined,
        tag: 'Trending',
      });
    }
    const spending = insightsQuery.data?.clientSpending;
    if (spending?.name) {
      out.intel.push({
        id: 'intel-spending',
        kind: 'intel',
        title: `Federal contracts: ${spending.name}`,
        body:
          spending.total != null
            ? `~$${(spending.total / 1_000_000).toFixed(1)}M awarded`
            : undefined,
        tag: 'Spending',
      });
    }
    for (const agency of insightsQuery.data?.topAgencies ?? []) {
      if (!agency.name) continue;
      out.intel.push({
        id: `intel-agency-${agency.name}`,
        kind: 'intel',
        title: `Top agency: ${agency.name}`,
        body: agency.total != null ? `~$${(agency.total / 1_000_000).toFixed(1)}M` : undefined,
        tag: 'Agency',
      });
    }

    // Past email threads: smart-routing via participant email.
    for (const t of mailQuery.data?.items ?? []) {
      const participantEmails = (t.participants ?? [])
        .map((p) => p.email?.toLowerCase())
        .filter((e): e is string => Boolean(e));
      out.email.push({
        id: `mail-${t.id}`,
        kind: 'email',
        title: t.subject,
        body: t.snippet ?? undefined,
        sub: t.lastMessageAt ? new Date(t.lastMessageAt).toLocaleDateString() : undefined,
        matches: [t.clientId, ...participantEmails].filter((s): s is string => Boolean(s)),
      });
    }

    return out;
  }, [insightsQuery.data, mailQuery.data, contextLibraryQuery.data]);

  const poolLoading =
    insightsQuery.isLoading || mailQuery.isLoading || contextLibraryQuery.isLoading;

  // ---- Gating ----
  const canAdvance = (): boolean => {
    switch (step.id) {
      case 'direction':
        // Informational landing page; nothing to validate.
        return true;
      case 'setup':
        // Setup now also chooses the template, so Continue needs both a
        // (required) campaign name AND a selected template.
        return state.campaignName.trim().length > 0 && !!state.templateId;
      case 'recipients':
        return state.recipients.length > 0;
      case 'context':
        return state.contextItems.length > 0;
      default:
        return true;
    }
  };

  // ---- Generate & Review (board step 10) ----
  // The entity model (individual / list-per-member / group-shared) over the
  // current targets. Drafts in state.generatedEmails are keyed by each slot's
  // GenerationTargetKey (see generation.ts).
  const genModel = useMemo(() => buildGenerationModel(state.targets), [state.targets]);

  // Signature of the generation inputs. Drafts are "stale" on Generate & Review
  // when this no longer matches the signature stamped at the last full
  // generation (state.generatedInputSig) — drives the regenerate banner.
  const genSig = useMemo(
    () =>
      genInputSignature({
        contextItems: state.contextItems,
        templateId: state.templateId,
        tone: state.tone,
        direction: state.direction,
      }),
    [state.contextItems, state.templateId, state.tone, state.direction],
  );
  const contextStale =
    Object.keys(state.generatedEmails).length > 0 &&
    state.generatedInputSig != null &&
    state.generatedInputSig !== genSig;

  // Generate (or regenerate) a set of draft slots. Non-group slots go in ONE
  // generate-batch call (one flat recipient each, mapped back by recipientId);
  // each group sends its single representative in its own call so it can carry
  // the group's member listing as additionalContext. The endpoint + response
  // shape are unchanged — we just key results by GenerationTargetKey.
  const generateMutation = useMutation({
    // markFresh + sig: when a FULL regeneration completes, stamp the
    // generation-input signature so the "context changed" banner clears.
    mutationFn: async (vars: { slots: GenSlot[]; markFresh?: boolean; sig?: string }) => {
      if (!vars.slots.length) return [];
      // GenerateBatchEmailDto whitelists only id/kind/title/body/scope/note on
      // context items; with forbidNonWhitelisted on, pool-only fields (tag/sub/
      // matches) 400 the batch. Strip to the DTO shape. List/group scopes are
      // expanded to per-member recipient keys first so the server's
      // per-recipient context routing delivers them (it matches scope to a
      // recipient key — it doesn't know about list/group scopes).
      const contextItems = expandContextItemScopes(state.contextItems, state.targets).map(
        (item) => ({
          id: item.id,
          kind: item.kind,
          title: item.title,
          body: item.body,
          scope: item.scope,
          note: item.note,
        }),
      );
      const base = {
        clientId: state.clientId ?? undefined,
        templateId: state.templateId,
        tone: state.tone,
        direction: state.direction,
        contextItems,
      };
      const post = (recipients: OutreachRecipient[], additionalContext?: string) =>
        // 175s headroom under the ~180s ALB idle timeout; the server fans out
        // one AI call per recipient.
        api
          .post<{
            results: Array<{ recipientId: string; subject: string; body: string }>;
          }>(
            '/api/engagement/outreach/generate-batch',
            { ...base, recipients, ...(additionalContext ? { additionalContext } : {}) },
            { timeout: 175_000 },
          )
          .then((r) => r.data.results);

      const tasks: Array<Promise<Array<{ genKey: string; subject: string; body: string }>>> = [];

      // Non-group slots: one batch call. The same person can back two slots
      // (e.g. a member of two lists shares a resultId), so POST each unique
      // recipient ONCE and fan the single result to every slot that shares it.
      const flatSlots = vars.slots.filter((s) => s.appliesTo !== 'group');
      if (flatSlots.length) {
        const uniqueRecipients = new Map<string, OutreachRecipient>();
        for (const s of flatSlots) {
          const r = s.genRecipients[0];
          if (r && !uniqueRecipients.has(s.resultId)) uniqueRecipients.set(s.resultId, r);
        }
        tasks.push(
          post([...uniqueRecipients.values()]).then((results) => {
            const byId = new Map(results.map((r) => [r.recipientId, r]));
            return flatSlots.map((s) => {
              const r = byId.get(s.resultId);
              return { genKey: s.genKey, subject: r?.subject ?? '', body: r?.body ?? '' };
            });
          }),
        );
      }
      // Group slots: one call each, carrying the member listing.
      for (const slot of vars.slots.filter((s) => s.appliesTo === 'group')) {
        tasks.push(
          post(slot.genRecipients, slot.additionalContext).then((results) => {
            const r = results[0];
            return [{ genKey: slot.genKey, subject: r?.subject ?? '', body: r?.body ?? '' }];
          }),
        );
      }

      return (await Promise.all(tasks)).flat();
    },
    onSuccess: (results, vars) => {
      setState((prev) => {
        const generatedEmails = { ...prev.generatedEmails };
        for (const r of results) {
          // The AI returns markdown; convert to HTML for the WYSIWYG + HTML
          // send, then SANITIZE at this trust boundary — model output is
          // attacker-influenceable (context items/recipient data) and must
          // never reach the DOM or the send pipeline unsanitized.
          generatedEmails[r.genKey] = {
            subject: r.subject,
            body: sanitizeHtml(markdownishToHtml(r.body)),
            status: 'ready',
          };
        }
        return {
          ...prev,
          generatedEmails,
          // A full regeneration reflects the current context → drafts fresh.
          ...(vars.markFresh && vars.sig != null ? { generatedInputSig: vars.sig } : {}),
        };
      });
      setGeneratingKey(null);
      if (results.length === 0) return;
      message.success(
        results.length === 1 ? 'Regenerated this email' : `Generated ${results.length} drafts`,
      );
    },
    onError: (_err, vars) => {
      // Endpoint failure: editable placeholder per slot so the reviewer still
      // sees the layout.
      setState((prev) => {
        const generatedEmails = { ...prev.generatedEmails };
        for (const s of vars.slots) {
          generatedEmails[s.genKey] = {
            subject: `[Placeholder] ${state.campaignName || 'Outreach'}`,
            body: sanitizeHtml(
              markdownishToHtml(
                `Hi there,\n\nThis is a placeholder draft because email generation failed. Edit this text directly, or try Regenerate.\n\nBest regards,\n${senderName}`,
              ),
            ),
            status: 'ready',
          };
        }
        return { ...prev, generatedEmails };
      });
      setGeneratingKey(null);
      message.warning('Generation failed; showing an editable placeholder draft.');
    },
  });

  // Flat {recipientId,subject,body} per recipient for the unchanged send-batch
  // contract — a group's shared draft fans to every member (see generation.ts).
  const buildDrafts = () => projectDraftsForSend(state.targets, state.generatedEmails);

  const sendMutation = useMutation({
    mutationFn: async (vars?: { testMode?: boolean }) => {
      const res = await api.post<{
        test: boolean;
        sent: number;
        failed: number;
        errors: Array<{ email: string; message: string }>;
        sentTo?: string;
        skippedAttachments?: string[];
      }>('/api/engagement/outreach/send-batch', {
        clientId: state.clientId ?? undefined,
        // If the user saved a draft first, flip THAT record to sent instead of
        // creating a duplicate. Absent → the API creates a fresh Sent record so
        // the send still lands in Outreach → Sent.
        engagementId: draftId ?? undefined,
        campaignName: state.campaignName?.trim() || undefined,
        recipients: state.recipients,
        drafts: buildDrafts(),
        direction: state.direction ?? undefined,
        testMode: vars?.testMode ?? false,
        attachmentIds: state.attachmentIds,
        appendSignature,
      });
      return res.data;
    },
    onSuccess: (data) => {
      if (data.skippedAttachments?.length) {
        message.warning(
          `Skipped ${data.skippedAttachments.length} attachment(s) over 3MB: ${data.skippedAttachments.join(', ')}`,
        );
      }
      if (data.test) {
        message.success(`Test email sent to ${data.sentTo ?? 'your inbox'}`);
        return;
      }
      qc.invalidateQueries({ queryKey: ['engagement-outreach'] });
      if (data.failed > 0) {
        message.warning(`Sent ${data.sent}, but ${data.failed} failed. See details below.`);
      } else {
        message.success(`Sent ${data.sent} ${data.sent === 1 ? 'email' : 'emails'}`);
      }
      // Show an explicit confirmation screen rather than closing silently.
      setSentResult({ sent: data.sent, failed: data.failed });
    },
    onError: (err) => message.error(apiErrorMessage(err) || 'Could not send emails'),
  });

  // Save the current drafts as a reusable outreach record. Available at any
  // step; first save creates the record, later saves update it in place.
  const saveDraftMutation = useMutation({
    mutationFn: async () => {
      const drafts = buildDrafts();
      const first = drafts[0];
      // The API stores `contextPool` at the top level (its own projection used
      // for Meri generation), so map the wizard's rich SelectedContextItem
      // shape onto the DTO's fields (kind→sourceType, body→summary, the per-
      // recipient `scope` → recipientIds). List/group scopes are expanded to
      // per-member recipient keys so recipientIds holds real recipient keys the
      // server can route by. The full v2 items (with the raw list:/group: scope)
      // also ride in metadata.contextItems below so the wizard restores them
      // losslessly.
      const contextPool = expandContextItemScopes(state.contextItems, state.targets).map(
        (item) => ({
          id: item.id,
          sourceType: item.kind,
          title: item.title,
          summary: item.body,
          note: item.note,
          scope: item.scope,
          recipientIds: item.scope && item.scope !== 'all' ? [item.scope] : undefined,
          matches: item.matches,
        }),
      );
      const common = {
        clientId: state.clientId ?? undefined,
        direction: state.direction ?? undefined,
        title: state.campaignName?.trim() || 'Untitled outreach',
        subject: first?.subject?.trim() || undefined,
        // Drafts are HTML now; store a plaintext summary on the record (the
        // lossless HTML map rides in metadata.generatedByKey for resume).
        body: first ? htmlToPlainText(first.body).trim() || undefined : undefined,
        recipients: state.recipients,
        // Top-level lastStep so the API persists the resume step in its own
        // column (it clamps to 1 when absent — the original Bug B). 1-based.
        lastStep: stepIdx + 1,
        // Top-level contextPool so the API stores selected context where
        // getOutreachRecord / Meri generation expect it.
        contextPool,
        metadata: {
          source: 'v2-wizard',
          // Kept in metadata too so drafts remain resumable even if the column
          // is somehow stale, and to stay backward-compatible with prior saves.
          lastStep: stepIdx + 1,
          // Resume by step *id* (stable when the step list is reordered/resized)
          // — the numeric lastStep above is only the legacy fallback. See the
          // resume effect.
          lastStepId: step.id,
          tone: state.tone,
          templateId: state.templateId,
          perRecipientEmails: drafts,
          // Lossless per-target draft map (keyed by GenerationTargetKey) so
          // resume restores list/group drafts exactly; perRecipientEmails above
          // stays as the flat projection for the record's other consumers.
          generatedByKey: state.generatedEmails,
          // Lossless copy of the rich v2 context items for wizard restore (the
          // top-level contextPool projection drops kind/body/sub/tag detail).
          contextItems: state.contextItems,
          attachmentIds: state.attachmentIds,
          // Outreach 2.0 recipient model: source of truth for the mixed
          // Individual/List/Group targets (incl. their Cc/Bcc). The flat
          // `recipients` above is its legacy projection (flattenTargets).
          targets: state.targets,
        },
      };
      if (draftId) {
        return (await api.patch<{ id: string }>(`/api/engagement/outreach/${draftId}`, common))
          .data;
      }
      return (
        await api.post<{ id: string }>('/api/engagement/outreach', { type: 'campaign', ...common })
      ).data;
    },
    onSuccess: (rec) => {
      setDraftId(rec.id);
      qc.invalidateQueries({ queryKey: ['engagement-outreach'] });
      message.success('Draft saved');
    },
    onError: () => message.error('Could not save draft'),
  });

  // Auto-generate any slots that don't yet have a draft when we land on the
  // Generate step. Generating only the MISSING slots (not gating on the whole
  // map being empty) also covers resuming a partially-generated draft and
  // adding recipients then returning to this step.
  useEffect(() => {
    if (step.id !== 'generate' || generateMutation.isPending) return;
    const missing = genModel.slots.filter((s) => !state.generatedEmails[s.genKey]);
    if (missing.length > 0)
      generateMutation.mutate({
        slots: missing,
        // First entry generates every slot → stamp the signature so the banner
        // doesn't immediately flag freshly-generated drafts as stale.
        markFresh: missing.length === genModel.slots.length,
        sig: genSig,
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.id]);

  // ---- Attachments: pick stored client docs or upload a file to send with the emails ----
  const toggleAttachment = (id: string) =>
    setState((p) => ({
      ...p,
      attachmentIds: p.attachmentIds.includes(id)
        ? p.attachmentIds.filter((a) => a !== id)
        : [...p.attachmentIds, id],
    }));

  const uploadAttachment = async (file: File) => {
    try {
      const contentType = file.type || 'application/octet-stream';
      // Attachments are tenant-scoped. With a client selected the file is filed
      // under that client (and shows in their Documents); with no client it
      // becomes a general outreach attachment (tagged source "outreach"),
      // reusable across campaigns. Either way it is sent by id at send time.
      const clientId = state.clientId ?? undefined;
      // 1) presigned S3 POST, 2) upload the bytes straight to S3, 3) confirm so
      // a row is created and the file appears in the attachment picker.
      const { data: presigned } = await api.post<{
        url: string;
        fields: Record<string, string>;
        s3Key: string;
      }>('/api/engagement/attachments/upload-url', {
        ...(clientId ? { clientId } : {}),
        fileName: file.name,
        contentType,
        contentLength: file.size,
      });
      const form = new FormData();
      Object.entries(presigned.fields).forEach(([k, v]) => form.append(k, v));
      form.append('file', file); // file must be the last field for S3 POST
      const s3Res = await fetch(presigned.url, { method: 'POST', body: form });
      if (!s3Res.ok) throw new Error(`S3 upload failed (${s3Res.status})`);
      const { data: created } = await api.post<{ id: string }>(
        '/api/engagement/attachments/confirm',
        {
          ...(clientId ? { clientId } : { source: 'outreach' }),
          fileName: file.name,
          contentType,
          s3Key: presigned.s3Key,
        },
      );
      setState((p) => ({
        ...p,
        attachmentIds: Array.from(new Set([...p.attachmentIds, created.id])),
      }));
      await docsQuery.refetch();
      message.success(`Attached ${file.name}`);
    } catch (err) {
      message.error(apiErrorMessage(err) || 'Could not upload attachment');
    }
  };

  // Inline edits to a generated draft mark it 'edited' so the user can see
  // their changes are captured; edits persist in wizard state immediately.
  const updateDraft = (key: string, patch: { subject?: string; body?: string }) =>
    setState((prev) => {
      const existing = prev.generatedEmails[key];
      if (!existing) return prev;
      return {
        ...prev,
        generatedEmails: {
          ...prev.generatedEmails,
          [key]: { ...existing, ...patch, status: 'edited' },
        },
      };
    });

  // Regenerate one draft slot (by GenerationTargetKey).
  const regenerateOne = (genKey: string) => {
    const slot = genModel.slots.find((s) => s.genKey === genKey);
    if (!slot) return;
    setGeneratingKey(genKey);
    generateMutation.mutate({ slots: [slot] });
  };
  const regenerateAll = () => {
    setGeneratingKey(null);
    // Full regen → stamp the current input signature so the banner clears.
    generateMutation.mutate({ slots: genModel.slots, markFresh: true, sig: genSig });
  };

  // Copy a list member's edited subject/body to every member of that list
  // (board 7.3 "Apply to all in list").
  const applyToList = (listAid: string, sourceKey: string) =>
    setState((prev) => {
      const src = prev.generatedEmails[sourceKey];
      if (!src) return prev;
      const generatedEmails = { ...prev.generatedEmails };
      const prefix = `list:${listAid}:`;
      for (const key of Object.keys(generatedEmails)) {
        if (key.startsWith(prefix)) {
          generatedEmails[key] = {
            ...generatedEmails[key]!,
            subject: src.subject,
            body: src.body,
            status: 'edited',
          };
        }
      }
      return { ...prev, generatedEmails };
    });

  const canSaveDraft = Object.keys(state.generatedEmails).length > 0 || state.recipients.length > 0;
  // Distinguish the real send from a test send so only the clicked button spins.
  const realSending = sendMutation.isPending && !sendMutation.variables?.testMode;
  const testSending = sendMutation.isPending && !!sendMutation.variables?.testMode;

  // ---- Render ----
  return (
    <div className="ov2-wiz">
      <aside className="ov2-wiz-rail">
        {WIZARD_STEPS.map((s, i) => (
          <div
            key={s.id}
            className={
              'ov2-wiz-step' + (i < stepIdx ? ' done' : '') + (i === stepIdx ? ' active' : '')
            }
            onClick={() => i <= stepIdx && setStepIdx(i)}
          >
            <span className="badge">
              {i < stepIdx ? <CheckOutlined style={{ fontSize: 11 }} /> : i + 1}
            </span>
            {s.label}
          </div>
        ))}
      </aside>

      <div className="ov2-wiz-body">
        <div className="ov2-wiz-pane">
          {step.id === 'direction' && <StepDirectionLanding onStart={startOutreach} />}

          {step.id === 'setup' && (
            <>
              <StepCampaignSetup
                campaignName={state.campaignName}
                onName={(n) => setState((p) => ({ ...p, campaignName: n }))}
              />
              {/* Template selection lives in Campaign Setup now (the standalone
                  Template step was removed). Continue is gated on a name AND a
                  chosen template — see canAdvance's 'setup' case. */}
              <div style={{ marginTop: 32 }}>
                <StepTemplate
                  templateId={state.templateId}
                  onChange={(id) => setState((p) => ({ ...p, templateId: id }))}
                />
              </div>
            </>
          )}

          {step.id === 'recipients' && (
            <StepRecipientsSelect
              clients={clients}
              targets={state.targets}
              onChange={(patch) =>
                setState((p) => {
                  const targets = patch.targets ?? p.targets;
                  return {
                    ...p,
                    targets,
                    // Keep the legacy flat projection in sync for the
                    // downstream steps (context/generate/send).
                    recipients: flattenTargets(targets),
                  };
                })
              }
            />
          )}

          {step.id === 'context' && (
            <StepContext
              recipients={state.recipients}
              targets={state.targets}
              selected={state.contextItems}
              onChange={(items) => setState((p) => ({ ...p, contextItems: items }))}
              pool={pool}
              loading={poolLoading}
            />
          )}

          {step.id === 'generate' && (
            <StepGenerate
              entities={genModel.entities}
              slots={genModel.slots}
              generated={state.generatedEmails}
              tone={state.tone}
              onTone={(t) => setState((p) => ({ ...p, tone: t }))}
              selectedKey={state.selectedGenerationKey}
              onSelectKey={(k) => setState((p) => ({ ...p, selectedGenerationKey: k }))}
              contextStale={contextStale}
              onRegenerateAll={regenerateAll}
              onRegenerateOne={regenerateOne}
              onEdit={updateDraft}
              onApplyToList={applyToList}
              regenerating={generateMutation.isPending}
              generatingKey={generatingKey}
              clientId={state.clientId}
              docs={docsQuery.data?.items ?? []}
              attachmentIds={state.attachmentIds}
              onToggleAttachment={toggleAttachment}
              onUploadAttachment={uploadAttachment}
            />
          )}

          {step.id === 'send' && (
            <StepSend
              recipients={state.recipients}
              sendFrom={sendFrom}
              emailConnected={emailConnected}
              hasSignature={hasSignature}
              appendSignature={appendSignature}
              onToggleSignature={setAppendSigOverride}
              onSend={() => sendMutation.mutate(undefined)}
              onTest={() => sendMutation.mutate({ testMode: true })}
              sending={realSending}
              testing={testSending}
              sentResult={sentResult}
              onDone={onComplete}
            />
          )}
        </div>

        <div className="ov2-wiz-foot">
          {/* Cancel discards the in-progress outreach (a confirmation dialog
              guards it). "Save as draft" is the explicit way to keep your
              work — available on every step. */}
          <Button onClick={onCancel}>Cancel &amp; discard</Button>
          {stepIdx > 0 && <Button onClick={back}>Back</Button>}
          {!sentResult && (
            <Button
              icon={<SaveOutlined />}
              onClick={() => saveDraftMutation.mutate()}
              loading={saveDraftMutation.isPending}
              disabled={!canSaveDraft}
            >
              Save as draft
            </Button>
          )}
          <span className="step-label">
            Step {stepIdx + 1} of {WIZARD_STEPS.length}
          </span>
          <div className="progress">
            <span style={{ width: `${((stepIdx + 1) / WIZARD_STEPS.length) * 100}%` }} />
          </div>
          {step.id === 'send' ? (
            sentResult ? (
              <Button type="primary" icon={<CheckOutlined />} onClick={onComplete}>
                Done
              </Button>
            ) : (
              <Button
                type="primary"
                icon={<SendOutlined />}
                onClick={() => sendMutation.mutate(undefined)}
                loading={realSending}
                disabled={!emailConnected}
              >
                Send all
              </Button>
            )
          ) : (
            <Button
              type="primary"
              icon={<ArrowRightOutlined />}
              iconPosition="end"
              onClick={step.id === 'direction' ? startOutreach : next}
              disabled={!canAdvance()}
            >
              {step.id === 'generate' ? 'Review Emails' : 'Continue'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// Lightweight in-file step components for the steps that don't have new
// design innovations. They borrow antd for inputs and stay deliberately
// simple, anything more complex should live in its own file.
// =====================================================================

// StepSetup (the direction-branched client picker) was removed with the
// campaign-type fork; Campaign Setup now lives in ./StepCampaignSetup.tsx.

// Shape returned by GET /api/engagement/outreach/ai-templates. The backend
// merges system templates (hardcoded in engagement.service.ts) with any
// user-created custom templates from outreach_ai_template. We render both
// in the same grid; the only visible difference is a "Custom" tag on
// user-owned ones so the user can find their own templates at a glance.
interface AiTemplate {
  id: string;
  source: 'system' | 'user';
  name: string;
  category: string;
  prompt: string;
  description: string | null;
  samplePreview: string | null;
  tone: string;
  usageCount: number;
}

function StepTemplate({
  templateId,
  onChange,
}: {
  templateId: string | null;
  onChange: (id: string) => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [previewing, setPreviewing] = useState<AiTemplate | null>(null);
  const [creatingOpen, setCreatingOpen] = useState(false);

  const templatesQuery = useQuery<AiTemplate[]>({
    queryKey: ['outreach-ai-templates'],
    queryFn: async () =>
      (await api.get<AiTemplate[]>('/api/engagement/outreach/ai-templates')).data,
  });

  const createMutation = useMutation({
    mutationFn: async (input: {
      name: string;
      category: string;
      prompt: string;
      description?: string;
      tone?: string;
    }) => (await api.post<AiTemplate>('/api/engagement/outreach/ai-templates', input)).data,
    onSuccess: (created) => {
      message.success(`Created "${created.name}"`);
      qc.invalidateQueries({ queryKey: ['outreach-ai-templates'] });
      setCreatingOpen(false);
      // Auto-select the newly created template so the user doesn't have
      // to click it again before continuing.
      onChange(created.id);
    },
    onError: () => message.error('Could not create template'),
  });

  const templates = templatesQuery.data ?? [];

  if (templatesQuery.isLoading) {
    return (
      <div>
        <h2>Choose a template</h2>
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  return (
    <div>
      <h2>Choose a template</h2>
      <div className="ov2-pane-sub">
        Templates seed the structure. Meri fills it from your context. Preview to see a sample, or
        create your own.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        {templates.map((t) => (
          <div
            key={t.id}
            onClick={() => onChange(t.id)}
            style={{
              background: 'var(--ov2-bg-surface)',
              border:
                '1.5px solid ' +
                (templateId === t.id ? 'var(--ov2-accent)' : 'var(--ov2-border-1)'),
              borderRadius: 8,
              padding: '16px 18px',
              cursor: 'pointer',
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {templateId === t.id && (
              <span
                style={{
                  position: 'absolute',
                  top: 14,
                  right: 14,
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  background: 'var(--ov2-accent)',
                  color: '#fff',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 11,
                }}
              >
                <CheckOutlined />
              </span>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{t.name}</div>
              {t.source === 'user' && (
                <Tag color="blue" style={{ fontSize: 10, lineHeight: 1.4, padding: '0 6px' }}>
                  Custom
                </Tag>
              )}
            </div>
            <div
              style={{
                fontSize: 12,
                color: 'var(--ov2-ink-2)',
                lineHeight: 1.45,
                flex: 1,
              }}
            >
              {t.description ?? 'No description'}
            </div>
            <Button
              size="small"
              type="text"
              icon={<EyeOutlined />}
              // stopPropagation so clicking Preview doesn't also select the
              // template, the user might want to compare a few before
              // committing to one.
              onClick={(e) => {
                e.stopPropagation();
                setPreviewing(t);
              }}
              style={{ alignSelf: 'flex-start', padding: 0, height: 22, fontSize: 12 }}
            >
              Preview
            </Button>
          </div>
        ))}

        {/* "Create custom" tile, same grid slot as a template card so the
            shape stays predictable as the catalog grows. */}
        <button
          type="button"
          onClick={() => setCreatingOpen(true)}
          style={{
            background: 'transparent',
            border: '1.5px dashed var(--ov2-border-1)',
            borderRadius: 8,
            padding: '16px 18px',
            cursor: 'pointer',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            color: 'var(--ov2-ink-2)',
            minHeight: 110,
            font: 'inherit',
          }}
        >
          <PlusOutlined style={{ fontSize: 18 }} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>Create custom template</span>
          <span style={{ fontSize: 11 }}>Define your own prompt</span>
        </button>
      </div>

      <PreviewTemplateModal
        template={previewing}
        onClose={() => setPreviewing(null)}
        onSelect={(id) => {
          onChange(id);
          setPreviewing(null);
        }}
      />
      <CreateTemplateModal
        open={creatingOpen}
        onCancel={() => setCreatingOpen(false)}
        onSubmit={(input) => createMutation.mutate(input)}
        submitting={createMutation.isPending}
      />
    </div>
  );
}

function PreviewTemplateModal({
  template,
  onClose,
  onSelect,
}: {
  template: AiTemplate | null;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <Modal
      open={!!template}
      onCancel={onClose}
      title={template ? `Preview · ${template.name}` : ''}
      footer={
        template
          ? [
              <Button key="close" onClick={onClose}>
                Close
              </Button>,
              <Button key="use" type="primary" onClick={() => onSelect(template.id)}>
                Use this template
              </Button>,
            ]
          : null
      }
      width={640}
      /* Cap the body and scroll inside it so a long sample output (or the full
         prompt) is entirely reachable and the footer stays pinned — previously
         a tall template pushed the bottom of the sample past the viewport with
         no way to scroll to it. */
      styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' } }}
    >
      {template && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div
              style={{
                fontSize: 11,
                color: 'var(--ov2-ink-3)',
                marginBottom: 4,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              Description
            </div>
            <div style={{ fontSize: 13.5, color: 'var(--ov2-ink-1)' }}>
              {template.description ?? 'No description provided.'}
            </div>
          </div>
          <div>
            <div
              style={{
                fontSize: 11,
                color: 'var(--ov2-ink-3)',
                marginBottom: 4,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              Sample output
            </div>
            <pre
              style={{
                fontSize: 12.5,
                lineHeight: 1.55,
                background: 'var(--ov2-bg-surface)',
                border: '1px solid var(--ov2-border-1)',
                borderRadius: 6,
                padding: 14,
                whiteSpace: 'pre-wrap',
                fontFamily: 'inherit',
                margin: 0,
              }}
            >
              {template.samplePreview ?? '(no sample preview available)'}
            </pre>
          </div>
          <div>
            <div
              style={{
                fontSize: 11,
                color: 'var(--ov2-ink-3)',
                marginBottom: 4,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              Prompt sent to Meri
            </div>
            <div
              style={{
                fontSize: 12.5,
                color: 'var(--ov2-ink-2)',
                background: 'var(--ov2-bg-surface)',
                border: '1px solid var(--ov2-border-1)',
                borderRadius: 6,
                padding: 14,
                lineHeight: 1.55,
              }}
            >
              {template.prompt}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--ov2-ink-3)' }}>
            <span>
              Tone: <b style={{ color: 'var(--ov2-ink-1)' }}>{template.tone}</b>
            </span>
            <span>
              Category: <b style={{ color: 'var(--ov2-ink-1)' }}>{template.category}</b>
            </span>
            {template.source === 'user' && (
              <span>
                Used: <b style={{ color: 'var(--ov2-ink-1)' }}>{template.usageCount}×</b>
              </span>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function CreateTemplateModal({
  open,
  onCancel,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onCancel: () => void;
  onSubmit: (input: {
    name: string;
    category: string;
    prompt: string;
    description?: string;
    tone?: string;
  }) => void;
  submitting: boolean;
}) {
  const [form] = Form.useForm();

  useEffect(() => {
    if (!open) form.resetFields();
  }, [open, form]);

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      title="Create custom template"
      okText="Create"
      okButtonProps={{ loading: submitting }}
      onOk={() => {
        form
          .validateFields()
          .then((values) => {
            onSubmit({
              name: values.name,
              category: values.category || 'general',
              prompt: values.prompt,
              description: values.description || undefined,
              tone: values.tone || 'professional',
            });
          })
          .catch(() => {
            /* validation errors render inline */
          });
      }}
      width={620}
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ tone: 'professional', category: 'general' }}
      >
        <Form.Item
          name="name"
          label="Name"
          rules={[{ required: true, message: 'Name is required' }]}
        >
          <Input placeholder="e.g. FY27 NDAA position memo" maxLength={120} />
        </Form.Item>
        <Form.Item name="description" label="Short description (optional)">
          <Input placeholder="One-line summary shown on the template card" maxLength={500} />
        </Form.Item>
        <Form.Item
          name="prompt"
          label="Prompt"
          tooltip="What Meri is told to produce. Be specific about structure, length, and tone."
          rules={[
            { required: true, message: 'Prompt is required' },
            { min: 20, message: 'Prompt should be at least 20 characters' },
          ]}
        >
          <Input.TextArea
            rows={6}
            placeholder="Write a concise email to a congressional office that... Include... Under 200 words."
            maxLength={5000}
            showCount
          />
        </Form.Item>
        <Space size={12} style={{ display: 'flex' }}>
          <Form.Item name="category" label="Category" style={{ flex: 1 }}>
            <Select
              options={[
                { value: 'general', label: 'General' },
                { value: 'meeting', label: 'Meeting' },
                { value: 'follow_up', label: 'Follow-up' },
                { value: 'policy', label: 'Policy' },
              ]}
            />
          </Form.Item>
          <Form.Item name="tone" label="Tone" style={{ flex: 1 }}>
            <Select
              options={[
                { value: 'professional', label: 'Professional' },
                { value: 'friendly', label: 'Friendly' },
                { value: 'formal', label: 'Formal' },
                { value: 'concise', label: 'Concise' },
              ]}
            />
          </Form.Item>
        </Space>
      </Form>
    </Modal>
  );
}

function StepSend({
  recipients,
  sendFrom,
  emailConnected,
  hasSignature,
  appendSignature,
  onToggleSignature,
  onSend,
  onTest,
  sending,
  testing,
  sentResult,
  onDone,
}: {
  recipients: OutreachRecipient[];
  sendFrom: string | null;
  emailConnected: boolean;
  hasSignature: boolean;
  appendSignature: boolean;
  onToggleSignature: (next: boolean) => void;
  onSend: () => void;
  onTest: () => void;
  sending: boolean;
  testing: boolean;
  sentResult: { sent: number; failed: number } | null;
  onDone: () => void;
}) {
  // Post-send confirmation screen.
  if (sentResult) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 20px' }}>
        <CheckCircleFilled style={{ fontSize: 52, color: 'var(--ov2-success, #22c55e)' }} />
        <h2 style={{ marginTop: 18 }}>
          {sentResult.failed > 0
            ? `Sent ${sentResult.sent}, ${sentResult.failed} failed`
            : `${sentResult.sent} ${sentResult.sent === 1 ? 'email' : 'emails'} sent`}
        </h2>
        <div className="ov2-pane-sub" style={{ fontSize: 13.5 }}>
          {sentResult.failed > 0
            ? 'Some emails could not be sent. Check the failed addresses and your email connection, then retry from Outreach.'
            : `Your personalized emails went out from ${sendFrom || 'your connected inbox'}.`}
        </div>
        <Space style={{ marginTop: 22 }}>
          <Button type="primary" icon={<CheckOutlined />} onClick={onDone}>
            Done
          </Button>
        </Space>
      </div>
    );
  }

  return (
    <div style={{ textAlign: 'center', padding: '40px 20px' }}>
      <h2 style={{ marginTop: 14 }}>Ready to send</h2>
      <div className="ov2-pane-sub" style={{ fontSize: 13.5 }}>
        <b style={{ color: 'var(--ov2-ink-1)' }}>{recipients.length}</b> personalized{' '}
        {recipients.length === 1 ? 'email is' : 'emails are'} queued. Capiro will send from{' '}
        <b>{sendFrom || 'your connected inbox'}</b>.
      </div>
      {!emailConnected && (
        <Typography.Paragraph type="warning" style={{ marginTop: 12 }}>
          No Microsoft connection found. Connect one in Settings → Integrations before sending.
        </Typography.Paragraph>
      )}
      {hasSignature && (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            marginTop: 16,
            padding: '9px 14px',
            border: '1px solid var(--ov2-border-1)',
            borderRadius: 8,
            background: 'var(--ov2-bg-surface-2)',
          }}
        >
          <Switch checked={appendSignature} onChange={onToggleSignature} size="small" />
          <span style={{ fontSize: 13, color: 'var(--ov2-ink-1)' }}>
            Append my email signature
          </span>
        </div>
      )}
      <Space style={{ marginTop: 20 }}>
        <Button
          icon={<EyeOutlined />}
          loading={testing && !sending}
          onClick={onTest}
          disabled={!emailConnected}
        >
          Send test email to myself
        </Button>
        <Button
          type="primary"
          icon={<SendOutlined />}
          loading={sending}
          onClick={onSend}
          disabled={!emailConnected}
        >
          Confirm Send
        </Button>
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 14 }}>
        “Send test email” delivers one copy to your own inbox so you can preview formatting before
        the real send.
      </Typography.Paragraph>
    </div>
  );
}
