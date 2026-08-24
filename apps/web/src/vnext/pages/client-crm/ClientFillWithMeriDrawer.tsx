import { useState, type ChangeEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroDrawer, CapiroModal } from '../../components/overlays/index.js';
import { useApi } from '../../../lib/use-api.js';
import {
  errorText,
  useClientFillWithMeri,
  type FillFinding,
} from '../../adapters/legacy/useClientFillWithMeri.js';
import type { AdvocacyMatterSummary } from './tabs/AdvocacyMattersTab.js';

/**
 * Fill with Meri — enrichment review (Figma `1244:4222` §4).
 *
 * Explicitly NOT the chat drawer: it never calls `askMeriAboutClient` and never
 * opens a conversation. It proposes field-level changes with source, freshness
 * and confidence, and writes only what the user ticks.
 */
export function ClientFillWithMeriDrawer({
  clientId,
  clientName,
  open,
  onClose,
  initialWebsite = '',
  onOpenMatter,
}: {
  clientId: string;
  clientName: string;
  open: boolean;
  onClose: () => void;
  /** Prefill the drawer website field from the live client profile. */
  initialWebsite?: string | null;
  /** §22/23 follow-up: after "Attach to Matter" / "Create new Matter"
   *  commits, the caller navigates to and opens that Matter (Relationships
   *  → Advocacy matters). Optional — omitting it just skips the
   *  navigate-and-open step; the assignment itself still applies. */
  onOpenMatter?: (matterId: string) => void;
}) {
  const fill = useClientFillWithMeri(clientId, open);
  const api = useApi();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [websiteInput, setWebsiteInput] = useState(initialWebsite ?? '');

  // Same query key AdvocacyMattersTab uses, so this shares its cache rather
  // than issuing a second, redundant request, and the "Attach to Matter"
  // picker's options are byte-identical to what the Matters tab shows.
  // Only fetched once the drawer is open AND at least one advocacy finding
  // exists — enabled below at the call site, not here, to avoid a request
  // firing before there is anything to attach.
  const mattersForPicker = useQuery<AdvocacyMatterSummary[]>({
    queryKey: ['client-advocacy-matters', clientId],
    queryFn: async () => (await api.get<AdvocacyMatterSummary[]>(`/api/clients/${clientId}/advocacy-matters`)).data,
    enabled: open,
  });

  const persistedAttachmentId = documentAttachmentId(fill.run?.sourceStates);

  const startEnrichment = () => {
    setRetryError(null);
    fill.start({ website: websiteInput.trim() || undefined });
  };

  const retrySelectedDocument = () => {
    const isDocumentRun = Object.prototype.hasOwnProperty.call(
      fill.run?.sourceStates ?? {},
      'client_document',
    );
    const attachmentId = isDocumentRun ? persistedAttachmentId ?? selectedAttachmentId : null;
    if (isDocumentRun && attachmentId) {
      setRetryError(null);
      fill.startForAttachment(attachmentId);
      return;
    }
    if (isDocumentRun) {
      setRetryError('Document retry is unavailable because the original attachment could not be identified.');
      return;
    }
    startEnrichment();
  };

  const uploadCapabilityDocument = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || uploading) return;
    if (file.size > 25 * 1024 * 1024) {
      setUploadError('Choose a file smaller than 25 MB.');
      return;
    }
    // Use the supported extension mapping rather than a browser-provided MIME
    // (for example, browsers often report Markdown as text/markdown while the
    // attachment pipeline correctly accepts it as bounded text/plain).
    const contentType = contentTypeFor(file.name);
    if (!contentType) {
      setUploadError('This file type is not supported. Upload PDF, DOC/DOCX, PPTX, XLSX, CSV, TXT, or Markdown.');
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const presigned = (
        await api.post<{ url: string; fields: Record<string, string>; s3Key: string }>(
          '/api/engagement/attachments/upload-url',
          { clientId, fileName: file.name, contentType, contentLength: file.size },
        )
      ).data;
      const form = new FormData();
      Object.entries(presigned.fields).forEach(([key, value]) => form.append(key, value));
      form.append('file', file);
      const stored = await fetch(presigned.url, { method: 'POST', body: form });
      if (!stored.ok) throw new Error('Storage rejected the upload');
      const confirmed = (
        await api.post<{ id: string }>('/api/engagement/attachments/confirm', {
          clientId,
          fileName: file.name,
          contentType,
          s3Key: presigned.s3Key,
          source: 'fill-with-meri-capability',
        })
      ).data;
      // Keep this explicit user selection for an attachment-specific retry;
      // a document failure must never silently fall back to source enrichment.
      setSelectedAttachmentId(confirmed.id);
      // The document run reads only this server-owned attachment. Extraction,
      // scanner readiness, and text bounds are enforced again by that run.
      fill.startForAttachment(confirmed.id);
    } catch (error) {
      setUploadError(errorText(error, 'Could not upload and extract this document.'));
    } finally {
      setUploading(false);
    }
  };

  return (
    <CapiroDrawer open={open} title={`Fill with Meri — ${clientName}`} onClose={onClose}>
      <div className="capiro-crm-fill">
        <p className="capiro-crm__foot">
          Meri reviews connected sources and reliable public records, or you can upload a
          capability document to propose capability cards, descriptions, and tags. Nothing is
          written until you apply it.
        </p>

        <label className="capiro-crm-fill__document-upload">
          <span className="capiro-crm__meta">Company website</span>
          <input
            type="url"
            name="websiteInput"
            placeholder="https://example.com"
            value={websiteInput}
            disabled={uploading || fill.phase === 'researching' || fill.phase === 'preparing'}
            onChange={(event) => setWebsiteInput(event.target.value)}
          />
        </label>
        <p className="capiro-crm__foot">
          Optional. Seed or correct the company site before enrichment so Meri can crawl product,
          about, and contact pages even when the profile is thin.
        </p>

        <label className="capiro-crm-fill__document-upload">
          <span className="capiro-crm__meta">Upload a capability document</span>
          <input
            type="file"
            accept=".pdf,.doc,.docx,.pptx,.xlsx,.csv,.txt,.md"
            disabled={uploading || fill.phase === 'researching'}
            onChange={uploadCapabilityDocument}
          />
        </label>
        <p className="capiro-crm__foot">
          PDF, Word, PowerPoint, Excel, CSV, and text files up to 25 MB. Meri extracts the
          server-stored document; it never receives a browser file body.
        </p>
        {uploading ? <FillProgress label="Preparing document" detail="Uploading and extracting text…" /> : null}
        {uploadError ? <p className="capiro-crm__foot capiro-crm__state--error">{uploadError}</p> : null}
        {retryError ? <p className="capiro-crm__foot capiro-crm__state--error">{retryError}</p> : null}

        <FillBody
          fill={fill}
          onClose={onClose}
          onRetry={retrySelectedDocument}
          onStart={startEnrichment}
          matterOptions={mattersForPicker.data ?? []}
          onOpenMatter={onOpenMatter}
        />
      </div>
    </CapiroDrawer>
  );
}

type Fill = ReturnType<typeof useClientFillWithMeri>;

const FILE_CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/plain',
};

function contentTypeFor(name: string): string | null {
  const extension = name.trim().toLowerCase().split('.').pop() ?? '';
  return FILE_CONTENT_TYPES[extension] ?? null;
}

function documentAttachmentId(sourceStates: Record<string, unknown> | undefined): string | null {
  const state = sourceStates?.client_document;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const attachmentId = (state as { attachmentId?: unknown }).attachmentId;
  return typeof attachmentId === 'string' && attachmentId.length > 0 ? attachmentId : null;
}

function FillBody({
  fill,
  onClose,
  onRetry,
  onStart,
  matterOptions,
  onOpenMatter,
}: {
  fill: Fill;
  onClose: () => void;
  onRetry: () => void;
  onStart: () => void;
  matterOptions: AdvocacyMatterSummary[];
  onOpenMatter?: (matterId: string) => void;
}) {
  switch (fill.phase) {
    case 'idle':
      return (
        <div className="capiro-crm-fill__state">
          <p className="capiro-crm__foot">Ready to look for missing and outdated profile data.</p>
          <CapiroButton variant="primary" size="compact" onClick={onStart}>
            Start enrichment
          </CapiroButton>
        </div>
      );

    case 'preparing':
      return <FillProgress label="Preparing" detail="Collecting what Capiro already knows…" />;

    case 'researching':
      return (
        <FillProgress
          label="Researching"
          detail="Reading the selected document or connected sources. This can take a minute."
        />
      );

    case 'permission-denied':
      return (
        <div className="capiro-crm-fill__state capiro-crm__state--error">
          <p className="capiro-crm__foot">
            You do not have permission to run or apply enrichment for this client. An
            administrator can review and apply proposed changes.
          </p>
          <CapiroButton variant="secondary" size="compact" onClick={onClose}>
            Close
          </CapiroButton>
        </div>
      );

    case 'failed':
      return (
        <div className="capiro-crm-fill__state capiro-crm__state--error">
          <p className="capiro-crm__foot">
            {fill.run?.error ?? errorText(fill.startError, 'The enrichment run failed.')}
          </p>
          <CapiroButton variant="secondary" size="compact" onClick={onRetry}>
            Try again
          </CapiroButton>
        </div>
      );

    case 'no-changes':
      return (
        <div className="capiro-crm-fill__state">
          <p className="capiro-crm__foot">
            Meri found nothing worth changing — the profile already matches every source it
            could read.
          </p>
          {fill.failedSources.length > 0 ? <SourceWarning sources={fill.failedSources} /> : null}
          <CapiroButton variant="secondary" size="compact" onClick={onStart}>
            Run again
          </CapiroButton>
        </div>
      );

    case 'context-only':
      return (
        <div className="capiro-crm-fill__state">
          <p className="capiro-crm__foot">
            No applyable profile fields yet. Meri did find related context you can review below
            (LDA, program elements, bill tracker).
          </p>
          {fill.failedSources.length > 0 ? <SourceWarning sources={fill.failedSources} /> : null}
          <ContextFindings findings={fill.contextFindings} />
          <CapiroButton variant="secondary" size="compact" onClick={onStart}>
            Run again
          </CapiroButton>
        </div>
      );

    case 'applying':
      return <FillProgress label="Applying" detail="Writing the selected changes…" />;

    case 'applied':
      return (
        <div className="capiro-crm-fill__state">
          <p className="capiro-crm__foot">
            Applied {fill.applyOutcome?.applied ?? 0} change
            {fill.applyOutcome?.applied === 1 ? '' : 's'}. The profile has been reloaded.
          </p>
          <CapiroButton variant="secondary" size="compact" onClick={onClose}>
            Done
          </CapiroButton>
        </div>
      );

    case 'apply-partial':
      return (
        <div className="capiro-crm-fill__state capiro-crm__state--error">
          <p className="capiro-crm__foot">
            Applied {fill.applyOutcome?.applied ?? 0}, but {fill.applyOutcome?.failed ?? 0} could
            not be written. The ones that failed are still listed as proposals.
          </p>
          <CapiroButton variant="secondary" size="compact" onClick={() => fill.reset()}>
            Review remaining
          </CapiroButton>
        </div>
      );

    case 'partial':
    case 'proposals':
    default:
      return <FillProposals fill={fill} matterOptions={matterOptions} onOpenMatter={onOpenMatter} />;
  }
}

function FillProgress({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="capiro-crm-fill__state" role="status" aria-live="polite">
      <p className="capiro-crm__meta">{label}</p>
      <p className="capiro-crm__foot">{detail}</p>
      <div className="capiro-crm__skeleton" style={{ height: 56 }} aria-hidden />
      <div className="capiro-crm__skeleton" style={{ height: 56 }} aria-hidden />
    </div>
  );
}

function SourceWarning({ sources }: { sources: string[] }) {
  return (
    <p className="capiro-crm__foot capiro-crm-fill__warning">
      {/* Partial is reported, never hidden — a source that failed is not a
          source that found nothing. */}
      Could not read: {sources.map(sourceLabel).join(', ')}. These results are incomplete.
    </p>
  );
}

/** Findings this drawer treats as Advocacy History (product spec §22/23)
 *  rather than a generic client-profile field proposal. Matches the two
 *  `kind`s the backend's advocacy_history Fill source actually emits —
 *  see client-profile-fill-completion.service.ts gatherAdvocacyHistory*. */
function isAdvocacyFinding(finding: FillFinding): boolean {
  return finding.kind === 'advocacy_record' || finding.kind === 'advocacy_outcome';
}

function FillProposals({
  fill,
  matterOptions,
  onOpenMatter,
}: {
  fill: Fill;
  matterOptions: AdvocacyMatterSummary[];
  onOpenMatter?: (matterId: string) => void;
}) {
  const { proposals, selected } = fill;
  const allSelected = proposals.length > 0 && selected.size === proposals.length;
  const advocacyProposals = proposals.filter(isAdvocacyFinding);
  const otherProposals = proposals.filter((finding) => !isAdvocacyFinding(finding));

  return (
    <>
      {fill.failedSources.length > 0 ? <SourceWarning sources={fill.failedSources} /> : null}

      <div className="capiro-crm-fill__toolbar">
        <p className="capiro-crm__meta">
          {proposals.length} proposed change{proposals.length === 1 ? '' : 's'} · {selected.size}{' '}
          selected
        </p>
        <span className="capiro-crm__page-head-spacer" />
        <CapiroButton variant="quiet" size="compact" onClick={() => fill.setAll(!allSelected)}>
          {allSelected ? 'Clear all' : 'Select all'}
        </CapiroButton>
      </div>

      {/* §22: Advocacy History gets its own review group instead of being
          lumped into the generic client-profile-field list — a lobbying
          filing or a detected outcome is a fundamentally different kind of
          proposal than "update the company website". */}
      {advocacyProposals.length > 0 ? (
        <div className="capiro-crm-fill__group">
          <p className="capiro-crm__meta capiro-crm-fill__group-title">
            Advocacy History · {advocacyProposals.length} found
          </p>
          <ul className="capiro-crm-fill__list">
            {advocacyProposals.map((finding) => (
              <AdvocacyFindingRow
                key={finding.id}
                finding={finding}
                checked={selected.has(finding.id)}
                onToggle={() => fill.toggle(finding.id)}
                onNotAdvocacy={() => fill.rejectFinding(finding.id, 'Not advocacy (reviewed in Fill with Meri)')}
                matterOptions={matterOptions}
                onAssignMatter={
                  finding.kind === 'advocacy_record'
                    ? (target) => fill.assignFindingMatter(finding.id, target)
                    : undefined
                }
                onOpenMatter={onOpenMatter}
              />
            ))}
          </ul>
        </div>
      ) : null}

      {otherProposals.length > 0 ? (
        <div className="capiro-crm-fill__group">
          {advocacyProposals.length > 0 ? (
            <p className="capiro-crm__meta capiro-crm-fill__group-title">Other proposed changes</p>
          ) : null}
          <ul className="capiro-crm-fill__list">
            {otherProposals.map((finding) => (
              <FindingRow
                key={finding.id}
                finding={finding}
                checked={selected.has(finding.id)}
                onToggle={() => fill.toggle(finding.id)}
              />
            ))}
          </ul>
        </div>
      ) : null}

      {fill.contextFindings.length > 0 ? <ContextFindings findings={fill.contextFindings} /> : null}

      {fill.applyError ? (
        <p className="capiro-crm__foot capiro-crm__state--error">
          {errorText(fill.applyError, 'Could not apply the selected changes.')}
        </p>
      ) : null}

      <div className="capiro-crm-fill__actions">
        <CapiroButton
          variant="primary"
          size="compact"
          disabled={selected.size === 0}
          onClick={fill.applySelected}
        >
          Apply selected
        </CapiroButton>
        <CapiroButton variant="secondary" size="compact" onClick={fill.applyAll}>
          Apply all
        </CapiroButton>
      </div>
    </>
  );
}

function ContextFindings({ findings }: { findings: FillFinding[] }) {
  if (!findings.length) return null;
  return (
    <div className="capiro-crm-fill__context">
      <p className="capiro-crm__meta">Related context</p>
      <ul className="capiro-crm-fill__list">
        {findings.slice(0, 20).map((finding) => (
          <li key={finding.id} className="capiro-crm-fill__item">
            <div className="capiro-crm-fill__item-body">
              <p className="capiro-crm-fill__field">{humanizeKey(finding.targetKey)}</p>
              <p className="capiro-crm__foot">{formatValue(finding.proposedValue) ?? '—'}</p>
              <div className="capiro-crm-fill__meta">
                <CapiroBadge tone="info">CONTEXT</CapiroBadge>
                <span className="capiro-crm__meta">{sourceLabel(finding.source)}</span>
                <span className="capiro-crm__meta">
                  {Math.round(finding.confidence * 100)}% confidence
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FindingRow({
  finding,
  checked,
  onToggle,
}: {
  finding: FillFinding;
  checked: boolean;
  onToggle: () => void;
}) {
  const freshness = freshnessOf(finding);
  const inputId = `fill-${finding.id}`;

  return (
    <li className="capiro-crm-fill__item">
      <input
        id={inputId}
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="capiro-crm-fill__check"
      />
      <div className="capiro-crm-fill__item-body">
        <label htmlFor={inputId} className="capiro-crm-fill__field">
          {humanizeKey(finding.targetKey)}
        </label>

        {/* before → after, always both, so nothing is overwritten unseen. */}
        <div className="capiro-crm-fill__diff">
          <span className="capiro-crm-fill__before">
            {formatValue(finding.currentValue) ?? <em>not set</em>}
          </span>
          <span className="capiro-crm-fill__arrow" aria-hidden>
            →
          </span>
          <span className="capiro-crm-fill__after">{formatValue(finding.proposedValue) ?? '—'}</span>
        </div>

        <div className="capiro-crm-fill__meta">
          <CapiroBadge tone={finding.factKind === 'recommendation' ? 'info' : 'neutral'}>
            {finding.factKind === 'recommendation' ? 'SUGGESTION' : 'FACT'}
          </CapiroBadge>
          <span className="capiro-crm__meta">{sourceLabel(finding.source)}</span>
          <span className="capiro-crm__meta">
            {Math.round(finding.confidence * 100)}% confidence
          </span>
          {freshness ? <span className="capiro-crm__meta">{freshness}</span> : null}
        </div>

        {finding.evidence.length > 0 ? (
          <ul className="capiro-crm-fill__evidence">
            {finding.evidence.slice(0, 2).map((item, index) => (
              <li key={`${finding.id}-ev-${index}`}>
                {item.url ? (
                  <a href={item.url} target="_blank" rel="noreferrer noopener">
                    {item.label}
                  </a>
                ) : (
                  item.label
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

/** §22/23: Advocacy History finding review card. Distinct from the generic
 *  `FindingRow` because an advocacy finding is not "propose a value for a
 *  named field" — it is "a lobbying filing / outreach send / detected
 *  outcome was found; decide whether it belongs in Advocacy History at
 *  all". The checkbox still drives bulk Apply/Apply selected exactly like
 *  any other finding (accepting = create the client_advocacy_record row,
 *  auto-clustered into a Matter server-side); "Not advocacy" is the one
 *  action a generic FindingRow has no equivalent for.
 *
 *  Matter/target-Matter assignment ("Attach to existing Matter" / "Create
 *  Matter" from §22/23) is intentionally NOT implemented on this pending-
 *  finding card yet — deferred pending a product decision on whether
 *  picking a Matter here should tag-then-apply-later or apply immediately
 *  as its own action. Today, accepting via the checkbox + Apply still goes
 *  through the existing deterministic auto-clustering
 *  (assignMatterForRecord), which is a safe default; the reviewer can
 *  correct the resulting Matter assignment afterward from the Matters tab
 *  (reassign/detach/merge — shipped in an earlier closeout slice). */
function AdvocacyFindingRow({
  finding,
  checked,
  onToggle,
  onNotAdvocacy,
  matterOptions,
  onAssignMatter,
  onOpenMatter,
}: {
  finding: FillFinding;
  checked: boolean;
  onToggle: () => void;
  onNotAdvocacy: () => void;
  matterOptions: AdvocacyMatterSummary[];
  /** Undefined for advocacy_outcome findings — there is no standalone
   *  record here to attach directly; an outcome always links through an
   *  already-applied advocacy_record's Matter instead. */
  onAssignMatter?: (
    target: { matterId: string } | { newMatter: { title: string; matterType?: string; summary?: string | null } },
  ) => Promise<{ findingId: string; matterId: string | null; alreadyApplied: boolean }>;
  onOpenMatter?: (matterId: string) => void;
}) {
  const inputId = `fill-advocacy-${finding.id}`;
  const proposed = finding.proposedValue as Record<string, unknown> | null | undefined;
  const title =
    (typeof proposed?.title === 'string' && proposed.title) ||
    (typeof proposed?.label === 'string' && proposed.label) ||
    humanizeKey(finding.targetKey);
  const activityDate =
    (typeof proposed?.date === 'string' && proposed.date) ||
    (typeof proposed?.observedAt === 'string' && proposed.observedAt) ||
    null;
  const isOutcome = finding.kind === 'advocacy_outcome';

  const [assigning, setAssigning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  // Non-optimistic by design (per §22/23 follow-up requirement): this
  // write creates/locks real server state (a Matter, a record's
  // matter_id, the finding's accepted status) that cannot be cleanly
  // rolled back on the client if the request fails partway — so the UI
  // shows a short "Applying…" state and only reflects the change once the
  // server confirms, rather than assuming success and unwinding later.
  const handleAssign = async (target: { matterId: string } | { newMatter: { title: string } }) => {
    if (!onAssignMatter) return;
    setApplying(true);
    setAssignError(null);
    try {
      const result = await onAssignMatter(target);
      setAssigning(false);
      if (result.matterId) onOpenMatter?.(result.matterId);
    } catch (error) {
      setAssignError(errorText(error, 'Could not assign this finding to a matter.'));
    } finally {
      setApplying(false);
    }
  };

  return (
    <li className="capiro-crm-fill__item capiro-crm-fill__item--advocacy">
      <input
        id={inputId}
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="capiro-crm-fill__check"
      />
      <div className="capiro-crm-fill__item-body">
        <label htmlFor={inputId} className="capiro-crm-fill__field">
          {title}
        </label>

        <div className="capiro-crm-fill__meta">
          <CapiroBadge tone={isOutcome ? 'success' : 'info'}>
            {isOutcome ? 'OUTCOME' : 'ADVOCACY'}
          </CapiroBadge>
          <span className="capiro-crm__meta">{sourceLabel(finding.source)}</span>
          <span className="capiro-crm__meta">{Math.round(finding.confidence * 100)}% confidence</span>
          {activityDate ? <span className="capiro-crm__meta">{formatValue(activityDate)}</span> : null}
        </div>

        {finding.evidence.length > 0 ? (
          <ul className="capiro-crm-fill__evidence">
            {finding.evidence.slice(0, 2).map((item, index) => (
              <li key={`${finding.id}-ev-${index}`}>
                {item.url ? (
                  <a href={item.url} target="_blank" rel="noreferrer noopener">
                    {item.label}
                  </a>
                ) : (
                  item.label
                )}
              </li>
            ))}
          </ul>
        ) : null}

        {/* §17 causality contract: an outcome finding is never framed as
            confirmed causation before a human accepts it either. */}
        {isOutcome ? (
          <p className="capiro-crm__foot capiro-crm-fill__disclaimer">
            This may be a related outcome. Applying it does not claim advocacy caused it.
          </p>
        ) : null}

        <div className="capiro-crm-fill__row-actions">
          {onAssignMatter ? (
            <CapiroButton variant="quiet" size="compact" disabled={applying} onClick={() => setAssigning(true)}>
              Attach to Matter…
            </CapiroButton>
          ) : null}
          <CapiroButton variant="quiet" size="compact" disabled={applying} onClick={onNotAdvocacy}>
            Not advocacy
          </CapiroButton>
        </div>
      </div>

      {assigning ? (
        <CapiroModal open title="Attach to a Matter" onClose={() => setAssigning(false)}>
          <AssignFindingMatterForm
            findingTitle={title}
            matterOptions={matterOptions}
            busy={applying}
            error={assignError}
            onCancel={() => setAssigning(false)}
            onAttach={(matterId) => handleAssign({ matterId })}
            onCreate={(newTitle) => handleAssign({ newMatter: { title: newTitle } })}
          />
        </CapiroModal>
      ) : null}
    </li>
  );
}

/** §22/23 follow-up: the picker shown when a reviewer clicks "Attach to
 *  Matter…" on a still-pending advocacy finding. Mirrors
 *  `RecordActionForm`'s reassign UI in AdvocacyMattersTab.tsx (existing-
 *  Matter select) plus a "create new" toggle for the other half of the
 *  same action — picking a target Matter and creating one are the same
 *  decision from the reviewer's point of view, not two different flows. */
function AssignFindingMatterForm({
  findingTitle,
  matterOptions,
  busy,
  error,
  onCancel,
  onAttach,
  onCreate,
}: {
  findingTitle: string;
  matterOptions: AdvocacyMatterSummary[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onAttach: (matterId: string) => void;
  onCreate: (title: string) => void;
}) {
  const [mode, setMode] = useState<'existing' | 'new'>(matterOptions.length > 0 ? 'existing' : 'new');
  const [matterId, setMatterId] = useState('');
  const [newTitle, setNewTitle] = useState(findingTitle);

  return (
    <div className="capiro-crm-fill__assign-matter">
      <p className="capiro-crm__foot">
        This applies the finding immediately — the same as ticking it and clicking Apply, plus
        assigning it to the matter you choose here. It is not a draft; there is nothing to review
        again afterward besides the usual reassign/detach correction on the Matters tab.
      </p>

      {matterOptions.length > 0 ? (
        <div className="capiro-crm-fill__assign-matter-mode" role="radiogroup" aria-label="Matter target">
          <label>
            <input
              type="radio"
              name="assign-matter-mode"
              checked={mode === 'existing'}
              onChange={() => setMode('existing')}
              disabled={busy}
            />
            Attach to an existing matter
          </label>
          <label>
            <input
              type="radio"
              name="assign-matter-mode"
              checked={mode === 'new'}
              onChange={() => setMode('new')}
              disabled={busy}
            />
            Create a new matter
          </label>
        </div>
      ) : (
        <p className="capiro-crm__meta">No matters exist for this client yet — this will create the first one.</p>
      )}

      {mode === 'existing' && matterOptions.length > 0 ? (
        <select value={matterId} onChange={(event) => setMatterId(event.target.value)} disabled={busy}>
          <option value="">Select a matter…</option>
          {matterOptions.map((matter) => (
            <option key={matter.id} value={matter.id}>
              {matter.title}
            </option>
          ))}
        </select>
      ) : (
        <label className="capiro-crm-fill__field">
          Matter title
          <input
            type="text"
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            disabled={busy}
            maxLength={300}
          />
        </label>
      )}

      {error ? <p className="capiro-crm__foot capiro-crm__state--error">{error}</p> : null}

      <div className="capiro-crm-fill__actions">
        <CapiroButton variant="secondary" size="compact" onClick={onCancel} disabled={busy}>
          Cancel
        </CapiroButton>
        {mode === 'existing' && matterOptions.length > 0 ? (
          <CapiroButton
            variant="primary"
            size="compact"
            disabled={busy || !matterId}
            onClick={() => onAttach(matterId)}
          >
            {busy ? 'Applying…' : 'Attach'}
          </CapiroButton>
        ) : (
          <CapiroButton
            variant="primary"
            size="compact"
            disabled={busy || !newTitle.trim()}
            onClick={() => onCreate(newTitle.trim())}
          >
            {busy ? 'Applying…' : 'Create matter'}
          </CapiroButton>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────── formatting ──────────────────────────────── */

const SOURCE_LABELS: Record<string, string> = {
  public_web: 'Public web',
  website: 'Client website',
  synced_email: 'Synced email',
  sam_gov: 'SAM.gov',
  lda: 'LDA filings',
  program_elements: 'Program elements',
  bill_tracker: 'Bill tracker',
  client_document: 'Capability document',
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.replace(/_/g, ' ');
}

/** `intakeData.samExpirationDate` → "Sam expiration date". */
function humanizeKey(key: string): string {
  const leaf = key.split('.').pop() ?? key;
  const spaced = leaf.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function formatValue(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((entry) => formatValue(entry) ?? '—').join(', ');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const name = record.name ?? record.title ?? record.label;
    if (typeof name === 'string') return name;
    return Object.entries(record)
      .filter(([, entry]) => entry != null && entry !== '')
      .map(([key, entry]) => `${humanizeKey(key)}: ${formatValue(entry)}`)
      .join(' · ');
  }
  return String(value);
}

/** Freshness where the evidence actually carries an observation date. */
function freshnessOf(finding: FillFinding): string | null {
  const observed = finding.evidence.map((item) => item.observedAt).filter(Boolean)[0];
  if (!observed) return null;
  const date = new Date(observed);
  if (Number.isNaN(date.getTime())) return null;
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return 'Seen today';
  if (days === 1) return 'Seen yesterday';
  if (days < 45) return `Seen ${days} days ago`;
  // Stale sources are labelled, not silently treated as current.
  return `Stale · ${date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;
}
