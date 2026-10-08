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
import { attachmentContentType } from '../../../../lib/attachment-content-type.js';
import { useMe } from '../../../../lib/me.js';
import { useApproveReview, useRejectReview } from '../../../reviews/reviews-api.js';
import { intelTrackerPaths } from '../../../clients/tracker/intel-tracker-api.js';
import { OUTREACH_SUMMARY_MAX } from '../../../clients/tracker/alert-packet.js';
import type { Client } from '../../../clients/clientTypes.js';
import type { OutreachRecipient, OutreachRecord } from '../../OutreachView.js';
import { StepCampaignSetup } from './StepCampaignSetup.js';
import { StepTemplate } from './StepTemplate.js';
import { StepSend } from './StepSend.js';
import './ui/tailwind.css';
import { Icon } from './ui/icons.js';
// Aliased: antd's Button is still used by the modals further down this file.
import { Button as UiButton } from './ui/Button.js';
import { StepDirectionLanding } from './StepDirectionLanding.js';
import { StepContextPlan } from './StepContextPlan.js';
import { StepContextBuilder } from './StepContextBuilder.js';
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
  applyGenerationFailure,
  buildGenerateTasks,
  buildGenerationModel,
  computeAffectedGenerationKeys,
  genInputSignature,
  partitionGenerationResults,
  projectDraftsForSend,
  revertDraftHistory,
  type BatchDraftResult,
  type GenerationSlotFailure,
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
import type { LegiWatchWizardPrefill } from '../legiwatch-prefill.js';

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
  /** Reviewed, unsaved hearing context; never applied over a saved record. */
  initialPrefill?: LegiWatchWizardPrefill;
  /** The explicit Save as draft action can make a handoff URL durable. */
  onDraftSaved?: (id: string) => void;
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

// GET /api/clients/:clientId/capabilities — only the fields the context pool
// renders. The full row (funding ask, justification, PE list, district nexus)
// is read server-side when the draft is generated, never sent from here.
interface ClientCapabilityRow {
  id: string;
  name: string;
  type?: string | null;
  sector?: string | null;
  serviceBranch?: string | null;
  trl?: number | null;
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
  /**
   * genKey → WHY that slot failed, for same-batch (per-recipient) failures.
   * Derived server-side from the gateway's outcome code + plan-validator
   * issues (see `describeGenerationFailure`). Whole-POST failures have no
   * per-slot entry and fall back to `errorMessage`.
   */
  failureReasons: Map<string, string>;
  /**
   * EM-04 — genKey → empty artifact id seeded on a failed/blocked generation
   * so a hand-edit can POST the first version without a baseVersionId.
   */
  failureArtifacts?: Map<string, string>;
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
  initialPrefill,
  onDraftSaved,
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

  const reviewedPrefill = !initialRecord && !initialDraftId ? initialPrefill : undefined;
  const [stepIdx, setStepIdx] = useState(reviewedPrefill ? 1 : 0);
  /**
   * Mirror of `state` for async guards. The navigation gate runs AFTER awaiting
   * version writes, by which point the closed-over `state` is stale — reading the
   * ref is what makes "block navigation until every draft settles" actually true.
   */
  const stateRef = useRef<WizardV2State>(INITIAL_V2_STATE);
  const [state, setState] = useState<WizardV2State>({
    ...INITIAL_V2_STATE,
    clientId: selectedClientId,
    ...(reviewedPrefill ? { ...reviewedPrefill, direction: 'on-behalf' as const } : {}),
  });
  // Persisted draft record id (set after first Save as draft, reused on
  // subsequent saves so we PATCH instead of creating duplicates). When
  // resuming a saved draft this is seeded from the loaded record so the very
  // first save in the reopened session PATCHes rather than duplicating.
  const [draftId, setDraftId] = useState<string | null>(initialDraftId ?? null);
  // Guards the one-time hydration from a reopened draft (see effect below) so
  // it never clobbers in-progress edits on a re-render or refetch.
  const hydratedRef = useRef(false);
  // Guards the one-time server-artifacts resume backfill (see effect below).
  // Starts true (nothing to backfill) whenever there is no draft to resume;
  // the resume-hydrate effect flips it to false the instant it discovers a
  // versioned draft to reconcile, and the auto-generate effect below waits
  // for it so it can never fire against a still-stale local snapshot.
  const [artifactsBackfillPending, setArtifactsBackfillPending] = useState(false);
  // Confirmation shown after a real send completes.
  const [sentResult, setSentResult] = useState<{ sent: number; failed: number } | null>(null);
  // Recipient key currently being (re)generated individually, if any.
  const [generatingKey, setGeneratingKey] = useState<string | null>(null);
  // Recipient key whose held-draft review decision is in flight, if any.
  const [decidingKey, setDecidingKey] = useState<string | null>(null);
  const approveReview = useApproveReview();
  const rejectReview = useRejectReview();
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
  const attachmentUploadsRef = useRef(0);
  const [attachmentUploadsPending, setAttachmentUploadsPending] = useState(0);
  const [attachmentUploadFailures, setAttachmentUploadFailures] = useState<string[]>([]);

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
    if (attachmentUploadsRef.current > 0 || attachmentUploadFailures.length > 0) {
      message.warning(
        'Finish uploading your attachments or remove failed files before continuing.',
      );
      return;
    }
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
        const saveFailed = gate.dirty.some(
          (k) => stateRef.current.generatedEmails[k]?.localStatus === 'save_failed',
        );
        message.warning(
          saveFailed
            ? 'Some edits could not be saved. Fix or re-edit those drafts — each must verify before it can be sent.'
            : gate.dirty.length
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

    // Context Plan's main idea — a plain string, defensive against any older
    // draft that predates the field (falls back to whatever's already in
    // state, matching the templateId pattern just below).
    const mainIdea = typeof metadata.mainIdea === 'string' ? metadata.mainIdea : undefined;

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
      mainIdea: mainIdea ?? prev.mainIdea,
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
              mainIdea: mainIdea ?? prev.mainIdea,
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

  // ---- Resume: backfill from the SERVER-AUTHORITATIVE draft-artifacts table ----
  // Bug fix (2026-09-03): metadata.generatedByKey above is a CLIENT-WRITTEN
  // cache of the last save — and the wizard's only write path for it is an
  // explicit "Save as draft" click or ensureDraftRecord() (which itself saves
  // an EMPTY map at generation-START, before any drafts exist, so the AI is
  // never billed for text the server couldn't persist yet). If the user never
  // explicitly saved again after generation completed, generatedByKey stays
  // permanently stuck at the pre-generation snapshot even though the server's
  // outreach_draft_artifacts/versions tables hold the real generated content.
  // The resume-hydrate effect above then seeds an empty/stale
  // `generatedEmails`, every slot reads as "missing", and the auto-generate
  // effect below silently regenerates the whole campaign on every resume —
  // proven live against production CloudWatch logs + DB rows (2026-09-03):
  // three separate resume->regenerate incidents in 24h, each traced to a
  // record whose last save's generatedByKey was `{}` despite real
  // server-side drafts existing from seconds before that save.
  //
  // Fix: after the synchronous hydrate above seeds its (possibly stale)
  // snapshot, fetch the real GET .../draft-artifacts list — the same
  // endpoint loadLatestVersion already trusts after a 409 — and let it win
  // for every genKey the server actually has a current version for. This is
  // always safe to prefer: draft-artifacts is the version of record;
  // metadata.generatedByKey is only ever a lagging cache of it, never newer.
  // A record that was never versioned (feature was off, or predates
  // versioning) simply gets back an empty array, making this a no-op.
  const artifactsBackfillRef = useRef(false);
  useEffect(() => {
    if (artifactsBackfillRef.current) return;
    const resumeId = initialDraftId ?? initialRecord?.id ?? null;
    if (!resumeId) return;
    artifactsBackfillRef.current = true;
    setArtifactsBackfillPending(true);
    void (async () => {
      try {
        const { data: artifacts } = await api.get<
          Array<{
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
              contextNote?: string;
            } | null;
          }>
        >(`/api/engagement/outreach/${resumeId}/draft-artifacts`);
        const withCurrent = artifacts.filter(
          (a): a is typeof a & { current: NonNullable<(typeof a)['current']> } => a.current != null,
        );
        if (withCurrent.length === 0) return;
        setState((prev) => {
          const generatedEmails = { ...prev.generatedEmails };
          for (const a of withCurrent) {
            const priorDraft = generatedEmails[a.generationKey];
            // The server is authoritative; only skip a genKey whose local copy
            // already points at this EXACT version (nothing changed — avoid a
            // pointless re-render), and never clobber unsaved keystrokes typed
            // in the brief window between mount and this fetch resolving.
            if (priorDraft?.versionId === a.current.id) continue;
            if (priorDraft?.dirty) continue;
            generatedEmails[a.generationKey] = applyNewVersion(priorDraft, {
              ...a.current,
              body: sanitizeHtml(markdownishToHtml(a.current.body)),
            });
          }
          return { ...prev, generatedEmails };
        });
      } catch {
        // Read-only backfill: a failure here just leaves the (possibly stale)
        // hydrate-effect result standing, i.e. no worse than before this fix.
        // Never blocks the wizard on it.
      } finally {
        setArtifactsBackfillPending(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRecord]);

  // ---- Context pool ----
  // The Context Builder displays a multi-tab catalog (bills/intel/emails/
  // meetings/notes). The backend has these split across three existing
  // endpoints rather than a single context-pool route, so we fan out from
  // the wizard and bucket the results client-side. Each source is loaded
  // independently so a 404 on one doesn't blank the whole pool.
  const insightsQuery = useQuery<InsightsResponse>({
    enabled: step.id === 'pool',
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
    enabled: step.id === 'pool',
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
    enabled: step.id === 'pool',
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

  // The selected client's own capabilities, straight off their profile, so a
  // draft can lead with what they actually build instead of the author retyping
  // it as a custom note. Client-scoped by definition: no client, no tab content.
  const capabilitiesQuery = useQuery<ClientCapabilityRow[]>({
    enabled: step.id === 'pool' && !!state.clientId,
    queryKey: ['outreach-pool-capabilities', state.clientId],
    queryFn: async () =>
      (await api.get<ClientCapabilityRow[]>(`/api/clients/${state.clientId}/capabilities`)).data,
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
    enabled: step.id === 'pool',
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
      capability: (capabilitiesQuery.data ?? []).map((c) => ({
        id: `capability-${c.id}`,
        kind: 'capability' as const,
        title: c.name,
        // No `body`: the server rehydrates a capability from the profile by id
        // (§3.b1), so a client-supplied body would be rejected anyway.
        tag: c.type ?? undefined,
        sub:
          [c.sector, c.serviceBranch, c.trl != null ? `TRL ${c.trl}` : null]
            .filter(Boolean)
            .join(' · ') || undefined,
      })),
      clientOverview: [],
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
  }, [
    insightsQuery.data,
    mailQuery.data,
    contextLibraryQuery.data,
    peWatchlistQuery.data,
    capabilitiesQuery.data,
  ]);

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
    peWatchlistQuery.isLoading ||
    capabilitiesQuery.isLoading;

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
      case 'plan':
        // The main idea is free text with no server-side validation of its
        // own (Phase 1 §3.b1 style: it's the user's own words) — nothing to
        // require here. Explicit rather than falling through to `default` so
        // a future change to that fallback can't silently start gating this
        // step without anyone noticing.
        return true;
      case 'pool':
        // Context is OPTIONAL. A campaign whose main idea (step 4) carries it
        // must be able to continue with zero pool items — the server's planner
        // handles an empty evidence packet honestly ("plan an honest,
        // non-specific message and list what is missing"). Requiring at least
        // one ticked item here dead-ended real campaigns at step 5 and, on a
        // resumed failed generation, blocked the only path forward.
        return true;
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
        mainIdea: state.mainIdea,
        templateId: state.templateId,
        tone: state.tone,
        direction: state.direction,
      }),
    [state.contextItems, state.mainIdea, state.templateId, state.tone, state.direction],
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
    // Context Plan step 4's "what is this outreach about" free text — the
    // PRIMARY driver of what the plan and draft are about server-side (see
    // GenerationRequest.mainIdea / buildRequestDirectives). Omitted when
    // blank rather than sent as an empty string, matching every other
    // optional field here.
    ...(state.mainIdea.trim() ? { mainIdea: state.mainIdea.trim() } : {}),
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
          // A FAILED async item carries the placeholder as its subject/body. Route
          // it through the same non-destructive path the sync branch uses, so a
          // slot that already holds a draft keeps it instead of being overwritten
          // with boilerplate. (The `dirty`/'edited' guard above only protects
          // UNSAVED edits; once an edit autosaves as a version it is neither, and
          // was previously fair game for this overwrite.)
          if (p.status === 'error') {
            generatedEmails[p.genKey] = applyGenerationFailure(
              prior,
              { subject: p.subject, body: p.body },
              p.failureReason,
            );
            continue;
          }
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
    // Versioned parity with the sync path (§3.g3): under versioned outreach
    // generateBatchEmails requires an owned draft record and rejects the batch
    // before any AI spend when outreachRecordId is missing — and the worker
    // surfaces that reject only as a failed job item, so the wizard showed a
    // generic placeholder. Create the record ONCE here (shared ref serializes
    // concurrent callers) and attach its id + per-slot generation keys exactly
    // like the sync mutation does.
    let recordId: string | null = null;
    if (versionedOutreach) {
      try {
        recordId = await ensureDraftRecord();
      } catch (err) {
        // Same contract as the sync path: keep the server's message and submit
        // nothing — no record means no job, so no spend and no pending state.
        const detail = apiErrorMessage(err);
        message.error(
          detail
            ? `Could not create the protected draft record, so generation was not started: ${detail}`
            : 'Could not create the protected draft record; generation was not started.',
        );
        return;
      }
    }
    jobMarkFreshRef.current = { markFresh: markFresh ?? false, sig: sig ?? null };
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
        return keys.length ? ({ ...r, generationKeys: keys } as unknown as OutreachRecipient) : r;
      });
    };
    try {
      const submitted = await Promise.all(
        tasks.map((t) =>
          submitOutreachGenerateJob(api, {
            ...base,
            ...(recordId ? { outreachRecordId: recordId } : {}),
            recipients: withGenerationKeys(t.recipients, t.chunkSlots),
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
          failureReasons: new Map(),
          failureArtifacts: new Map(),
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
          return keys.length ? ({ ...r, generationKeys: keys } as unknown as OutreachRecipient) : r;
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
            heldDrafts: Array<{
              genKey: string;
              subject: string;
              body: string;
              contextNote?: string;
            }>;
            failedGenKeys: string[];
            failures: GenerationSlotFailure[];
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
                const { drafts, heldDrafts, failedGenKeys, failures, manifests } =
                  partitionGenerationResults(
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
                  failures,
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
      const failureReasons = new Map(
        outs.flatMap((o) => (o.ok ? o.failures : [])).map((f) => [f.genKey, f.reason]),
      );
      // EM-04 — artifact ids seeded on failed/blocked slots for hand-author recovery.
      const failureArtifacts = new Map(
        outs
          .flatMap((o) => (o.ok ? o.failures : []))
          .filter((f): f is typeof f & { artifactId: string } => Boolean(f.artifactId))
          .map((f) => [f.genKey, f.artifactId]),
      );
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
        failureReasons,
        failureArtifacts,
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
            // This attempt succeeded, so any note about the PREVIOUS attempt's
            // failure is stale. Left in place it would sit under a good draft
            // claiming generation had failed.
            failureReason: undefined,
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
          // A slot with NO draft yet gets an editable placeholder marked 'error' —
          // excluded from the send projection (projectDraftsForSend) so a failed
          // draft can never be blasted out as "…generation failed…". A slot that
          // ALREADY holds a draft keeps it verbatim and only records why the
          // attempt failed: overwriting real copy because a retry failed is how a
          // user loses work they never asked to regenerate. See
          // applyGenerationFailure. Succeeded slots above are untouched.
          //
          // The reason is per-slot when the server reported one (a same-batch
          // plan rejection such as MULTIPLE_ASKS), else the whole-POST message.
          // Before 2026-09-03 only the whole-POST message reached here, so a
          // per-recipient rejection rendered as a reasonless placeholder.
          generatedEmails[genKey] = applyGenerationFailure(
            generatedEmails[genKey],
            failedPlaceholder(),
            res.failureReasons.get(genKey) ?? res.errorMessage,
            res.failureArtifacts?.get(genKey)
              ? { artifactId: res.failureArtifacts.get(genKey) }
              : undefined,
          );
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
          mainIdea: state.mainIdea,
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
            ? vars.revise ? 'Applied your requested edits' : 'Regenerated this email'
            : `Generated ${res.succeeded.length} drafts`,
        );
      }
    },
    onError: (err, vars) => {
      // Last-resort fallback. Each POST catches its own network error inside the
      // mutationFn, so this only fires on an unexpected pre-flight throw. A slot
      // with no draft yet is marked 'error' (unsendable) so nothing half-generated
      // leaks; a slot that already has one keeps its text — see
      // applyGenerationFailure.
      // apiErrorMessage only parses HTTP response bodies; a locally thrown
      // Error (e.g. the ensureDraftRecord preflight wrap below) carries its
      // reason on .message, which must not be discarded into a generic
      // "generation failed".
      const detail = apiErrorMessage(err);
      const localReason = err instanceof Error && err.message ? err.message : null;
      const reason = detail ?? localReason ?? undefined;
      const isProtectedDraftPreflightFailure = reason?.startsWith(
        'Could not create the protected draft record',
      );
      setState((prev) => {
        const generatedEmails = { ...prev.generatedEmails };
        for (const s of vars.slots) {
          generatedEmails[s.genKey] = applyGenerationFailure(
            generatedEmails[s.genKey],
            failedPlaceholder(),
            reason,
          );
        }
        return { ...prev, generatedEmails };
      });
      setGeneratingKey(null);
      // The generate-step banner renders this exact preflight reason on the
      // affected draft. Avoid a second Ant message with the same text, which
      // makes the actionable server error appear twice in the UI.
      if (!isProtectedDraftPreflightFailure) {
        message.error(reason ?? 'Generation failed. Edit or regenerate the flagged drafts.');
      }
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
    () =>
      new Set(projectVersionIdsForSend(state.targets, state.generatedEmails).map((u) => u.genKey)),
    [state.targets, state.generatedEmails],
  );
  const testPreviewOptions = useMemo(
    () =>
      genModel.slots
        .filter((s) => testPreviewSendableGenKeys.has(s.genKey))
        .map((s) => ({
          genKey: s.genKey,
          label: s.genRecipients[0]?.name || s.genRecipients[0]?.email || s.genKey,
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
      if (attachmentUploadsRef.current > 0 || attachmentUploadFailures.length > 0) {
        throw new Error('Finish uploading your attachments or remove failed files before sending.');
      }
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
      if (!testMode && !isRetry) {
        const gate = canEnterSendStep(genModel.slots, state.generatedEmails);
        if (!gate.ok) {
          throw new Error(
            'Every selected recipient needs a verified draft before sending. Return to Generate & Review.',
          );
        }
      }
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
      if (attachmentUploadsRef.current > 0 || attachmentUploadFailures.length > 0) {
        throw new Error('Finish uploading your attachments or remove failed files before sending.');
      }
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
        // HP-05 (Gate L) followup c-3: the DTO bounds summary at
        // OUTREACH_SUMMARY_MAX; item.body is unclamped wizard state (it can be
        // the FULL packet render read back from a resumed draft), so an
        // over-length body 400s the save with no clamp here. The initial
        // draftOutreach mutation (TrackerFeedPanel.tsx) already clamps at
        // CREATE time via buildOutreachContextPoolItem — this is the same
        // bound applied on every subsequent save/resume round-trip.
        summary: item.body?.slice(0, OUTREACH_SUMMARY_MAX),
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
        mainIdea: snapshot.mainIdea,
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
          // HP-05 (Gate L) followup c-3: same resume-and-save clamp as buildSaveBody
          // above — item.body is unclamped wizard state, and the DTO bounds
          // summary at OUTREACH_SUMMARY_MAX.
          summary: item.body?.slice(0, OUTREACH_SUMMARY_MAX),
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
          mainIdea: state.mainIdea,
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
      onDraftSaved?.(rec.id);
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
  //
  // Waits on artifactsBackfillPending (2026-09-03 fix) so a resumed draft's
  // real server-side content — fetched by the effect above — has a chance to
  // land in generatedEmails BEFORE this effect asks "what's missing". Without
  // this wait, a resume that lands directly on this step (the common case:
  // lastStepId === 'generate') would evaluate `missing` against the
  // synchronous hydrate effect's snapshot alone and could regenerate slots
  // the server already has real drafts for. For a brand-new campaign (no
  // resume) artifactsBackfillPending never leaves its initial `false`, so
  // this is a pure no-op there.
  useEffect(() => {
    if (step.id !== 'generate' || generateMutation.isPending || activeJobIds.length > 0) return;
    if (artifactsBackfillPending) return;
    const missing = genModel.slots.filter((s) => !state.generatedEmails[s.genKey]);
    if (missing.length === 0) return;
    // First entry generates every slot → stamp the signature so the banner doesn't
    // immediately flag freshly-generated drafts as stale.
    const markFresh = missing.length === genModel.slots.length;
    if (asyncGen) void submitGenerateJobs(missing, markFresh, genSig);
    else generateMutation.mutate({ slots: missing, markFresh, sig: genSig });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.id, artifactsBackfillPending]);

  // ---- Attachments: pick stored client docs or upload a file to send with the emails ----
  const toggleAttachment = (id: string) =>
    setState((p) => ({
      ...p,
      attachmentIds: p.attachmentIds.includes(id)
        ? p.attachmentIds.filter((a) => a !== id)
        : [...p.attachmentIds, id],
    }));

  const uploadAttachment = async (file: File) => {
    attachmentUploadsRef.current += 1;
    setAttachmentUploadsPending(attachmentUploadsRef.current);
    setAttachmentUploadFailures((prior) => prior.filter((name) => name !== file.name));
    try {
      const contentType = attachmentContentType(file);
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
      setAttachmentUploadFailures((prior) => Array.from(new Set([...prior, file.name])));
      message.error(apiErrorMessage(err) || 'Could not upload attachment');
    } finally {
      attachmentUploadsRef.current -= 1;
      setAttachmentUploadsPending(attachmentUploadsRef.current);
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
    let draft = state.generatedEmails[genKey];
    // EM-04: a dirty failed slot may have no versionId yet (generation never
    // produced one). It can still flush once it has an artifactId — the server
    // accepts a missing baseVersionId only against an empty artifact.
    if (!versionedOutreach || !draft?.dirty) return;
    if (draft.localStatus === 'conflict') return;

    // Ensure an artifact exists for never-versioned failed slots.
    if (!draft.artifactId) {
      if (!draftId) return;
      const slot = genModel.slots.find((s) => s.genKey === genKey);
      const recipient = slot?.genRecipients[0];
      try {
        const { data: art } = await api.post<{ id: string }>(
          `/api/engagement/outreach/${draftId}/draft-artifacts`,
          {
            generationKey: genKey,
            recipientKey: slot?.resultId ?? recipient?.email ?? recipient?.name ?? genKey,
            audienceKind: slot?.appliesTo === 'group' ? 'group' : 'individual',
            recipientSnapshot: recipient
              ? {
                  name: recipient.name ?? null,
                  email: recipient.email ?? null,
                  title: recipient.title ?? null,
                }
              : {},
          },
        );
        draft = { ...draft, artifactId: art.id };
        setState((prev) => {
          const d = prev.generatedEmails[genKey];
          if (!d) return prev;
          return {
            ...prev,
            generatedEmails: {
              ...prev.generatedEmails,
              [genKey]: { ...d, artifactId: art.id },
            },
          };
        });
      } catch (err) {
        message.error(
          apiErrorMessage(err) ||
            'Could not prepare this draft for saving. Try again or regenerate.',
        );
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
        return;
      }
    }

    if (!draft.artifactId) return;

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
          // EM-04: omit baseVersionId when this is the first hand-authored version
          // of a never-generated slot. The server only accepts that against
          // currentVersion === 0; otherwise it 409s.
          ...(draft.versionId ? { baseVersionId: draft.versionId } : {}),
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
        const status = (err as { response?: { status?: number; data?: unknown } })?.response
          ?.status;
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
          generatedEmails: {
            ...prev.generatedEmails,
            [genKey]: applyNewVersion(d, match.current!),
          },
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
          generatedEmails: {
            ...prev.generatedEmails,
            [candidate.genKey]: applyNewVersion(d, res.data),
          },
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
          mainIdea: state.mainIdea,
          templateId: state.templateId,
          tone: state.tone,
          direction: state.direction,
        },
        genModel,
      ),
    [
      lastGenerationSnapshot,
      state.contextItems,
      state.mainIdea,
      state.templateId,
      state.tone,
      state.direction,
      genModel,
    ],
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

  // Decide a held draft's review WITHOUT leaving the wizard. Same endpoints the
  // /reviews queue uses, so the server authz boundary is unchanged: a 403 for a
  // user who may not decide surfaces as a message, exactly as it does there.
  const decideHeld = (genKey: string, decision: 'approved' | 'rejected') => {
    const reviewId = state.generatedEmails[genKey]?.reviewRequestId;
    if (!reviewId) return;
    setDecidingKey(genKey);
    const patch = (fields: Partial<GeneratedDraft>) =>
      setState((prev) => {
        const draft = prev.generatedEmails[genKey];
        if (!draft) return prev;
        return {
          ...prev,
          generatedEmails: { ...prev.generatedEmails, [genKey]: { ...draft, ...fields } },
        };
      });

    if (decision === 'approved') {
      approveReview.mutate(
        { id: reviewId },
        {
          onSuccess: (res) => {
            // Trust the server's returned lifecycle over a local guess — the
            // release decides sendability, not this screen.
            patch({
              auditStatus:
                (res?.released?.auditStatus as GeneratedDraft['auditStatus']) ?? 'passed',
              approvalStatus:
                (res?.released?.approvalStatus as GeneratedDraft['approvalStatus']) ?? 'approved',
              sendable: res?.released?.sendUnblocked ?? true,
            });
            message.success('Approved — this draft can be sent');
          },
          onError: (err) => message.error(err.message || 'Could not approve'),
          onSettled: () => setDecidingKey(null),
        },
      );
      return;
    }

    rejectReview.mutate(
      { id: reviewId },
      {
        onSuccess: () => {
          patch({ approvalStatus: 'rejected', sendable: false });
          message.success('Rejected — edit the draft to create a new version');
        },
        onError: (err) => message.error(err.message || 'Could not reject'),
        onSettled: () => setDecidingKey(null),
      },
    );
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
  /** One dispatcher so every Send/Test control picks the right path. */
  const submitSend = (vars?: { testMode?: boolean; onlyGenKeys?: string[] }) => {
    if (versionedOutreach) sendIntentMutation.mutate(vars);
    else sendMutation.mutate(vars);
  };
  const activeSendMutation = versionedOutreach ? sendIntentMutation : sendMutation;
  const realSending = activeSendMutation.isPending && !activeSendMutation.variables?.testMode;
  const testSending = activeSendMutation.isPending && !!activeSendMutation.variables?.testMode;
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

  const preflight = computeSendPreflight({
    targets: state.targets,
    slots: genModel.slots,
    generated: state.generatedEmails,
    attachmentIds: state.attachmentIds,
    docs: docsQuery.data?.items ?? [],
    collisionResolution: state.collisionResolution,
    emailConnected,
    selectedInboxId,
    sendInFlight: activeSendMutation.isPending,
    attachmentUploadsPending,
    attachmentUploadFailures,
  });

  // ---- Render ----
  return (
    // Shell per handover §6.3: 232px rail on bg-surface-subtle with a hairline
    // right edge; step badge is a navy fill + white check when done, a white
    // fill with a 2px navy ring when active, neutral when pending.
    <div className="ov2-wiz ov2-tw-root grid min-h-[600px] grid-cols-[232px_minmax(0,1fr)] overflow-hidden rounded-lg border border-line-hairline bg-surface">
      <aside className="flex flex-col gap-1 border-r border-line-hairline bg-surface-subtle px-[18px] py-[22px]">
        {WIZARD_STEPS.map((s, i) => {
          const done = i < stepIdx;
          const active = i === stepIdx;
          return (
            <div
              key={s.id}
              className={`flex items-center gap-2.5 rounded-sm px-2 py-2.5 text-[13px] ${
                i <= stepIdx ? 'cursor-pointer hover:bg-[#F2F0EB]' : 'cursor-default'
              } ${
                active
                  ? 'font-semibold text-ink-primary'
                  : done
                    ? 'font-medium text-ink-primary'
                    : 'text-ink-tertiary'
              }`}
              onClick={() => i <= stepIdx && setStepIdx(i)}
            >
              <span
                className={`flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full text-xs ${
                  done
                    ? 'btn-dark text-white'
                    : active
                      ? 'border-2 border-ink-strong bg-surface text-ink-primary'
                      : 'border border-line-hairline bg-neutral-bg text-ink-tertiary'
                }`}
              >
                {done ? <Icon.Check size={12} /> : i + 1}
              </span>
              {s.label}
            </div>
          );
        })}
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

          {step.id === 'plan' && (
            <StepContextPlan
              recipients={state.recipients}
              targets={state.targets}
              selected={state.contextItems}
              onChange={(items) => setState((p) => ({ ...p, contextItems: items }))}
              mainIdea={state.mainIdea}
              onMainIdeaChange={(v) => setState((p) => ({ ...p, mainIdea: v }))}
            />
          )}

          {step.id === 'pool' && (
            <>
              <div
                role="note"
                className="mb-3 text-[13px] leading-5 text-ink-secondary"
              >
                Context is optional. Add supporting details, or continue with your main idea.
              </div>
              <StepContextBuilder
                clients={clients}
                selectedClientId={state.clientId}
                recipients={state.recipients}
                targets={state.targets}
                selected={state.contextItems}
                onChange={(items) => setState((p) => ({ ...p, contextItems: items }))}
                pool={pool}
                discoveryBills={discoveryBills}
                hasClient={Boolean(state.clientId)}
                loading={poolLoading}
              />
            </>
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
              onApproveHeld={(k) => decideHeld(k, 'approved')}
              onRejectHeld={(k) => decideHeld(k, 'rejected')}
              decidingKey={decidingKey}
              onEdit={updateDraft}
              onApplyToList={applyToList}
              regenerating={generateMutation.isPending}
              generatingKey={generatingKey}
              clientId={state.clientId}
              clients={clients}
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
            />
          )}
        </div>

        {/* Footer per handover §6.3: Back secondary · 2px progress track with
            an ink fill at (idx+1)/N · "Step N of N" · dark Continue/Finish. */}
        <div className="flex flex-wrap items-center gap-3 border-t border-line-hairline bg-surface-subtle px-8 py-3.5">
          {/* Cancel discards the in-progress outreach (a confirmation dialog
              guards it). "Save as draft" is the explicit way to keep your
              work — available on every step. */}
          <UiButton variant="secondary" onPress={onCancel}>
            Cancel &amp; discard
          </UiButton>
          {attachmentUploadsPending > 0 && (
            <span role="status">Uploading {attachmentUploadsPending} attachment(s)…</span>
          )}
          {attachmentUploadFailures.length > 0 && (
            <div role="alert">
              Upload failed: {attachmentUploadFailures.join(', ')}. Retry the upload or{' '}
              <UiButton variant="secondary" onPress={() => setAttachmentUploadFailures([])}>
                Remove failed files
              </UiButton>
            </div>
          )}
          {stepIdx > 0 && (
            <UiButton variant="secondary" onPress={back}>
              Back
            </UiButton>
          )}
          {!sentResult && (
            <UiButton
              variant="secondary"
              onPress={() => saveDraftMutation.mutate()}
              isDisabled={!canSaveDraft || saveDraftMutation.isPending}
            >
              {saveDraftMutation.isPending ? 'Saving…' : 'Save as draft'}
            </UiButton>
          )}
          <span className="text-[12.5px] whitespace-nowrap text-ink-tertiary">
            Step {stepIdx + 1} of {WIZARD_STEPS.length}
          </span>
          <div className="h-0.5 min-w-[80px] flex-1 rounded-full bg-line-divider">
            <span
              className="block h-full rounded-full bg-ink-primary"
              style={{ width: `${((stepIdx + 1) / WIZARD_STEPS.length) * 100}%` }}
            />
          </div>
          {step.id === 'send' ? (
            sentResult ? (
              <UiButton variant="primary" onPress={onComplete}>
                <Icon.Check size={15} /> Done
              </UiButton>
            ) : (
              <UiButton
                variant="primary"
                onPress={() => submitSend(undefined)}
                // Locked while an intent with the same request key is active, so a
                // second click cannot start a second send.
                isDisabled={!preflight.canSend || sendLocked || realSending}
              >
                <Icon.Send01 size={15} /> {realSending ? 'Sending…' : 'Send all'}
              </UiButton>
            )
          ) : (
            <UiButton
              variant="primary"
              onPress={step.id === 'direction' ? startOutreach : next}
              isDisabled={
                !canAdvance() || attachmentUploadsPending > 0 || attachmentUploadFailures.length > 0
              }
            >
              {step.id === 'generate' ? 'Review Emails' : 'Continue'}
              <Icon.ArrowRight size={15} />
            </UiButton>
          )}
        </div>
      </div>
    </div>
  );
}

// StepSetup (the direction-branched client picker) was removed with the
// campaign-type fork; Campaign Setup now lives in ./StepCampaignSetup.tsx.
// StepTemplate/PreviewTemplateModal/CreateTemplateModal moved to
// ./StepTemplate.tsx and StepSend moved to ./StepSend.tsx, both as part of
// the Tailwind + React Aria migration.
