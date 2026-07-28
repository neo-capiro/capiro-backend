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
import {
  Alert,
  App,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Skeleton,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
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
import { intelTrackerPaths } from '../../../clients/tracker/intel-tracker-api.js';
import type { Client } from '../../../clients/clientTypes.js';
import type { OutreachRecipient, OutreachRecord } from '../../OutreachView.js';
import { StepCampaignSetup } from './StepCampaignSetup.js';
import { StepDirectionLanding } from './StepDirectionLanding.js';
import { StepContext } from './StepContext.js';
import { peToPoolItem } from './pe-context.js';
import type { ProgramElementListItem } from '../../../program-element/types.js';
import { StepRecipientsSelect } from './StepRecipientsSelect.js';
import { StepGenerate } from './StepGenerate.js';
import {
  expandContextItemScopes,
  flattenTargets,
  individualTarget,
  sanitizeTargets,
} from './targets.js';
import {
  appendDraftHistory,
  buildGenerateTasks,
  buildGenerationModel,
  computeAffectedGenerationKeys,
  genInputSignature,
  partitionGenerationResults,
  projectDraftsForSend,
  revertDraftHistory,
  type BatchDraftResult,
  type GenerationSnapshot,
  type GenSlot,
} from './generation.js';
import {
  buildResultIdToGenKeys,
  cancelOutreachJob,
  extractJobCandidates,
  jobItemsProgress,
  mapJobItemsToDraftPatch,
  retryOutreachJobItem,
  submitOutreachGenerateJob,
  useOutreachJobs,
} from './jobs.js';
import { htmlToPlainText, markdownishToHtml, sanitizeHtml } from './richtext.js';
import {
  DRAFT_AUTOSAVE_DEBOUNCE_MS,
  applyNewVersion,
  applyVersionConflict,
  canEnterSendStep,
  isDraftSendable,
  markDirty,
  type DraftCandidate,
  type DraftVersionRef,
  type VersionedBatchResult,
} from './versioned-drafts.js';
import {
  DELIVERY_STATUS_COPY,
  attachmentPreflight,
  cancelSendIntent,
  createSendIntent,
  ensureRequestKey,
  ensureTestRequestKey,
  projectVersionIdsForSend,
  retryableGenKeys,
  scopeUnitsToGenKeys,
  showRetryControl,
  summarizeIntent,
  useSendIntent,
  type SendIntentView,
} from './send-intent.js';
import { computeSendPreflight, type SendPreflightResult } from './send-preflight.js';
import {
  INITIAL_V2_STATE,
  WIZARD_STEPS,
  normalizeTone,
  recipientKey,
  toContextItemPayload,
  type ContextKind,
  type ContextPoolItem,
  type GeneratedDraft,
  type GenerationSourceManifest,
  type WizardV2State,
} from './types.js';
import './outreach.css';

/** A connected inbox the user can send outreach from (Outlook or Gmail). */
export interface OutreachSenderInbox {
  id: string;
  provider: string;
  accountEmail: string | null;
  displayName: string | null;
}

interface Props {
  clients: Client[];
  selectedClientId: string | null;
  aiConfigured: boolean;
  emailConnected: boolean;
  sendFrom: string | null;
  /** Connected inboxes the user can send from, for the Send-step mailbox picker. */
  sendableInboxes: OutreachSenderInbox[];
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

interface InsightsBillRow {
  id: string;
  billNumber: string;
  title: string;
  policyArea: string | null;
  status: string | null;
  latestAction: string | null;
}
interface InsightsResponse {
  clientName?: string | null;
  // Phase 2 §3.i — ONLY the selected client's own tracked bills. Empty when the
  // client tracks nothing; never filled with unrelated global bills.
  clientTrackedBills?: InsightsBillRow[];
  // Separate, honestly-labeled global discovery feed — always present,
  // independent of clientTrackedBills, never auto-selected as context.
  suggestedPublicDevelopments?: Array<
    InsightsBillRow & { relevanceReason: string; sourceDate: string | null }
  >;
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
  /**
   * Stored byte length. GET /attachments already returns this (the row is spread
   * whole); it was simply never declared here. Phase 0 needs it so an oversized
   * file is caught BEFORE submission rather than reported as "skipped" after the
   * emails have already gone out. Null when S3 HeadObject did not report a length.
   */
  byteSize?: number | null;
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

// Server caps generate-batch at 100 recipients (GenerateBatchEmailDto
// @ArrayMaxSize(100)). Chunk the flat fan-out to match so a large campaign
// generates across several POSTs instead of tripping the cap and 400ing.
const GEN_BATCH_MAX = 100;

/** One generated draft keyed by its GenerationTargetKey. */
interface GenDraft {
  genKey: string;
  subject: string;
  body: string;
}

/** Result of a generate mutation: succeeded drafts committed as-is, failed slot
 *  keys flagged 'error' (unsendable), plus the first failure message to surface. */
interface GenerateResult {
  succeeded: GenDraft[];
  /** Held content, PRESERVED (Phase 0 g2) — real text awaiting review. */
  held: Array<{ genKey: string; subject: string; body: string; contextNote?: string }>;
  /** genKey → the immutable server version behind it (versioned mode only). */
  refs: Map<string, DraftVersionRef>;
  /**
   * Phase 1 §3.j — genKey → Context Used manifest. Populated for held slots too:
   * a held or blocked generation is exactly when the user most needs to see which
   * source failed.
   */
  manifests: Map<string, GenerationSourceManifest>;
  failed: string[];
  errorMessage?: string;
  /**
   * Phase 2 §3.f2 — regenerations the server refused to apply directly (the
   * slot's current draft was manually authored). NEVER merged into
   * `succeeded`/`held` — a candidate genKey's current draft is left exactly
   * as it was; the compare UI decides its fate.
   */
  candidates: DraftCandidate[];
}

export function NewOutreachWizard({
  clients,
  selectedClientId,
  aiConfigured,
  emailConnected,
  sendFrom,
  sendableInboxes,
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
  /**
   * Mirror of `state` for async guards. The navigation gate runs AFTER awaiting
   * version writes, by which point the closed-over `state` is stale — reading the
   * ref is what makes "block navigation until every draft settles" actually true.
   */
  const stateRef = useRef<WizardV2State>(INITIAL_V2_STATE);
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
  // Phase 2 §3.f2/f3 — regenerations offered as candidates (server refused to
  // overwrite a manually authored current version), keyed by genKey. Ephemeral
  // UI state, not part of WizardV2State: a candidate that isn't accepted before
  // the user navigates away is simply re-offered on the next regenerate.
  const [candidates, setCandidates] = useState<Map<string, DraftCandidate>>(new Map());
  const [candidateBusyKey, setCandidateBusyKey] = useState<string | null>(null);
  // Phase 2 §3.f1 — the generation snapshot captured at the last FULL/affected
  // regeneration, for computing exactly which slots the CURRENT inputs still
  // differ from (see computeAffectedGenerationKeys). null = nothing generated
  // yet, or the campaign was resumed from a draft (no fine-grained history).
  const [lastGenerationSnapshot, setLastGenerationSnapshot] = useState<GenerationSnapshot | null>(
    null,
  );
  // Async job pipeline (W4.4): the generate-job ids currently being polled, plus
  // the set of genKeys already merged from a TERMINAL job item — so a later poll
  // never re-clobbers a draft the user has since edited. Job-mode runs only when
  // GET /me reports the feature on (env kill-switch AND per-tenant canary flag);
  // otherwise the synchronous generate-batch path is used, byte-for-byte unchanged.
  const [activeJobIds, setActiveJobIds] = useState<string[]>([]);
  const mergedGenKeysRef = useRef<Set<string>>(new Set());

  // Email signature: the sender's saved-in-Settings default + whether one
  // exists. `appendSigOverride` is the per-campaign choice (null = follow the
  // user's default); the effective value is what we send to the API.
  const me = useMe();
  const signatureDefault = me.data?.user.emailSignatureEnabled ?? false;
  const hasSignature = me.data?.user.hasEmailSignature ?? false;
  const [appendSigOverride, setAppendSigOverride] = useState<boolean | null>(null);
  const appendSignature = appendSigOverride ?? signatureDefault;

  // Async outreach job-mode is on only when GET /me says so (env AND tenant flag).
  const asyncGen = me.data?.features.outreachAsyncGen === true;
  /**
   * Phase 0 trust boundary. When true: every draft is an immutable audited server
   * version, edits POST new versions, and real sending goes through send intents.
   * When false the wizard keeps the pre-Phase-0 path byte-for-byte.
   */
  const versionedOutreach = me.data?.features.versionedOutreach === true;

  /**
   * The single in-flight ensureDraftRecord() promise (§3.g3).
   *
   * Generation fans out several POSTs concurrently, so without ONE shared awaited
   * promise each of them would race to create its own OutreachRecord and the
   * campaign would fragment across duplicates.
   */
  const ensureRecordRef = useRef<Promise<string> | null>(null);
  /** Per-artifact autosave timers, so each draft debounces independently. */
  const autosaveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  /** In-flight version writes, awaited before navigating to Send. */
  const versionWritesRef = useRef<Map<string, Promise<void>>>(new Map());
  /** Request keys minted per Send click, reused across network retries. */
  const sendRequestKeyRef = useRef<string | null>(null);
  const testRequestKeyRef = useRef<string | null>(null);

  // WIZARD_STEPS is readonly + non-empty, but TS's noUncheckedIndexedAccess
  // narrows the indexed read to `T | undefined`. The clamp on stepIdx
  // guarantees a value, so a fallback keeps the type system happy without
  // bleeding nullability into every downstream usage.
  const step = WIZARD_STEPS[stepIdx] ?? WIZARD_STEPS[0]!;
  const rawNext = () => setStepIdx((i) => Math.min(i + 1, WIZARD_STEPS.length - 1));

  /**
   * Advance a step (§3.g4/g5).
   *
   * Leaving Generate & Review flushes every pending version write and AWAITS it,
   * then refuses to continue while any draft is unsaved, awaiting verification,
   * held, unavailable or rejected. Without this a user could navigate past a held
   * draft and reach a Send step that silently excluded it.
   */
  // Keep the async-guard mirror in step with render state.
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const next = () => {
    const leavingGenerate = step.id === 'generate';
    if (!versionedOutreach || !leavingGenerate) {
      rawNext();
      return;
    }
    void (async () => {
      await flushAllDirtyDrafts();
      // Re-read from the ref-free source: setState above has settled by now
      // because flushDraftVersion awaited its own writes.
      const gate = canEnterSendStep(genModel.slots, stateRef.current.generatedEmails);
      if (!gate.ok) {
        message.warning(
          gate.dirty.length
            ? 'Still saving your edits — each edited draft has to be verified before it can be sent.'
            : `${gate.blocked.length} draft(s) are not cleared for sending yet. Resolve them in Generate & Review first.`,
        );
        return;
      }
      rawNext();
    })();
  };
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

    // Tone canonicalized to lowercase (see normalizeTone): lowercases a legacy
    // capitalized value from an old draft, else falls back to the default.
    const tone = normalizeTone(metadata.tone);

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
      // Phase 2 §3.g — resume a prior "keep all" acknowledgement verbatim; it's
      // re-validated against the CURRENT fingerprint at Send time regardless
      // (a target edited since this save invalidates it naturally).
      collisionResolution:
        metadata.collisionResolution &&
        typeof metadata.collisionResolution === 'object' &&
        typeof (metadata.collisionResolution as { fingerprint?: unknown }).fingerprint ===
          'string' &&
        Array.isArray((metadata.collisionResolution as { keepAllEmails?: unknown }).keepAllEmails)
          ? (metadata.collisionResolution as WizardV2State['collisionResolution'])
          : prev.collisionResolution,
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

  // W5.4 — seed the Program Elements Build-Context tab with the user's WATCHED PEs
  // (the `watched=true` filter resolves the caller's tenant/user automatically);
  // typing in the tab then searches the full catalog server-side.
  const peWatchlistQuery = useQuery<ProgramElementListItem[]>({
    enabled: step.id === 'context',
    queryKey: ['outreach-pool-pe-watched'],
    queryFn: async () =>
      (
        await api.get<{ data: ProgramElementListItem[] }>('/api/program-elements', {
          params: { watched: 'true', limit: 50 },
        })
      ).data.data,
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
      // State bills are search-only (no default watchlist seed), like the
      // federal bill tab's full-corpus search.
      stateBill: [],
      intel: [],
      email: [],
      // `meeting` retained for back-compat with saved drafts (the Past Meetings
      // tab was replaced by Meeting preps); never populated now.
      meeting: [],
      note: [],
      document: [],
      debrief: [],
      prep: [],
      programElement: (peWatchlistQuery.data ?? []).map(peToPoolItem),
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

    // Bills come from /outreach/insights → clientTrackedBills. Phase 2 §3.i:
    // this is ONLY the client's own tracked bills, never backfilled with global
    // activity — see discoveryBills below for the separate, labeled feed.
    for (const b of insightsQuery.data?.clientTrackedBills ?? []) {
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
  }, [insightsQuery.data, mailQuery.data, contextLibraryQuery.data, peWatchlistQuery.data]);

  // Phase 2 §3.i — general legislative activity, kept OUT of `pool.bill` and
  // rendered as its own labeled section so it can never be mistaken for
  // something selected because of this client. Never auto-added to `selected`.
  const discoveryBills: ContextPoolItem[] = useMemo(
    () =>
      (insightsQuery.data?.suggestedPublicDevelopments ?? []).map((b) => ({
        id: `bill-${b.id}`,
        kind: 'bill',
        title: `${b.billNumber}, ${b.title}`,
        body: b.latestAction ?? undefined,
        tag: b.policyArea ?? undefined,
        sub: [b.relevanceReason, b.sourceDate].filter(Boolean).join(' · '),
      })),
    [insightsQuery.data],
  );

  const poolLoading =
    insightsQuery.isLoading ||
    mailQuery.isLoading ||
    contextLibraryQuery.isLoading ||
    peWatchlistQuery.isLoading;

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

  // Shared generate-request params (client/template/tone/direction + DTO-shaped
  // context items). Used by BOTH the sync mutation and the async job submitter so
  // their request bodies never drift.
  const buildBaseParams = () => ({
    clientId: state.clientId ?? undefined,
    templateId: state.templateId,
    tone: state.tone,
    direction: state.direction,
    // Phase 1 §3.b1: IDs + the user's own words only. `title`/`body` are NOT
    // sent — the server rehydrates every server-backed source by id, and a body
    // the browser supplied could never be authoritative anyway.
    contextItems: expandContextItemScopes(state.contextItems, state.targets).map(
      toContextItemPayload,
    ),
  });

  // ── Async job pipeline (W4.4) ──────────────────────────────────────────────
  // Poll every active generate-job (2s while queued/running). This hook is always
  // mounted; with no active jobs it polls nothing. Terminal item results merge
  // into generatedEmails via the SAME shape the sync onSuccess writes, so Send /
  // Save / Improve need no job awareness.
  //
  // Phase 2 §3.f2 gap CLOSED by Phase e §e4/e5: JobItem.result now carries
  // isCandidate/baseVersion, and the merge effect below routes a candidate
  // item to the SAME `candidates` map + DraftVersionCompare UI the sync
  // generateMutation.onSuccess uses, instead of merging it into
  // generatedEmails as if it were the new current draft. See
  // extractJobCandidates (jobs.ts) and the isCandidate guard inside
  // mapJobItemsToDraftPatch, which excludes these items from `fresh` below.
  const { byJob, anyActive: jobsPolling } = useOutreachJobs(api, activeJobIds);
  const jobMarkFreshRef = useRef<{ markFresh: boolean; sig: string | null }>({
    markFresh: false,
    sig: null,
  });
  const failedPlaceholder = () => ({
    subject: `[Placeholder] ${state.campaignName || 'Outreach'}`,
    body: sanitizeHtml(
      markdownishToHtml(
        `Hi there,\n\nThis is a placeholder draft because email generation failed. Edit this text directly, or try Regenerate — it will not be sent until you do.\n\nBest regards,\n${senderName}`,
      ),
    ),
  });

  useEffect(() => {
    if (!activeJobIds.length) return;
    const items = Object.values(byJob).flatMap((j) => j.items);
    const map = buildResultIdToGenKeys(genModel.slots);
    // Merge only TERMINAL items, and only genKeys not already merged — so a later
    // poll never re-clobbers a draft the user edited after it first landed.
    const fresh = mapJobItemsToDraftPatch(items, map, failedPlaceholder).filter(
      (p) => !mergedGenKeysRef.current.has(p.genKey),
    );
    // Phase e §e5 — a candidate item is excluded from `fresh` above (see the
    // isCandidate guard in mapJobItemsToDraftPatch); offer it through the SAME
    // compare/accept UI the sync path uses instead. Guarded by the SAME
    // mergedGenKeysRef so a later poll never re-offers a candidate the user
    // already accepted or discarded via keepMineCandidate/acceptCandidate.
    const freshCandidates = extractJobCandidates(items, map, (raw) =>
      sanitizeHtml(markdownishToHtml(raw)),
    ).filter((c) => !mergedGenKeysRef.current.has(c.genKey));
    if (freshCandidates.length) {
      freshCandidates.forEach((c) => mergedGenKeysRef.current.add(c.genKey));
      setCandidates((prev) => {
        const next = new Map(prev);
        for (const c of freshCandidates) next.set(c.genKey, c);
        return next;
      });
    }
    if (fresh.length) {
      fresh.forEach((p) => mergedGenKeysRef.current.add(p.genKey));
      setState((prev) => {
        const generatedEmails = { ...prev.generatedEmails };
        for (const p of fresh) {
          const prior = generatedEmails[p.genKey];
          // Never clobber unsaved user edits (legacy 'edited' OR Phase 0 dirty).
          if (prior?.status === 'edited' || prior?.dirty) continue;
          generatedEmails[p.genKey] = {
            ...prior,
            subject: p.subject,
            body: p.body,
            status: p.status,
            // Phase 0 (g2): a HELD item keeps its real content and carries the
            // version lifecycle, so the rail shows "Pending review" over the
            // actual draft instead of a fabricated failure placeholder.
            ...(p.versionId ? { versionId: p.versionId } : {}),
            ...(p.artifactId ? { artifactId: p.artifactId } : {}),
            ...(p.version != null ? { version: p.version } : {}),
            ...(p.generationStatus
              ? { generationStatus: p.generationStatus as GeneratedDraft['generationStatus'] }
              : {}),
            ...(p.auditStatus
              ? { auditStatus: p.auditStatus as GeneratedDraft['auditStatus'] }
              : {}),
            ...(p.approvalStatus
              ? { approvalStatus: p.approvalStatus as GeneratedDraft['approvalStatus'] }
              : {}),
            ...(p.reviewRequestId ? { reviewRequestId: p.reviewRequestId } : {}),
            ...(p.contextNote ? { contextNote: p.contextNote } : {}),
            dirty: false,
            ...(p.versionId ? { sendable: p.status === 'ready' } : {}),
          };
        }
        return { ...prev, generatedEmails };
      });
    }
    // Every job settled → clear the active set, reset the merge guard, and (on a
    // clean full regen) stamp the input signature so the "context changed" banner
    // clears — mirroring the sync onSuccess.
    if (!jobsPolling) {
      const anyFailed = items.some((it) => it.status === 'failed');
      const { markFresh, sig } = jobMarkFreshRef.current;
      setActiveJobIds([]);
      mergedGenKeysRef.current = new Set();
      setGeneratingKey(null);
      if (markFresh && sig != null && !anyFailed) {
        setState((prev) => ({ ...prev, generatedInputSig: sig }));
      }
      jobMarkFreshRef.current = { markFresh: false, sig: null };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byJob, jobsPolling]);

  // Submit a bulk generation as async jobs (one per buildGenerateTasks unit); the
  // poll effect above fills drafts as items finish. Used only when asyncGen.
  const submitGenerateJobs = async (slots: GenSlot[], markFresh?: boolean, sig?: string) => {
    if (!slots.length) return;
    const base = buildBaseParams();
    const tasks = buildGenerateTasks(slots, GEN_BATCH_MAX);
    jobMarkFreshRef.current = { markFresh: markFresh ?? false, sig: sig ?? null };
    try {
      const submitted = await Promise.all(
        tasks.map((t) =>
          submitOutreachGenerateJob(api, {
            ...base,
            recipients: t.recipients,
            ...(t.additionalContext ? { additionalContext: t.additionalContext } : {}),
            ...(t.audienceKind ? { audienceKind: t.audienceKind } : {}),
          }),
        ),
      );
      setActiveJobIds((prev) => Array.from(new Set([...prev, ...submitted.map((s) => s.jobId)])));
    } catch (err) {
      message.error(apiErrorMessage(err) || 'Could not start generation.');
    }
  };

  const cancelActiveJobs = async () => {
    await Promise.all(activeJobIds.map((id) => cancelOutreachJob(api, id).catch(() => undefined)));
    // The poll observes 'canceled' → jobsPolling false → the effect clears state.
  };

  // Retry every failed generation item across the active jobs (uses the per-item
  // retry endpoint; re-arms polling + lets the retried results re-merge).
  const retryFailedJobItems = async () => {
    const map = buildResultIdToGenKeys(genModel.slots);
    const failed: Array<{ jobId: string; itemId: string; recipientKey: string }> = [];
    for (const [jobId, j] of Object.entries(byJob))
      for (const it of j.items)
        if (it.status === 'failed')
          failed.push({ jobId, itemId: it.id, recipientKey: it.recipientKey });
    if (!failed.length) return;
    await Promise.all(
      failed.map((f) =>
        retryOutreachJobItem(api, f.jobId, f.itemId).catch(() => ({ retried: false })),
      ),
    );
    for (const f of failed)
      for (const gk of map.get(f.recipientKey) ?? []) mergedGenKeysRef.current.delete(gk);
    setActiveJobIds((prev) => Array.from(new Set([...prev, ...failed.map((f) => f.jobId)])));
  };

  // Aggregate job progress for the generate-step banner (null when not in job-mode).
  const jobItemsAll = Object.values(byJob).flatMap((j) => j.items);
  const jobProgress =
    activeJobIds.length > 0
      ? jobItemsProgress(jobItemsAll, jobsPolling ? 'running' : 'complete')
      : null;

  // Generate (or regenerate) a set of draft slots. Non-group slots go in ONE
  // generate-batch call (one flat recipient each, mapped back by recipientId);
  // each group sends its single representative in its own call so it can carry
  // the group's member listing as additionalContext. The endpoint + response
  // shape are unchanged — we just key results by GenerationTargetKey.
  const generateMutation = useMutation({
    // markFresh + sig: when a FULL regeneration completes, stamp the
    // generation-input signature so the "context changed" banner clears.
    mutationFn: async (vars: {
      slots: GenSlot[];
      markFresh?: boolean;
      sig?: string;
      /**
       * "Improve" (revision) mode: edit the named draft in place per a freeform
       * instruction instead of regenerating from scratch. Always a single slot.
       */
      revise?: { genKey: string; instruction: string };
    }): Promise<GenerateResult> => {
      if (!vars.slots.length)
        return {
          succeeded: [],
          held: [],
          refs: new Map(),
          manifests: new Map(),
          candidates: [],
          failed: [],
        };
      // GenerateBatchEmailDto whitelists only id/kind/title/body/scope/note on
      // context items; with forbidNonWhitelisted on, pool-only fields (tag/sub/
      // matches) 400 the batch. Strip to the DTO shape. List/group scopes are
      // expanded to per-member recipient keys first so the server's
      // per-recipient context routing delivers them (it matches scope to a
      // recipient key — it doesn't know about list/group scopes).
      // Improve mode forwards the current (possibly hand-edited) draft + the
      // freeform instruction so the server revises in place (PromptSpec v2
      // revision mode). Only ever one slot, so top-level fields are unambiguous.
      const reviseDraft = vars.revise ? state.generatedEmails[vars.revise.genKey] : undefined;
      const base = {
        ...buildBaseParams(),
        ...(vars.revise && reviseDraft
          ? {
              existingSubject: reviseDraft.subject,
              existingBody: reviseDraft.body,
              reviseInstruction: vars.revise.instruction,
            }
          : {}),
      };
      // Phase 0 (§3.g3): the protected draft record must exist BEFORE the AI is
      // called. If this throws we never reach the provider, so nothing is spent
      // and no transient text is produced that the server could not persist.
      let recordId: string | null = null;
      if (versionedOutreach) {
        try {
          recordId = await ensureDraftRecord();
        } catch (err) {
          // Keep the server's own message. Swallowing it turned a precise
          // validation reject (e.g. "contextPool.0.title must be shorter than or
          // equal to 240 characters") into an unactionable "generation failed",
          // which is what made a 240-char cap on ONE library document look like
          // a broken AI pipeline.
          const detail = apiErrorMessage(err);
          throw new Error(
            detail
              ? `Could not create the protected draft record, so generation was not started: ${detail}`
              : 'Could not create the protected draft record; generation was not started.',
          );
        }
      }

      /**
       * Attach each recipient's generation slot key(s). One generated draft can
       * back several slots (the same person in two lists is generated ONCE by
       * design), so the keys travel as a list and the server versions each.
       */
      const withGenerationKeys = (
        recipients: OutreachRecipient[],
        chunkSlots: GenSlot[],
      ): OutreachRecipient[] => {
        if (!versionedOutreach) return recipients;
        const keysByResultId = new Map<string, string[]>();
        for (const slot of chunkSlots) {
          const list = keysByResultId.get(slot.resultId) ?? [];
          list.push(slot.genKey);
          keysByResultId.set(slot.resultId, list);
        }
        return recipients.map((r) => {
          const keys = keysByResultId.get(recipientKey(r)) ?? [];
          return keys.length
            ? ({ ...r, generationKeys: keys } as unknown as OutreachRecipient)
            : r;
        });
      };

      const post = (
        recipients: OutreachRecipient[],
        opts?: { additionalContext?: string; audienceKind?: 'group' },
      ) =>
        // 175s headroom under the ~180s ALB idle timeout; the server fans out
        // one AI call per recipient. `audienceKind: 'group'` tells the server the
        // single recipient stands in for a whole group (collective salutation, no
        // per-member tailoring).
        api
          .post<{ results: BatchDraftResult[] }>(
            '/api/engagement/outreach/generate-batch',
            {
              ...base,
              ...(recordId ? { outreachRecordId: recordId } : {}),
              recipients,
              ...(opts?.additionalContext ? { additionalContext: opts.additionalContext } : {}),
              ...(opts?.audienceKind ? { audienceKind: opts.audienceKind } : {}),
            },
            { timeout: 175_000 },
          )
          .then((r) => r.data.results);

      // Each task CATCHES its own error and returns a discriminated result, so a
      // single failing POST (429, an AI outage, a validation reject) can never
      // discard the drafts the OTHER POSTs already produced. The old code joined
      // every POST with Promise.all — one failure rejected the whole mutation and
      // marked every slot 'error', throwing away already-succeeded work.
      // A POST can now partially fail: the request returns 200, but individual
      // recipients inside it may come back status:'error'. So the ok:true variant
      // carries BOTH the succeeded drafts AND the same-batch failed genKeys; the
      // ok:false variant is a WHOLE-POST failure (429, outage, validation reject).
      // Each task CATCHES its own error and returns a discriminated result, so a
      // single failing POST can never discard the drafts the OTHER POSTs produced.
      // ok:true carries succeeded drafts AND same-batch failed genKeys; ok:false is
      // a whole-POST failure. Task list is built by the SHARED buildGenerateTasks
      // (identical to the async job path — no drift); each chunk is partitioned on
      // each item's authoritative status.
      type TaskOut =
        | {
            ok: true;
            drafts: GenDraft[];
            heldDrafts: Array<{ genKey: string; subject: string; body: string; contextNote?: string }>;
            failedGenKeys: string[];
            refs: Map<string, DraftVersionRef>;
            manifests: Map<string, GenerationSourceManifest>;
            candidates: DraftCandidate[];
          }
        | { ok: false; genKeys: string[]; message: string };
      const tasks = buildGenerateTasks(vars.slots, GEN_BATCH_MAX);
      const outs = await Promise.all(
        tasks.map(
          (t): Promise<TaskOut> =>
            post(
              withGenerationKeys(t.recipients, t.chunkSlots),
              t.additionalContext || t.audienceKind
                ? { additionalContext: t.additionalContext, audienceKind: t.audienceKind }
                : undefined,
            )
              .then((results): TaskOut => {
                const { drafts, heldDrafts, failedGenKeys, manifests } = partitionGenerationResults(
                  t.chunkSlots.map((s) => ({ genKey: s.genKey, resultId: s.resultId })),
                  results,
                );
                // Phase 0 (g2): held drafts are REAL content pending review. They
                // travel separately from failures so onSuccess can keep the text
                // and attach the version lifecycle, rather than overwriting it.
                const byRecipient = new Map(results.map((r) => [r.recipientId, r]));
                const refs = new Map<string, DraftVersionRef>();
                // Phase 2 §3.f2 — a slot whose match is a CANDIDATE never gets a
                // ref applied to its current draft: the server deliberately did
                // not advance that artifact's current version, so the wizard
                // must not either. It surfaces via `candidates` for compare/merge.
                const candidates: DraftCandidate[] = [];
                for (const slot of t.chunkSlots) {
                  const r = byRecipient.get(slot.resultId) as VersionedBatchResult | undefined;
                  if (!r) continue;
                  const match =
                    r.versions?.find((v) => v.generationKey === slot.genKey) ??
                    (r.generationKey === slot.genKey && r.versionId && r.artifactId
                      ? {
                          generationKey: r.generationKey,
                          artifactId: r.artifactId,
                          versionId: r.versionId,
                          version: r.version ?? 1,
                          generationStatus: r.generationStatus,
                          auditStatus: r.auditStatus ?? 'pending',
                          approvalStatus: r.approvalStatus ?? 'not_required',
                          ...(r.reviewRequestId ? { reviewRequestId: r.reviewRequestId } : {}),
                          sendable: r.sendable === true,
                        }
                      : undefined);
                  if (!match) continue;
                  if ((match as DraftVersionRef).isCandidate) {
                    const m = match as DraftVersionRef;
                    candidates.push({
                      genKey: slot.genKey,
                      artifactId: m.artifactId,
                      candidateVersionId: m.versionId,
                      candidateVersion: m.version,
                      baseVersion: m.baseVersion ?? m.version - 1,
                      subject: r.subject,
                      body: sanitizeHtml(markdownishToHtml(r.body)),
                    });
                    continue;
                  }
                  refs.set(slot.genKey, match as DraftVersionRef);
                }
                const candidateKeys = new Set(candidates.map((c) => c.genKey));
                return {
                  ok: true,
                  drafts: drafts.filter((d) => !candidateKeys.has(d.genKey)),
                  heldDrafts: heldDrafts.filter((d) => !candidateKeys.has(d.genKey)),
                  failedGenKeys,
                  refs,
                  manifests,
                  candidates,
                };
              })
              .catch(
                (err): TaskOut => ({
                  ok: false,
                  genKeys: t.chunkSlots.map((s) => s.genKey),
                  message: apiErrorMessage(err) || 'Generation failed.',
                }),
              ),
        ),
      );
      const succeeded = outs.flatMap((o) => (o.ok ? o.drafts : []));
      const held = outs.flatMap((o) => (o.ok ? o.heldDrafts : []));
      const refs = new Map<string, DraftVersionRef>();
      for (const o of outs) if (o.ok) for (const [k, v] of o.refs) refs.set(k, v);
      const manifests = new Map<string, GenerationSourceManifest>();
      for (const o of outs) if (o.ok) for (const [k, v] of o.manifests) manifests.set(k, v);
      const candidates = outs.flatMap((o) => (o.ok ? o.candidates : []));
      // `failed` now unions BOTH whole-POST failures (ok:false) AND same-batch
      // per-recipient failures (ok:true, failedGenKeys) — both flow to the same
      // 'error' placeholder path in onSuccess.
      const failed = outs.flatMap((o) => (o.ok ? o.failedGenKeys : o.genKeys));
      const firstFailure = outs.find((o): o is Extract<TaskOut, { ok: false }> => !o.ok);
      return {
        succeeded,
        held,
        refs,
        manifests,
        candidates,
        failed,
        errorMessage: firstFailure?.message,
      };
    },
    onSuccess: (res, vars) => {
      // Phase 2 §3.f2/f3 — offer for compare/merge. The slot's current draft
      // (in `generatedEmails`) is untouched; see the candidateKeys filter
      // above for why `res.succeeded`/`res.held` never include these genKeys.
      if (res.candidates.length) {
        setCandidates((prev) => {
          const next = new Map(prev);
          for (const c of res.candidates) next.set(c.genKey, c);
          return next;
        });
      }
      setState((prev) => {
        const generatedEmails = { ...prev.generatedEmails };
        for (const r of res.succeeded) {
          // The AI returns markdown; convert to HTML for the WYSIWYG + HTML
          // send, then SANITIZE at this trust boundary — model output is
          // attacker-influenceable (context items/recipient data) and must
          // never reach the DOM or the send pipeline unsanitized.
          // On an "Improve", stash the pre-revision draft so the user can Revert
          // (keep the last 2). A normal regenerate carries history forward as-is.
          const prior = generatedEmails[r.genKey];
          const isRevise = vars.revise?.genKey === r.genKey;
          // Local revert history is CLIENT state (text kept for one-click undo).
          // It is distinct from the server version history, which is metadata only.
          const localHistory = isRevise
            ? appendDraftHistory(prior ? { ...prior, history: prior.localHistory } : undefined)
            : prior?.localHistory;
          generatedEmails[r.genKey] = {
            ...prior,
            subject: r.subject,
            body: sanitizeHtml(markdownishToHtml(r.body)),
            status: 'ready',
            dirty: false,
            ...(localHistory && localHistory.length ? { localHistory } : {}),
            // Phase 1 §3.j: the Context Used manifest travels with the draft.
            ...(res.manifests.get(r.genKey) ? { manifest: res.manifests.get(r.genKey) } : {}),
          };
        }
        // Held drafts: keep the generated text and attach the version lifecycle,
        // so the editor shows the actual draft under a "Pending review" banner.
        for (const h of res.held) {
          const ref = res.refs.get(h.genKey);
          const priorHeld = generatedEmails[h.genKey];
          generatedEmails[h.genKey] = {
            ...(priorHeld ?? { subject: '', body: '' }),
            subject: h.subject,
            body: sanitizeHtml(markdownishToHtml(h.body)),
            ...(h.contextNote ? { contextNote: h.contextNote } : {}),
            ...(ref
              ? {
                  artifactId: ref.artifactId,
                  versionId: ref.versionId,
                  version: ref.version,
                  generationStatus: ref.generationStatus ?? 'generated',
                  auditStatus: ref.auditStatus,
                  approvalStatus: ref.approvalStatus,
                  ...(ref.reviewRequestId ? { reviewRequestId: ref.reviewRequestId } : {}),
                  sendable: ref.sendable,
                }
              : {}),
            dirty: false,
            status: 'held',
            ...(res.manifests.get(h.genKey) ? { manifest: res.manifests.get(h.genKey) } : {}),
          };
        }
        // Attach the version lifecycle to the SUCCEEDED drafts too, so the send
        // step reads server state rather than a local guess.
        for (const r of res.succeeded) {
          const ref = res.refs.get(r.genKey);
          const priorOk = generatedEmails[r.genKey];
          if (!ref || !priorOk) continue;
          generatedEmails[r.genKey] = {
            ...priorOk,
            artifactId: ref.artifactId,
            versionId: ref.versionId,
            version: ref.version,
            generationStatus: ref.generationStatus ?? 'generated',
            auditStatus: ref.auditStatus,
            approvalStatus: ref.approvalStatus,
            ...(ref.reviewRequestId ? { reviewRequestId: ref.reviewRequestId } : {}),
            sendable: ref.sendable,
            dirty: false,
          };
        }
        for (const genKey of res.failed) {
          // A slot whose POST failed gets an editable placeholder marked 'error',
          // NOT 'ready' — excluded from the send projection (projectDraftsForSend)
          // so a failed draft can never be blasted out as "…generation failed…".
          // It becomes sendable only once the user edits it (→ 'edited') or a
          // regenerate succeeds (→ 'ready'). Succeeded slots above are untouched.
          generatedEmails[genKey] = {
            subject: `[Placeholder] ${state.campaignName || 'Outreach'}`,
            body: sanitizeHtml(
              markdownishToHtml(
                `Hi there,\n\nThis is a placeholder draft because email generation failed. Edit this text directly, or try Regenerate — it will not be sent until you do.\n\nBest regards,\n${senderName}`,
              ),
            ),
            status: 'error',
          };
        }
        return {
          ...prev,
          generatedEmails,
          // Only a FULLY-successful full regeneration is "fresh" — leave the
          // "context changed" banner up if any slot failed so the user retries.
          ...(vars.markFresh && vars.sig != null && res.failed.length === 0 && res.held.length === 0
            ? { generatedInputSig: vars.sig }
            : {}),
        };
      });
      // Phase 2 §3.f1 — same condition as generatedInputSig above: a full OR
      // exactly-affected regeneration brings the WHOLE campaign back in sync
      // with the current inputs (an unaffected slot was, by definition,
      // already consistent with them).
      if (vars.markFresh && vars.sig != null && res.failed.length === 0 && res.held.length === 0) {
        setLastGenerationSnapshot({
          contextItems: state.contextItems,
          templateId: state.templateId,
          tone: state.tone,
          direction: state.direction,
        });
      }
      // §4.10 (f-5): best-effort, per successfully-generated draft — NOT for an
      // "Improve" (that revises existing text, it doesn't generate fresh). Only
      // the synchronous path (this mutation) is wired; the async bulk job
      // pipeline (submitGenerateJobs) is not — a known, documented gap rather
      // than a silent one. A slot whose recipient carries no clientId (a
      // cross-client campaign, or "All clients") is skipped rather than guessed.
      if (!vars.revise) {
        const slotByKey = new Map(genModel.slots.map((s) => [s.genKey, s]));
        for (const r of res.succeeded) {
          const clientId = slotByKey.get(r.genKey)?.genRecipients[0]?.clientId;
          if (!clientId) continue;
          void api
            .post(intelTrackerPaths.feedback(clientId), {
              targetRef: r.genKey,
              targetType: 'outreach_draft',
              signal: 'outreach_generated',
            })
            .catch(() => {});
        }
      }
      setGeneratingKey(null);
      if (res.held.length) {
        message.warning(
          res.held.length === 1
            ? '1 draft is held for review — a reviewer must approve it before it can be sent.'
            : `${res.held.length} drafts are held for review before they can be sent.`,
        );
      }
      if (res.failed.length && res.succeeded.length) {
        message.warning(
          `Generated ${res.succeeded.length}; ${res.failed.length} failed — ${
            res.errorMessage ?? 'edit or regenerate the flagged drafts.'
          }`,
        );
      } else if (res.failed.length) {
        message.error(
          res.errorMessage ?? 'Generation failed. Edit or regenerate the flagged drafts.',
        );
      } else if (res.succeeded.length) {
        message.success(
          res.succeeded.length === 1
            ? 'Regenerated this email'
            : `Generated ${res.succeeded.length} drafts`,
        );
      }
    },
    onError: (err, vars) => {
      // Last-resort fallback. Each POST catches its own network error inside the
      // mutationFn, so this only fires on an unexpected pre-flight throw. Mark
      // the requested slots 'error' (unsendable) so nothing half-generated leaks.
      setState((prev) => {
        const generatedEmails = { ...prev.generatedEmails };
        for (const s of vars.slots) {
          generatedEmails[s.genKey] = {
            subject: `[Placeholder] ${state.campaignName || 'Outreach'}`,
            body: sanitizeHtml(
              markdownishToHtml(
                `Hi there,\n\nThis is a placeholder draft because email generation failed. Edit this text directly, or try Regenerate — it will not be sent until you do.\n\nBest regards,\n${senderName}`,
              ),
            ),
            status: 'error',
          };
        }
        return { ...prev, generatedEmails };
      });
      setGeneratingKey(null);
      message.error(
        apiErrorMessage(err) || 'Generation failed. Edit or regenerate the flagged drafts.',
      );
    },
  });

  // Flat {recipientId,subject,body} per recipient for the unchanged send-batch
  // contract — a group's shared draft fans to every member (see generation.ts).
  // LEGACY (flag-off) projection of raw TEXT. Under versioned outreach the Send
  // step uses projectVersionIdsForSend() instead, which emits version ids only.
  const buildDrafts = () =>
    projectDraftsForSend(
      state.targets,
      Object.fromEntries(
        Object.entries(state.generatedEmails).map(([k, d]) => [
          k,
          { subject: d.subject, body: d.body, status: d.status ?? 'ready' },
        ]),
      ),
    );

  // Which connected inbox this send goes out from. Defaults to the first inbox
  // in the list, which the API orders provider-first (Outlook before Gmail, per
  // the EngagementProvider enum) then newest — so an existing Outlook user keeps
  // their prior sending mailbox. The user overrides it in the Send step's picker
  // when more than one inbox is connected.
  const [senderConnectionId, setSenderConnectionId] = useState<string | undefined>(undefined);
  const selectedInboxId = senderConnectionId ?? sendableInboxes[0]?.id;
  const selectedInbox = sendableInboxes.find((inbox) => inbox.id === selectedInboxId) ?? null;
  // Display must reflect the SELECTED inbox — never fall back to another inbox's
  // address (that would tell the user their mail went from a mailbox it didn't).
  // Only when no inbox is selected at all do we use the parent's sendFrom hint.
  const selectedSendFrom = selectedInbox
    ? (selectedInbox.accountEmail ?? selectedInbox.displayName ?? null)
    : sendFrom;

  /** The intent currently being watched (Phase 0 send path). */
  const [sendIntentId, setSendIntentId] = useState<string | null>(null);
  const { intent: sendIntent, isPolling: intentPolling } = useSendIntent(api, sendIntentId);

  // ── Phase e/f §f1/f2 — one explicit test preview, never "every recipient" ──
  //
  // A test send now previews exactly ONE campaign version (the server rejects
  // a test intent carrying more than one). testPreviewGenerationKey is which
  // slot the picker in StepSend has selected; testPreviewOptions is the set of
  // currently-sendable slots it may choose from — the SAME projection Send
  // itself uses, so a slot that is not actually sendable can never be offered.
  const [testPreviewGenerationKey, setTestPreviewGenerationKey] = useState<string | null>(null);
  const testPreviewSendableGenKeys = useMemo(
    () => new Set(projectVersionIdsForSend(state.targets, state.generatedEmails).map((u) => u.genKey)),
    [state.targets, state.generatedEmails],
  );
  const testPreviewOptions = useMemo(
    () =>
      genModel.slots
        .filter((s) => testPreviewSendableGenKeys.has(s.genKey))
        .map((s) => ({
          genKey: s.genKey,
          label:
            s.genRecipients[0]?.name || s.genRecipients[0]?.email || s.genKey,
        })),
    [genModel.slots, testPreviewSendableGenKeys],
  );
  // Keep the selection valid as the sendable set changes (context edits,
  // regeneration, a candidate accepted/discarded) — default to the first
  // sendable slot rather than leaving a stale or empty selection behind.
  useEffect(() => {
    if (
      testPreviewGenerationKey &&
      testPreviewOptions.some((o) => o.genKey === testPreviewGenerationKey)
    ) {
      return;
    }
    setTestPreviewGenerationKey(testPreviewOptions[0]?.genKey ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testPreviewOptions]);

  /**
   * Submit a durable send intent (§3.g6).
   *
   * Submits DRAFT VERSION IDS — never subject/body. One request key is minted per
   * click and REUSED across retries, so a double-click or a network retry resolves
   * to the same intent instead of sending twice.
   */
  const sendIntentMutation = useMutation({
    mutationFn: async (vars?: { testMode?: boolean; onlyGenKeys?: string[] }) => {
      const testMode = vars?.testMode === true;
      const recordId = draftId ?? (await ensureDraftRecord());

      // §f1/f2 — a test send previews exactly ONE explicitly selected version;
      // the server rejects a test intent carrying more than one. Checked here
      // too so the failure is immediate rather than a round-trip 400 — the
      // defect this closes was "Send test" silently previewing EVERY campaign
      // recipient instead of the one the user meant to check.
      if (testMode && (vars?.onlyGenKeys?.length ?? 0) !== 1) {
        throw new Error('Choose one recipient to preview before sending a test.');
      }

      // A retry of specific failed rows must submit ONLY those. Re-submitting the
      // whole set would hit the server's (tenant, idempotencyKey) unique index on
      // the first already-delivered draft, which rolls the new intent back
      // entirely — so a partial-failure retry would 409 instead of working.
      const isRetry = !testMode && !!vars?.onlyGenKeys?.length;
      const units = scopeUnitsToGenKeys(
        projectVersionIdsForSend(state.targets, state.generatedEmails),
        vars?.onlyGenKeys,
      );
      if (!units.length) {
        throw new Error(
          isRetry
            ? 'Those drafts are no longer ready to resend. Reopen Generate & Review to check them.'
            : testMode
              ? 'That draft is no longer ready to preview. Check it in Generate & Review.'
              : 'No verified drafts are ready to send. Resolve the flagged drafts in Generate & Review.',
        );
      }
      if (!selectedInboxId) {
        throw new Error('Choose the mailbox to send from.');
      }

      // Attachment preflight BEFORE submission: nothing is ever silently omitted
      // from a sent email (the old path reported "skipped" after sending).
      const issues = attachmentPreflight(state.attachmentIds, docsQuery.data?.items ?? []);
      if (issues.length) {
        throw new Error(
          `These files are over the 3 MB email limit and cannot be sent: ${issues
            .map((i) => i.fileName)
            .join(', ')}. Remove them or share a link instead.`,
        );
      }

      const requestKey = testMode
        ? (testRequestKeyRef.current = ensureTestRequestKey(testRequestKeyRef.current))
        : (sendRequestKeyRef.current = ensureRequestKey(sendRequestKeyRef.current));

      const created = await createSendIntent(api, {
        outreachRecordId: recordId,
        requestKey,
        senderConnectionId: selectedInboxId,
        draftVersionIds: units.map((u) => u.draftVersionId),
        attachmentIds: state.attachmentIds,
        appendSignature,
        testMode,
      });
      return { ...created, testMode };
    },
    onSuccess: (data) => {
      setSendIntentId(data.intentId);
      if (data.deduped) {
        message.info('This send was already submitted — showing its progress.');
      }
      qc.invalidateQueries({ queryKey: ['engagement-outreach'] });
    },
    onError: (err) => {
      // Keep the request key: a retry after a transient failure must reuse it so
      // the server can dedupe rather than starting a second send.
      message.error(apiErrorMessage(err) || 'Could not submit the send.');
    },
  });

  /** Retry ONLY explicitly-failed deliveries, under a NEW request key. */
  const retryFailedDeliveries = () => {
    if (!sendIntent) return;
    const failedKeys = retryableGenKeys(sendIntent);
    if (!failedKeys.length) return;
    // A retry is a NEW intent with a NEW key (the old key would dedupe onto the
    // existing intent). 'unknown' rows are deliberately excluded by
    // showRetryControl, and the scope is passed through so an already-DELIVERED
    // row in the same intent is not resubmitted.
    //
    // testMode is inherited from the intent being retried: retrying a failed TEST
    // send must not silently become a real send to live recipients.
    const testMode = sendIntent.testMode;
    if (testMode) testRequestKeyRef.current = null;
    else sendRequestKeyRef.current = null;
    setSendIntentId(null);
    sendIntentMutation.mutate({ onlyGenKeys: failedKeys, testMode });
  };

  const cancelCurrentIntent = async () => {
    if (!sendIntentId) return;
    try {
      const res = await cancelSendIntent(api, sendIntentId);
      if (res.inFlight > 0) {
        message.warning(
          `${res.skipped} queued email(s) cancelled. ${res.inFlight} already in flight could not be cancelled — check the per-recipient results.`,
        );
      } else {
        message.success(`Cancelled ${res.skipped} queued email(s).`);
      }
    } catch (err) {
      message.error(apiErrorMessage(err) || 'Could not cancel this send.');
    }
  };

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
        senderConnectionId: selectedInboxId,
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
  /**
   * Build the save payload from an EXPLICIT snapshot (§3.g3).
   *
   * Extracted from saveDraftMutation so ensureDraftRecord() can persist the
   * record without depending on an asynchronous React state update having landed
   * — the old closure read `state`, so a save fired during the same tick as a
   * state change could serialize stale wizard content.
   */
  const buildSaveBody = (snapshot: WizardV2State, stepIndex: number, stepId: string) => {
    const drafts = projectDraftsForSend(
      snapshot.targets,
      Object.fromEntries(
        Object.entries(snapshot.generatedEmails).map(([k, d]) => [
          k,
          { subject: d.subject, body: d.body, status: d.status ?? 'ready' },
        ]),
      ),
    );
    const first = drafts[0];
    const contextPool = expandContextItemScopes(snapshot.contextItems, snapshot.targets).map(
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
    return {
      clientId: snapshot.clientId ?? undefined,
      direction: snapshot.direction ?? undefined,
      title: snapshot.campaignName?.trim() || 'Untitled outreach',
      subject: first?.subject?.trim() || undefined,
      body: first ? htmlToPlainText(first.body).trim() || undefined : undefined,
      recipients: snapshot.recipients,
      lastStep: stepIndex + 1,
      contextPool,
      metadata: {
        source: 'v2-wizard',
        lastStep: stepIndex + 1,
        lastStepId: stepId,
        tone: snapshot.tone,
        templateId: snapshot.templateId,
        perRecipientEmails: drafts,
        generatedByKey: snapshot.generatedEmails,
        contextItems: snapshot.contextItems,
        attachmentIds: snapshot.attachmentIds,
        targets: snapshot.targets,
        // Phase 2 §3.g — "keep all" acknowledgement, tied to the collision-set
        // fingerprint it was given against (see collisionsFingerprint).
        collisionResolution: snapshot.collisionResolution,
      },
    };
  };

  /**
   * Ensure a durable OutreachRecord exists, returning its id (§3.g3).
   *
   * Under versioned outreach there is nowhere to persist an immutable draft
   * version without this record, so generation MUST NOT start before it exists —
   * otherwise the AI is billed for text the server cannot keep. One shared
   * promise held in a ref serializes concurrent callers, so a fan-out of
   * generation tasks creates exactly one record.
   */
  const ensureDraftRecord = async (): Promise<string> => {
    if (draftId) return draftId;
    if (ensureRecordRef.current) return ensureRecordRef.current;
    const pending = (async () => {
      const body = buildSaveBody(state, stepIdx, step.id);
      const created = (
        await api.post<{ id: string }>('/api/engagement/outreach', {
          type: 'campaign',
          ...body,
        })
      ).data;
      setDraftId(created.id);
      return created.id;
    })();
    ensureRecordRef.current = pending;
    try {
      return await pending;
    } catch (err) {
      // Clear the ref so a later attempt can retry rather than replaying a
      // rejected promise forever.
      ensureRecordRef.current = null;
      throw err;
    }
  };

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
          // Phase 2 §3.g — "keep all" acknowledgement, tied to the collision-set
          // fingerprint it was given against (see collisionsFingerprint).
          collisionResolution: state.collisionResolution,
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
    // Same reasoning as the ensureDraftRecord catch above: surface what the
    // server actually objected to, not just that something went wrong.
    onError: (err) =>
      message.error(
        apiErrorMessage(err)
          ? `Could not save draft: ${apiErrorMessage(err)}`
          : 'Could not save draft',
      ),
  });

  // Auto-generate any slots that don't yet have a draft when we land on the
  // Generate step. Generating only the MISSING slots (not gating on the whole
  // map being empty) also covers resuming a partially-generated draft and
  // adding recipients then returning to this step.
  useEffect(() => {
    if (step.id !== 'generate' || generateMutation.isPending || activeJobIds.length > 0) return;
    const missing = genModel.slots.filter((s) => !state.generatedEmails[s.genKey]);
    if (missing.length === 0) return;
    // First entry generates every slot → stamp the signature so the banner doesn't
    // immediately flag freshly-generated drafts as stale.
    const markFresh = missing.length === genModel.slots.length;
    if (asyncGen) void submitGenerateJobs(missing, markFresh, genSig);
    else generateMutation.mutate({ slots: missing, markFresh, sig: genSig });
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

  /**
   * Persist one draft slot as a NEW immutable version (§3.g4).
   *
   * Returns a promise the navigation guard awaits, so entering the Send step can
   * never race an unsaved edit. A 409 means someone else appended first: autosave
   * STOPS, the local text is kept, and the user is offered "Load latest" — an
   * automatic retry would either clobber the winner or spin forever.
   */
  const flushDraftVersion = async (genKey: string): Promise<void> => {
    const draft = state.generatedEmails[genKey];
    if (!versionedOutreach || !draft?.artifactId || !draft.versionId || !draft.dirty) return;

    const existing = versionWritesRef.current.get(genKey);
    if (existing) return existing;

    const write = (async () => {
      setState((prev) => {
        const d = prev.generatedEmails[genKey];
        if (!d) return prev;
        return {
          ...prev,
          generatedEmails: { ...prev.generatedEmails, [genKey]: { ...d, localStatus: 'saving' } },
        };
      });
      try {
        const res = await api.post<{
          id: string;
          artifactId: string;
          version: number;
          subject: string;
          body: string;
          generationStatus: GeneratedDraft['generationStatus'];
          auditStatus: NonNullable<GeneratedDraft['auditStatus']>;
          approvalStatus: NonNullable<GeneratedDraft['approvalStatus']>;
          reviewRequestId?: string | null;
          sendable: boolean;
          contextNote?: string;
        }>(`/api/engagement/outreach/draft-artifacts/${draft.artifactId}/versions`, {
          baseVersionId: draft.versionId,
          subject: draft.subject,
          body: draft.body,
          editKind: 'manual',
        });
        setState((prev) => {
          const d = prev.generatedEmails[genKey];
          if (!d) return prev;
          return {
            ...prev,
            generatedEmails: { ...prev.generatedEmails, [genKey]: applyNewVersion(d, res.data) },
          };
        });
      } catch (err) {
        const status = (err as { response?: { status?: number; data?: unknown } })?.response?.status;
        if (status === 409) {
          const data = (err as { response?: { data?: { currentVersionId?: string | null } } })
            .response?.data;
          setState((prev) => {
            const d = prev.generatedEmails[genKey];
            if (!d) return prev;
            return {
              ...prev,
              generatedEmails: {
                ...prev.generatedEmails,
                [genKey]: applyVersionConflict(d, { currentVersionId: data?.currentVersionId }),
              },
            };
          });
          message.warning(
            'A newer version of this draft exists. Your text was kept — load the latest version to continue.',
          );
        } else {
          setState((prev) => {
            const d = prev.generatedEmails[genKey];
            if (!d) return prev;
            return {
              ...prev,
              generatedEmails: {
                ...prev.generatedEmails,
                [genKey]: { ...d, localStatus: 'save_failed', sendable: false },
              },
            };
          });
          message.error('Could not save this draft. It will not be sent until it saves.');
        }
      } finally {
        versionWritesRef.current.delete(genKey);
      }
    })();
    versionWritesRef.current.set(genKey, write);
    return write;
  };

  /** Fetch and adopt the server's latest version after a 409 ("Load latest"). */
  const loadLatestVersion = async (genKey: string) => {
    const draft = state.generatedEmails[genKey];
    if (!draft?.artifactId) return;
    try {
      const artifacts = (
        await api.get<
          Array<{
            id: string;
            generationKey: string;
            current: {
              id: string;
              artifactId: string;
              version: number;
              subject: string;
              body: string;
              generationStatus: GeneratedDraft['generationStatus'];
              auditStatus: NonNullable<GeneratedDraft['auditStatus']>;
              approvalStatus: NonNullable<GeneratedDraft['approvalStatus']>;
              reviewRequestId?: string | null;
              sendable: boolean;
            } | null;
          }>
        >(`/api/engagement/outreach/${draftId}/draft-artifacts`)
      ).data;
      const match = artifacts.find((a) => a.generationKey === genKey);
      if (!match?.current) return;
      setState((prev) => {
        const d = prev.generatedEmails[genKey];
        if (!d) return prev;
        return {
          ...prev,
          generatedEmails: { ...prev.generatedEmails, [genKey]: applyNewVersion(d, match.current!) },
        };
      });
      message.success('Loaded the latest version of this draft.');
    } catch {
      message.error('Could not load the latest version.');
    }
  };

  // ── Phase 2 §3.f2/f3 — candidate regeneration compare/merge ────────────────

  /** Discard a candidate — it stays immutable, non-current history. Nothing to send. */
  const keepMineCandidate = (genKey: string) => {
    setCandidates((prev) => {
      const next = new Map(prev);
      next.delete(genKey);
      return next;
    });
  };

  const acceptCandidate = async (candidate: DraftCandidate) => {
    setCandidateBusyKey(candidate.genKey);
    try {
      const res = await api.post<{
        current: {
          id: string;
          artifactId: string;
          version: number;
          subject: string;
          body: string;
          generationStatus: GeneratedDraft['generationStatus'];
          auditStatus: NonNullable<GeneratedDraft['auditStatus']>;
          approvalStatus: NonNullable<GeneratedDraft['approvalStatus']>;
          reviewRequestId?: string | null;
          sendable: boolean;
        } | null;
      }>(
        `/api/engagement/outreach/draft-artifacts/${candidate.artifactId}/versions/${candidate.candidateVersionId}/accept`,
        { baseVersion: candidate.baseVersion },
      );
      if (res.data.current) {
        setState((prev) => {
          const d = prev.generatedEmails[candidate.genKey];
          if (!d) return prev;
          return {
            ...prev,
            generatedEmails: {
              ...prev.generatedEmails,
              [candidate.genKey]: applyNewVersion(d, res.data.current!),
            },
          };
        });
      }
      keepMineCandidate(candidate.genKey);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      message.error(
        status === 409
          ? 'This draft changed since the candidate was generated. Reload before accepting.'
          : apiErrorMessage(err) || 'Could not accept the regenerated draft.',
      );
    } finally {
      setCandidateBusyKey(null);
    }
  };

  /** Merge manually: save the user's merged text as a new edited version, based on the CURRENT (not the candidate's) version. */
  const mergeCandidate = async (candidate: DraftCandidate, subject: string, body: string) => {
    const currentDraft = state.generatedEmails[candidate.genKey];
    if (!currentDraft?.versionId) return;
    setCandidateBusyKey(candidate.genKey);
    try {
      const res = await api.post<{
        id: string;
        artifactId: string;
        version: number;
        subject: string;
        body: string;
        generationStatus: GeneratedDraft['generationStatus'];
        auditStatus: NonNullable<GeneratedDraft['auditStatus']>;
        approvalStatus: NonNullable<GeneratedDraft['approvalStatus']>;
        reviewRequestId?: string | null;
        sendable: boolean;
      }>(`/api/engagement/outreach/draft-artifacts/${candidate.artifactId}/versions`, {
        baseVersionId: currentDraft.versionId,
        subject,
        body: sanitizeHtml(markdownishToHtml(body)),
        editKind: 'manual',
      });
      setState((prev) => {
        const d = prev.generatedEmails[candidate.genKey];
        if (!d) return prev;
        return {
          ...prev,
          generatedEmails: { ...prev.generatedEmails, [candidate.genKey]: applyNewVersion(d, res.data) },
        };
      });
      keepMineCandidate(candidate.genKey);
    } catch (err) {
      message.error(apiErrorMessage(err) || 'Could not save the merged draft.');
    } finally {
      setCandidateBusyKey(null);
    }
  };

  /**
   * Inline edits (§3.g4).
   *
   * Under versioning the draft becomes DIRTY and immediately non-sendable, then a
   * debounced POST creates a new immutable version that must earn its own audit.
   * The old behaviour — flipping status to 'edited', which counted as sendable —
   * is what let a held or failed draft be sent by typing one character.
   */
  const updateDraft = (key: string, patch: { subject?: string; body?: string }) => {
    setState((prev) => {
      const existing = prev.generatedEmails[key];
      if (!existing) return prev;
      return {
        ...prev,
        generatedEmails: {
          ...prev.generatedEmails,
          [key]: versionedOutreach
            ? markDirty(existing, patch)
            : { ...existing, ...patch, status: 'edited' },
        },
      };
    });
    if (!versionedOutreach) return;
    // Debounce per artifact so each draft saves independently; a conflicted draft
    // is deliberately NOT rescheduled.
    const timers = autosaveTimersRef.current;
    if (timers[key]) clearTimeout(timers[key]);
    timers[key] = setTimeout(() => {
      delete timers[key];
      void flushDraftVersion(key);
    }, DRAFT_AUTOSAVE_DEBOUNCE_MS);
  };

  /** Flush on blur / before navigating forward, whichever happens first. */
  const flushAllDirtyDrafts = async (): Promise<void> => {
    const timers = autosaveTimersRef.current;
    for (const key of Object.keys(timers)) {
      clearTimeout(timers[key]!);
      delete timers[key];
    }
    const dirty = Object.entries(state.generatedEmails)
      .filter(([, d]) => d.dirty && d.localStatus !== 'conflict')
      .map(([k]) => k);
    await Promise.all(dirty.map((k) => flushDraftVersion(k)));
    // Also await anything already in flight.
    await Promise.all([...versionWritesRef.current.values()]);
  };

  // Regenerate one draft slot (by GenerationTargetKey).
  const regenerateOne = (genKey: string) => {
    const slot = genModel.slots.find((s) => s.genKey === genKey);
    if (!slot) return;
    setGeneratingKey(genKey);
    generateMutation.mutate({ slots: [slot] });
  };
  const regenerateAll = () => {
    setGeneratingKey(null);
    // Full regen → stamp the current input signature so the banner clears. In
    // job-mode this fans out async jobs; single-item regenerate/improve stay sync
    // (one recipient completes in seconds — a job would only add poll latency).
    if (asyncGen) void submitGenerateJobs(genModel.slots, true, genSig);
    else generateMutation.mutate({ slots: genModel.slots, markFresh: true, sig: genSig });
  };

  // Phase 2 §3.f1 — precisely which slots the current inputs still differ
  // from, computed against the snapshot captured at the last full/affected
  // regeneration (null before any generation happens, so nothing is flagged
  // affected on first load — there is no "stale" without a prior baseline).
  const affected = useMemo(
    () =>
      computeAffectedGenerationKeys(
        lastGenerationSnapshot,
        {
          contextItems: state.contextItems,
          templateId: state.templateId,
          tone: state.tone,
          direction: state.direction,
        },
        genModel,
      ),
    [lastGenerationSnapshot, state.contextItems, state.templateId, state.tone, state.direction, genModel],
  );

  /** Regenerate exactly the slots the current inputs affect (§3.f1) — same
   *  candidate-safety as any other regenerate; see the generateMutation. */
  const regenerateAffected = () => {
    const slots = genModel.slots.filter((s) => affected.affected.includes(s.genKey));
    if (!slots.length) return;
    setGeneratingKey(null);
    // Regenerating exactly the affected set brings the WHOLE campaign back in
    // sync with the current inputs, so this stamps markFresh/sig too — same
    // as a full regenerate (see the onSuccess condition).
    if (asyncGen) void submitGenerateJobs(slots, true, genSig);
    else generateMutation.mutate({ slots, markFresh: true, sig: genSig });
  };

  // "Improve": revise ONE draft in place per a freeform instruction (keeps the
  // user's current text as the base; the prior version is stashed for Revert).
  const improveOne = (genKey: string, instruction: string) => {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    const slot = genModel.slots.find((s) => s.genKey === genKey);
    if (!slot) return;
    setGeneratingKey(genKey);
    generateMutation.mutate({ slots: [slot], revise: { genKey, instruction: trimmed } });
  };

  // Revert the last "Improve" — pop the newest history entry back into the draft.
  const revertOne = (genKey: string) =>
    setState((prev) => {
      const draft = prev.generatedEmails[genKey];
      if (!draft) return prev;
      const reverted = revertDraftHistory({ ...draft, history: draft.localHistory });
      if (!reverted) return prev;
      return {
        ...prev,
        generatedEmails: {
          ...prev.generatedEmails,
          [genKey]: {
            ...draft,
            subject: reverted.subject,
            body: reverted.body,
            status: 'edited',
            localHistory: reverted.history.length ? reverted.history : undefined,
          },
        },
      };
    });

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
  /** One dispatcher so every Send/Test control picks the right path. */
  const submitSend = (vars?: { testMode?: boolean; onlyGenKeys?: string[] }) => {
    if (versionedOutreach) sendIntentMutation.mutate(vars);
    else sendMutation.mutate(vars);
  };
  const activeSendMutation = versionedOutreach ? sendIntentMutation : sendMutation;
  const realSending =
    activeSendMutation.isPending && !activeSendMutation.variables?.testMode;
  const testSending =
    activeSendMutation.isPending && !!activeSendMutation.variables?.testMode;
  /** Disable Send while an intent with the same request key is still active. */
  const sendLocked = versionedOutreach && (intentPolling || activeSendMutation.isPending);
  const intentSummary = summarizeIntent(sendIntent);
  // Send-readiness guard: drafts that failed to generate (status 'error') are
  // excluded from the send projection, so a batch with failures must surface the
  // count and Send must hard-disable when nothing is actually sendable.
  // Phase 0: under versioning this counts VERIFIED versions (the shared send
  // gate), not locally-editable text — so a held or dirty draft never inflates it.
  const sendableDraftCount = versionedOutreach
    ? projectVersionIdsForSend(state.targets, state.generatedEmails).length
    : buildDrafts().length;
  // Count blocked slots against the CURRENT generation model only — a stale
  // failure for a target the user has since removed must not warn about a slot
  // that no longer appears in the rail.
  const failedDraftCount = versionedOutreach
    ? genModel.slots.filter((s) => {
        const d = state.generatedEmails[s.genKey];
        // Only slots that actually have a draft and are NOT cleared to send.
        return !!d && !isDraftSendable(d);
      }).length
    : genModel.slots.filter((s) => state.generatedEmails[s.genKey]?.status === 'error').length;

  // Phase 2 §3.h1 — the required final review checkbox. Tied to a signature
  // of what's actually being reviewed (not just a plain boolean) so ANY
  // change to targets/attachments/drafts since the box was checked re-opens
  // it — same discipline as the collision "keep all" fingerprint in g.
  const preflightSignature = JSON.stringify([
    state.targets.map((t) => [t.type, t.key, t.recipients.length]),
    state.attachmentIds.slice().sort(),
    genModel.slots.map((s) => [s.genKey, state.generatedEmails[s.genKey]?.versionId ?? null]),
  ]);
  const [acknowledgedSignature, setAcknowledgedSignature] = useState<string | null>(null);
  const reviewAcknowledged = acknowledgedSignature === preflightSignature;

  const preflight = computeSendPreflight({
    targets: state.targets,
    slots: genModel.slots,
    generated: state.generatedEmails,
    attachmentIds: state.attachmentIds,
    docs: docsQuery.data?.items ?? [],
    collisionResolution: state.collisionResolution,
    emailConnected,
    selectedInboxId,
    reviewAcknowledged,
    sendInFlight: activeSendMutation.isPending,
  });

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
              clientId={state.clientId}
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
              collisionResolution={state.collisionResolution}
              onCollisionResolutionChange={(next) =>
                setState((p) => ({ ...p, collisionResolution: next }))
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
              discoveryBills={discoveryBills}
              hasClient={Boolean(state.clientId)}
              loading={poolLoading}
            />
          )}

          {step.id === 'generate' && jobProgress && (
            <Alert
              type={jobProgress.active ? 'info' : jobProgress.failed > 0 ? 'warning' : 'success'}
              showIcon
              style={{ marginBottom: 12 }}
              message={
                jobProgress.active
                  ? `Generating… ${jobProgress.settled} / ${jobProgress.total} done${
                      jobProgress.failed ? ` · ${jobProgress.failed} failed` : ''
                    }`
                  : `Generation complete — ${jobProgress.done} ready${
                      jobProgress.failed ? `, ${jobProgress.failed} failed` : ''
                    }${jobProgress.skipped ? `, ${jobProgress.skipped} skipped` : ''}`
              }
              action={
                <Space>
                  {jobProgress.active && (
                    <Button size="small" onClick={() => void cancelActiveJobs()}>
                      Cancel
                    </Button>
                  )}
                  {jobProgress.failed > 0 && (
                    <Button size="small" onClick={() => void retryFailedJobItems()}>
                      Retry failed
                    </Button>
                  )}
                </Space>
              }
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
              affectedGenKeys={affected.affected}
              affectedReasonsByKey={affected.reasonsByKey}
              onRegenerateAffected={regenerateAffected}
              candidates={Array.from(candidates.values())}
              onKeepMineCandidate={keepMineCandidate}
              onAcceptCandidate={acceptCandidate}
              onMergeCandidate={mergeCandidate}
              candidateBusyKey={candidateBusyKey}
              onRegenerateAll={regenerateAll}
              onRegenerateOne={regenerateOne}
              onImprove={improveOne}
              onRevert={revertOne}
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
              sendableCount={sendableDraftCount}
              failedCount={failedDraftCount}
              sendFrom={selectedSendFrom}
              sendableInboxes={sendableInboxes}
              selectedInboxId={selectedInboxId}
              onSelectInbox={setSenderConnectionId}
              emailConnected={emailConnected}
              hasSignature={hasSignature}
              appendSignature={appendSignature}
              onToggleSignature={setAppendSigOverride}
              onSend={() => submitSend(undefined)}
              onTest={() =>
                submitSend({
                  testMode: true,
                  onlyGenKeys: testPreviewGenerationKey ? [testPreviewGenerationKey] : undefined,
                })
              }
              testPreviewOptions={testPreviewOptions}
              testPreviewGenerationKey={testPreviewGenerationKey}
              onSelectTestPreview={setTestPreviewGenerationKey}
              sending={realSending}
              testing={testSending}
              sentResult={sentResult}
              onDone={onComplete}
              versionedOutreach={versionedOutreach}
              sendIntent={sendIntent}
              intentPolling={intentPolling}
              sendLocked={sendLocked}
              onRetryFailed={retryFailedDeliveries}
              onCancelIntent={cancelCurrentIntent}
              preflight={preflight}
              reviewAcknowledged={reviewAcknowledged}
              onToggleReviewAcknowledged={(checked) =>
                setAcknowledgedSignature(checked ? preflightSignature : null)
              }
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
                onClick={() => submitSend(undefined)}
                loading={realSending}
                // Locked while an intent with the same request key is active, so a
                // second click cannot start a second send.
                disabled={!emailConnected || sendableDraftCount === 0 || sendLocked}
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
  sendableCount,
  failedCount,
  sendFrom,
  sendableInboxes,
  selectedInboxId,
  onSelectInbox,
  emailConnected,
  hasSignature,
  appendSignature,
  onToggleSignature,
  onSend,
  onTest,
  testPreviewOptions,
  testPreviewGenerationKey,
  onSelectTestPreview,
  sending,
  testing,
  sentResult,
  onDone,
  versionedOutreach,
  sendIntent,
  intentPolling,
  sendLocked,
  onRetryFailed,
  onCancelIntent,
  preflight,
  reviewAcknowledged,
  onToggleReviewAcknowledged,
}: {
  recipients: OutreachRecipient[];
  sendableCount: number;
  failedCount: number;
  sendFrom: string | null;
  sendableInboxes: OutreachSenderInbox[];
  selectedInboxId: string | undefined;
  onSelectInbox: (id: string) => void;
  emailConnected: boolean;
  hasSignature: boolean;
  appendSignature: boolean;
  onToggleSignature: (next: boolean) => void;
  onSend: () => void;
  onTest: () => void;
  /** §f2 — the currently-sendable slots a test preview may choose from. */
  testPreviewOptions: Array<{ genKey: string; label: string }>;
  testPreviewGenerationKey: string | null;
  onSelectTestPreview: (genKey: string) => void;
  sending: boolean;
  testing: boolean;
  sentResult: { sent: number; failed: number } | null;
  onDone: () => void;
  /** Phase 0: render the durable-intent result view instead of a count. */
  versionedOutreach: boolean;
  sendIntent: SendIntentView | undefined;
  intentPolling: boolean;
  sendLocked: boolean;
  onRetryFailed: () => void;
  onCancelIntent: () => void;
  /** Phase 2 §3.h1 — full blockers/warnings + sendable count, computed fresh every render. */
  preflight: SendPreflightResult;
  reviewAcknowledged: boolean;
  onToggleReviewAcknowledged: (checked: boolean) => void;
}) {
  // Nothing sendable (every draft failed, or none generated) → block Send and
  // say why, so the primary CTA is never a dead click into a backend 400.
  const nothingToSend = sendableCount === 0;

  /**
   * Phase 0 (§3.g6) — one row per DELIVERY, with the real provider outcome.
   *
   * Deliberate omissions:
   *   • an `unknown` row gets NO Retry button. The provider may already have
   *     delivered it, so the only safe instruction is "verify Sent Items".
   *   • nothing is reported as a blanket success while any outcome is undetermined.
   */
  if (versionedOutreach && sendIntent) {
    const summary = summarizeIntent(sendIntent);
    const retryable = sendIntent.deliveries.filter((d) => showRetryControl(d.status));
    return (
      <div style={{ padding: '28px 20px', textAlign: 'left' }}>
        <h2 style={{ marginTop: 0, textAlign: 'center' }}>
          {intentPolling
            ? 'Sending…'
            : summary.hasUnknown
              ? `Sent ${summary.sent} · ${summary.unknown} unconfirmed`
              : summary.failed > 0
                ? `Sent ${summary.sent}, ${summary.failed} failed`
                : `${summary.sent} ${summary.sent === 1 ? 'email' : 'emails'} sent`}
        </h2>
        <div className="ov2-pane-sub" style={{ fontSize: 13.5, textAlign: 'center' }}>
          {sendIntent.testMode ? 'Test send — only you received a copy. ' : ''}
          {summary.inFlight > 0 ? `${summary.inFlight} still in progress. ` : ''}
          {summary.hasUnknown
            ? 'Some outcomes could not be confirmed — check Sent Items before resending those.'
            : ''}
        </div>

        {summary.hasUnknown && (
          <Alert
            type="warning"
            showIcon
            style={{ margin: '16px 0' }}
            message={`${summary.unknown} delivery outcome(s) unknown`}
            description={DELIVERY_STATUS_COPY.unknown}
          />
        )}

        <div style={{ marginTop: 18 }}>
          {sendIntent.deliveries.map((d) => (
            <div
              key={d.id}
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'flex-start',
                padding: '10px 12px',
                borderTop: '1px solid var(--ov2-line, #eee)',
              }}
            >
              <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                  {d.to.map((t) => t.email).join(', ') || d.recipientKey}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--ov2-ink-2)' }}>{d.subject}</div>
                {d.cc.length > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--ov2-ink-2)' }}>Cc: {d.cc.join(', ')}</div>
                )}
                {/* Provider ids make a send reconcilable against the mailbox. */}
                {(d.providerMessageId || d.providerDraftId) && (
                  <div style={{ fontSize: 11.5, color: 'var(--ov2-ink-2)', marginTop: 2 }}>
                    {d.provider === 'gmail' ? 'Gmail id' : 'Outlook draft'}:{' '}
                    {d.providerMessageId ?? d.providerDraftId}
                  </div>
                )}
                {d.errorMessage && (
                  <div style={{ fontSize: 12, color: 'var(--ov2-danger, #dc2626)', marginTop: 2 }}>
                    {d.errorCode ? `${d.errorCode}: ` : ''}
                    {d.errorMessage}
                  </div>
                )}
              </div>
              <div style={{ flex: '0 0 auto', fontSize: 12.5, textAlign: 'right' }}>
                {DELIVERY_STATUS_COPY[d.status]}
              </div>
            </div>
          ))}
        </div>

        <Space style={{ marginTop: 22, justifyContent: 'center', width: '100%' }}>
          {intentPolling && <Button onClick={onCancelIntent}>Cancel queued</Button>}
          {/* Retry exists ONLY for explicit failures, and creates a NEW intent. */}
          {!intentPolling && retryable.length > 0 && (
            <Button onClick={onRetryFailed}>Create new send for {retryable.length} failed</Button>
          )}
          {!intentPolling && (
            <Button type="primary" icon={<CheckOutlined />} onClick={onDone}>
              Done
            </Button>
          )}
        </Space>
      </div>
    );
  }

  // Post-send confirmation screen (pre-Phase-0 path).
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
        <b style={{ color: 'var(--ov2-ink-1)' }}>{preflight.sendableCount}</b> personalized{' '}
        {preflight.sendableCount === 1 ? 'email is' : 'emails are'} ready. Capiro will send from{' '}
        <b>{sendFrom || 'your connected inbox'}</b>.
      </div>
      {sendableInboxes.length > 1 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12.5, color: 'var(--ov2-ink-2)', marginBottom: 6 }}>Send from</div>
          <Select
            value={selectedInboxId}
            onChange={onSelectInbox}
            style={{ minWidth: 280, maxWidth: 440, textAlign: 'left' }}
            options={sendableInboxes.map((inbox) => ({
              value: inbox.id,
              label: `${inbox.accountEmail || inbox.displayName || 'Connected inbox'} · ${
                inbox.provider === 'google_workspace' ? 'Gmail' : 'Outlook'
              }`,
            }))}
          />
        </div>
      )}

      {/* Phase 2 §3.h1 — itemized recipient/group rows with To/Cc/Bcc counts,
          instead of only a flat total. */}
      {recipients.length > 0 && (
        <div
          style={{
            marginTop: 18,
            maxHeight: 220,
            overflowY: 'auto',
            textAlign: 'left',
            border: '1px solid var(--ov2-border-1)',
            borderRadius: 8,
          }}
        >
          {recipients.map((r, i) => {
            const isGroup = (r.groupMembers?.length ?? 0) > 0;
            const toCount = isGroup ? r.groupMembers!.length : 1;
            return (
              <div
                key={r.id ?? r.email ?? i}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: '8px 12px',
                  borderTop: i > 0 ? '1px solid var(--ov2-border-1)' : 'none',
                  fontSize: 12.5,
                }}
              >
                <span style={{ color: 'var(--ov2-ink-1)', fontWeight: 600 }}>
                  {r.name || r.email || 'Recipient'}
                  {isGroup && (
                    <span style={{ fontWeight: 500, color: 'var(--ov2-ink-3)' }}>
                      {' '}
                      ({toCount} {toCount === 1 ? 'member' : 'members'})
                    </span>
                  )}
                </span>
                <span style={{ color: 'var(--ov2-ink-3)', flexShrink: 0 }}>
                  To {toCount}
                  {(r.cc?.length ?? 0) > 0 ? ` · Cc ${r.cc!.length}` : ''}
                  {(r.bcc?.length ?? 0) > 0 ? ` · Bcc ${r.bcc!.length}` : ''}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Preflight blockers/warnings — grouped, not a wall of per-slot text. */}
      {preflight.issues.length > 0 && (
        <div style={{ marginTop: 16, textAlign: 'left' }}>
          {preflight.blockers.map((b, i) => (
            <Typography.Paragraph key={`b-${i}`} type="danger" style={{ margin: '4px 0' }}>
              {b.message}
            </Typography.Paragraph>
          ))}
          {preflight.warnings.map((w, i) => (
            <Typography.Paragraph key={`w-${i}`} type="warning" style={{ margin: '4px 0' }}>
              {w.message}
            </Typography.Paragraph>
          ))}
        </div>
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
          <span style={{ fontSize: 13, color: 'var(--ov2-ink-1)' }}>Append my email signature</span>
        </div>
      )}

      {/* Phase 2 §3.h1 — the mandatory final review acknowledgement. Resets
          (see preflightSignature) the moment anything it covers changes. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          marginTop: 18,
          textAlign: 'left',
          maxWidth: 480,
          marginLeft: 'auto',
          marginRight: 'auto',
        }}
      >
        <input
          type="checkbox"
          id="ov2-send-review-ack"
          checked={reviewAcknowledged}
          onChange={(e) => onToggleReviewAcknowledged(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <label
          htmlFor="ov2-send-review-ack"
          style={{ fontSize: 12.5, color: 'var(--ov2-ink-2)', cursor: 'pointer' }}
        >
          I reviewed the recipients, current draft versions, attachments, and verification status.
        </label>
      </div>

      {/* §f2 — a test send previews exactly ONE explicitly selected recipient's
          draft (the server rejects a test intent carrying more than one). Only
          meaningful under versioned outreach — the legacy path predates
          per-version test sends and is unaffected. */}
      {versionedOutreach && testPreviewOptions.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12.5, color: 'var(--ov2-ink-2)', marginBottom: 6 }}>
            Preview recipient
          </div>
          <Select
            value={testPreviewGenerationKey ?? undefined}
            onChange={onSelectTestPreview}
            style={{ minWidth: 280, maxWidth: 440, textAlign: 'left' }}
            options={testPreviewOptions.map((o) => ({ value: o.genKey, label: o.label }))}
          />
        </div>
      )}

      <Space style={{ marginTop: 16 }}>
        <Button
          icon={<EyeOutlined />}
          loading={testing && !sending}
          onClick={onTest}
          disabled={
            !emailConnected ||
            nothingToSend ||
            sendLocked ||
            (versionedOutreach && !testPreviewGenerationKey)
          }
        >
          Send test email to myself
        </Button>
        <Button
          type="primary"
          icon={<SendOutlined />}
          loading={sending}
          onClick={onSend}
          disabled={!preflight.canSend || sendLocked}
        >
          Confirm Send
        </Button>
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 14 }}>
        “Send test email” delivers one copy to your own inbox, previewing the recipient selected
        above, so you can check formatting before the real send.
      </Typography.Paragraph>
    </div>
  );
}
