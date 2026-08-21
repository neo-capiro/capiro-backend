import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Eye,
  FileClock,
  Loader2,
  Mail,
  MoreHorizontal,
  Paperclip,
  PauseCircle,
  Pencil,
  Play,
  RefreshCcw,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  StopCircle,
  Upload,
  X,
} from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import { EngagementDialog } from '../../../pages/engagement/meetings/EngagementDialog.js';
import { OutreachConversation } from '../../../pages/engagement/outreach/v3/OutreachConversation.js';
import type { OutreachV3Proposal } from '../../../pages/engagement/outreach/v3/contracts.js';
import { useOutreachV3Session } from '../../../pages/engagement/outreach/v3/useOutreachV3Session.js';
import { safeOutreachV3Error } from '../../../pages/engagement/outreach/v3/outreach-v3-api.js';
import {
  approveOutreachV3Approach,
  approveOutreachV3Draft,
  cancelOutreachV3GenerationJob,
  cancelOutreachV3SendIntent,
  createOutreachV3SendIntent,
  createOutreachV3TestSend,
  generateOutreachV3Samples,
  getOutreachV3ApproachApproval,
  getOutreachV3GenerationJob,
  getOutreachV3GenerationPlan,
  getOutreachV3SendIntent,
  getOutreachV3SendSettings,
  listOutreachAttachments,
  listOutreachReplyCandidates,
  listOutreachV3Drafts,
  proposeOutreachReplyLearning,
  refineOutreachV3Draft,
  refreshOutreachV3SendIntent,
  retryOutreachV3GenerationItem,
  reviseOutreachV3Draft,
  runOutreachV3Preflight,
  saveOutreachV3SendSettings,
  startOutreachV3FullGeneration,
  uploadOutreachAttachment,
  type OutreachAttachment,
  type OutreachReplyCandidate,
  type OutreachV3DraftArtifact,
  type OutreachV3DraftVersion,
  type OutreachV3GenerationJob,
  type OutreachV3GenerationPlan,
  type OutreachV3NamedPreflightCheck,
  type OutreachV3PreflightInput,
  type OutreachV3SendIntentView,
  type OutreachV3SendSettings,
  type OutreachV3ServerPreflight,
} from './engagement-api.js';
import {
  describeOutreachProposal,
  outreachStepForStage,
  type VNextOutreachOperatorWorkspaceProps,
} from './VNextOutreachOperatorWorkspace.js';
import {
  approvalCount,
  deriveOutreachPhase1View,
  generationProgress,
  initials,
  isGenerationTerminal,
  isSendTerminal,
  partitionDrafts,
  recipientLabel,
  sendProgress,
  statusLabel,
  statusTone,
  type OutreachPhase1View,
} from './outreach-v3-phase1-model.js';

export interface IntegrationConnection {
  id: string;
  provider: string;
  status: string;
  accountEmail?: string | null;
  displayName?: string | null;
}

export interface DraftDiff {
  from: OutreachV3DraftVersion;
  to: OutreachV3DraftVersion;
}

export interface MeriReceipt {
  id: string;
  title: string;
  body: string;
  version: string;
  safeToReverse: boolean;
}

export interface RecipientPresentation {
  label: string;
  subtitle: string;
  email: string | null;
}

export const TERMINAL_GENERATION = ['complete', 'failed', 'canceled', 'cancelled'];

export const TERMINAL_SEND = [
  'sent',
  'failed',
  'complete',
  'canceled',
  'cancelled',
  'delivery_unknown',
  'partial',
];

export function randomKey(prefix: string): string {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${id}`;
}

export function sessionStorageGet(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function sessionStorageSet(key: string, value: string | null): void {
  try {
    if (typeof window === 'undefined') return;
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    // Persistence is a convenience only; server state remains authoritative.
  }
}

export function errorText(error: unknown, fallback: string): string {
  const safe = safeOutreachV3Error(error);
  return safe || (error instanceof Error ? error.message : fallback);
}

export function formatDateTime(value?: string | null): string {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function formatClock(value?: Date | string | null): string {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return 'now';
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function campaignTitle(
  session: ReturnType<typeof useOutreachV3Session>['session'],
): string {
  return (
    session?.spec.goal.topic?.trim() ||
    session?.session.title?.trim() ||
    'Outreach campaign'
  );
}

export function deliveryLabel(pattern?: string): string {
  if (!pattern || pattern === 'undecided') return 'Not decided';
  if (pattern === 'personalized_separate') return 'One tailored email per person';
  if (pattern === 'uniform_separate') return 'The same message, sent separately';
  if (pattern === 'shared_thread') return 'One shared email thread';
  return pattern.replaceAll('_', ' ');
}

export function providerLabel(connection?: IntegrationConnection | null): string {
  if (!connection) return 'No sending mailbox selected';
  return (
    connection.displayName ||
    connection.accountEmail ||
    connection.provider.replaceAll('_', ' ')
  );
}

export function recipientPresentation(
  draft: OutreachV3DraftArtifact,
  plan?: OutreachV3GenerationPlan | null,
): RecipientPresentation {
  const slot = plan?.slots.find((candidate) => candidate.generationKey === draft.generationKey);
  const recipient = slot?.recipients[0];
  return {
    label: recipient?.label?.trim() || recipientLabel(draft),
    subtitle:
      recipient?.targetType?.replaceAll('_', ' ') ||
      recipient?.email ||
      'Campaign recipient',
    email: recipient?.email ?? null,
  };
}

export function paragraphs(body: string): string[] {
  const values = body.split(/\n+/).map((value) => value.trim()).filter(Boolean);
  return values.length ? values : [body];
}

export function wordCount(body: string): number {
  return body.trim() ? body.trim().split(/\s+/).length : 0;
}

export function draftReason(draft: OutreachV3DraftArtifact): string {
  const current = draft.current;
  if (!current) return 'This recipient does not yet have a current draft version.';
  const audit = current.auditStatus.toLowerCase();
  const generation = current.generationStatus.toLowerCase();
  if (audit.includes('held')) {
    return 'Assurance found a claim or source that requires your judgment before this version can be approved.';
  }
  if (audit.includes('unavailable')) {
    return 'The assurance result is unavailable, so this exact version needs a human read.';
  }
  if (generation.includes('failed')) {
    return 'Generation did not complete cleanly for this recipient.';
  }
  if (current.auditChecks.length) {
    return `${current.auditChecks.length} assurance finding${current.auditChecks.length === 1 ? '' : 's'} need review.`;
  }
  return 'This is one of the drafts selected for a deliberate human read before bulk approval.';
}

export function sourceLines(draft: OutreachV3DraftArtifact): Array<{ label: string; scope: string }> {
  const current = draft.current;
  if (!current) return [];
  const lines: Array<{ label: string; scope: string }> = [];
  if (current.contextNote?.trim()) {
    lines.push({ label: current.contextNote.trim(), scope: 'Approved campaign context' });
  }
  for (const check of current.auditChecks.slice(0, 3)) {
    lines.push({
      label: check.check.replaceAll('_', ' '),
      scope: check.severity === 'info' ? 'Checked' : 'Needs judgment',
    });
  }
  if (!lines.length) {
    lines.push({
      label: 'Canonical campaign brief and exact recipient snapshot',
      scope: 'Governed source packet',
    });
  }
  return lines;
}

export function buttonLabelForCheck(check: OutreachV3NamedPreflightCheck): string {
  if (check.key === 'versions' || check.key === 'approval') return 'Review the drafts';
  if (check.key === 'sender' || check.key === 'sender-auth') return 'Check the mailbox';
  if (check.key === 'attachments') return 'Review attachments';
  if (check.key === 'audit') return 'Open held drafts';
  if (check.key === 'recipients' || check.key === 'emails') return 'Review recipients';
  return 'Review this issue';
}

export function phaseLabel(view: OutreachPhase1View): string {
  if (view === 'send' || view === 'sending' || view === 'results') return 'Send';
  return 'Drafts';
}

export function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="ov3p1-progress" aria-label={`${percent}% complete`}>
      <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  );
}

export function StatusChip({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: 'navy' | 'amber' | 'red' | 'neutral';
}) {
  return (
    <span className="ov3p1-chip" data-tone={tone ?? 'neutral'}>
      {children}
    </span>
  );
}

export function VersionChip({ version }: { version: number | string }) {
  return <span className="ov3p1-version">V{version}</span>;
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <section className="ov3p1-empty">
      <span>{icon}</span>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </section>
  );
}

export function DraftEditDialog({
  draft,
  pending,
  onClose,
  onSave,
}: {
  draft: OutreachV3DraftArtifact;
  pending: boolean;
  onClose: () => void;
  onSave: (subject: string, body: string) => void;
}) {
  const [subject, setSubject] = useState(draft.current?.subject ?? '');
  const [body, setBody] = useState(draft.current?.body ?? '');
  const originalSubject = draft.current?.subject ?? '';
  const originalBody = draft.current?.body ?? '';

  return (
    <EngagementDialog
      open
      eyebrow="Exact version · manual edit"
      title={`Create Version ${(draft.current?.version ?? 0) + 1}`}
      description="Earlier versions remain in history. Saving clears exact-version approval and any preflight based on the previous text."
      width={760}
      busy={pending}
      dirty={subject !== originalSubject || body !== originalBody}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ov3p1-button is-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ov3p1-button is-primary"
            disabled={pending || !subject.trim() || !body.trim()}
            onClick={() => onSave(subject.trim(), body.trim())}
          >
            {pending ? 'Saving…' : `Save V${(draft.current?.version ?? 0) + 1}`}
          </button>
        </>
      }
    >
      <div className="ov3p1-dialog-fields">
        <label>
          Subject
          <input autoFocus value={subject} onChange={(event) => setSubject(event.target.value)} />
        </label>
        <label>
          Body
          <textarea rows={16} value={body} onChange={(event) => setBody(event.target.value)} />
        </label>
      </div>
    </EngagementDialog>
  );
}

export function VersionDiffPanel({ diff }: { diff: DraftDiff }) {
  return (
    <section className="ov3p1-version-diff">
      <header>
        <span>What changed</span>
        <div>
          <VersionChip version={diff.from.version} />
          <ArrowRight size={14} />
          <VersionChip version={diff.to.version} />
        </div>
      </header>
      <div>
        <article>
          <span>Before</span>
          <strong>{diff.from.subject}</strong>
          <p>{diff.from.body}</p>
        </article>
        <article>
          <span>Now</span>
          <strong>{diff.to.subject}</strong>
          <p>{diff.to.body}</p>
        </article>
      </div>
    </section>
  );
}
