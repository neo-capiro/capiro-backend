import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CapiroButton } from '../../../components/actions/index.js';
import { useApi } from '../../../../lib/use-api.js';
import { api } from '../api/client.js';
import type {
  BlueprintSummary,
  BlueprintVersionSummary,
  DraftSummary,
  RecommendResponse,
} from '../types/agent.js';
import { submitIntake, getTwoStepDraftCapability, type IntakeRequest } from './intake-client.js';
import '../styles/workspace.css';
import '../styles/workspace-audit.css';
import '../styles/workspace-quick-draft.css';

// ── Constants ──────────────────────────────────────────────────────────────

// Mirrors the canonical attachment pipeline (25 MB). The server extracts text
// from .txt/.csv/.pdf/.docx/.xlsx — the browser never reads file bodies.
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_PASTED_CHARS = 50_000;

interface ClientOption { id: string; name: string; industry?: string | null; }
type UploadStatus = 'uploading' | 'scanning' | 'extracting' | 'ready' | 'failed';

interface AttachmentUpload {
  id: string;
  name: string;
  size: number;
  status: UploadStatus;
  /** Server attachment id, present once the upload is confirmed. */
  attachmentId?: string;
  message?: string;
}

interface ContextDomain { id: string; label: string; description: string; enabled: boolean; }

/**
 * The real Capiro context domains. For this PR only `client-profile` and
 * `institutional-memory` are ENABLED; the rest render disabled with a
 * “Not available yet” notice and are never default-selected.
 */
const CONTEXT_DOMAINS: ContextDomain[] = [
  { id: 'client-profile', label: 'Client profile', description: 'Company, capabilities, goals, terminology and approved positioning.', enabled: true },
  { id: 'institutional-memory', label: 'Institutional memory', description: 'Approved firm, client and user memories relevant to the request.', enabled: true },
  { id: 'strategies', label: 'Strategies & priorities', description: 'Current strategies, priorities, desired outcomes and active work.', enabled: false },
  { id: 'relationships', label: 'Relationships & targets', description: 'Government relationships, current targets and relationship context.', enabled: false },
  { id: 'activity', label: 'Engagement history', description: 'Meetings, outreach, commitments, notes and follow-up history.', enabled: false },
  { id: 'mailbox', label: 'Mailbox & correspondence', description: 'Relevant email history, commitments, requests and prior language.', enabled: false },
  { id: 'client-files', label: 'Client files & notes', description: 'Saved files, notes and working materials from the client record.', enabled: false },
];

const ENABLED_DOMAIN_IDS = new Set(
  CONTEXT_DOMAINS.filter((d) => d.enabled).map((d) => d.id),
);

// ── Pure helpers (kept outside the component for testability) ────────────────

function latestPublishedVersion(blueprint: BlueprintSummary): BlueprintVersionSummary | null {
  return (
    (blueprint.versions ?? [])
      .filter((v) => v.status === 'published')
      .sort((a, b) => b.version - a.version)[0] ?? null
  );
}

function safeTitle(value: string, fallback: string): string {
  const line = value.trim().split(/\n/)[0]?.trim() ?? '';
  if (!line) return fallback;
  return line.length > 82 ? `${line.slice(0, 79)}…` : line;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return (error as { message?: string } | null)?.message ?? fallback;
}

/** Normalize the /api/clients payload into the option shape used by the UI. */
function toClientOptions(raw: unknown): ClientOption[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { clients?: unknown[] } | null)?.clients)
      ? (raw as { clients: unknown[] }).clients
      : [];
  return list
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object')
    .map((c) => ({
      id: String(c.id ?? ''),
      name: String(c.name ?? 'Unnamed client'),
      industry: typeof c.industry === 'string' ? c.industry : null,
    }))
    .filter((c) => c.id);
}

/**
 * Prior Workspace drafts for the selected client, filtered by `config.clientId`
 * (per the aggregate-intake contract). Drafts are fetched with `scope: 'mine'`
 * and filtered client-side.
 */
function draftsForClient(drafts: DraftSummary[], clientId: string): DraftSummary[] {
  return drafts.filter((d) => {
    const config = d.config as Record<string, unknown> | undefined;
    return String(config?.clientId ?? '') === clientId;
  });
}

function statusLabel(status: UploadStatus): string {
  switch (status) {
    case 'uploading': return 'Uploading…';
    case 'scanning': return 'Scanning…';
    case 'extracting': return 'Extracting text…';
    case 'ready': return 'Ready';
    case 'failed': return 'Failed';
  }
}

/**
 * Assemble the aggregate intake request. Only browser-authored pasted text
 * (`pastedContext` / `pastedSample`) is sent as body content — every file is
 * referenced by its server attachment id, every prior draft by its draft id.
 * Disabled context domains are filtered out.
 */
function buildIntakeRequest(args: {
  goal: string;
  clientId?: string;
  blueprintVersionId: string;
  relevantUploads: AttachmentUpload[];
  sampleUploads: AttachmentUpload[];
  priorWorkspaceDraftIds: string[];
  selectedDomains: Set<string>;
  pastedContext: string;
  pastedSample: string;
  title?: string;
}): IntakeRequest {
  const ready = (uploads: AttachmentUpload[]) =>
    uploads.filter((u) => u.status === 'ready' && u.attachmentId).map((u) => u.attachmentId as string);
  const selectedContextDomains = Array.from(args.selectedDomains).filter((id) =>
    ENABLED_DOMAIN_IDS.has(id),
  );
  const intake: IntakeRequest = {
    goal: args.goal,
    blueprintVersionId: args.blueprintVersionId,
    factualAttachmentIds: ready(args.relevantUploads),
    sampleAttachmentIds: ready(args.sampleUploads),
    priorWorkspaceDraftIds: args.priorWorkspaceDraftIds,
    selectedContextDomains,
  };
  if (args.clientId) intake.clientId = args.clientId;
  const pastedContext = args.pastedContext.trim();
  if (pastedContext) intake.pastedContext = pastedContext.slice(0, MAX_PASTED_CHARS);
  const pastedSample = args.pastedSample.trim();
  if (pastedSample) intake.pastedSample = pastedSample.slice(0, MAX_PASTED_CHARS);
  if (args.title) intake.title = args.title;
  return intake;
}

// ── Subcomponent ────────────────────────────────────────────────────────────

function AttachmentUploadList({ uploads, onRemove }: {
  uploads: AttachmentUpload[];
  onRemove: (id: string) => void;
}) {
  if (!uploads.length) return null;
  return (
    <ul className="ws-quick-file-list">
      {uploads.map((upload) => {
        const removable = upload.status === 'ready' || upload.status === 'failed';
        return (
          <li key={upload.id}>
            <span>
              <strong>{upload.name}</strong>
              <em>
                {Math.max(1, Math.round(upload.size / 1024))} KB · {statusLabel(upload.status)}
                {upload.status === 'failed' && upload.message ? ` · ${upload.message}` : ''}
              </em>
            </span>
            {removable ? <button type="button" onClick={() => onRemove(upload.id)}>Remove</button> : null}
          </li>
        );
      })}
    </ul>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export function WorkspaceQuickDraftCreation() {
  const navigate = useNavigate();
  const coreApi = useApi();

  const [goal, setGoal] = useState('');
  const [clientId, setClientId] = useState('');
  const [selectedBlueprintId, setSelectedBlueprintId] = useState('');
  const [recommendation, setRecommendation] = useState<RecommendResponse | null>(null);
  const [relevantUploads, setRelevantUploads] = useState<AttachmentUpload[]>([]);
  const [sampleUploads, setSampleUploads] = useState<AttachmentUpload[]>([]);
  const [relevantPaste, setRelevantPaste] = useState('');
  const [samplePaste, setSamplePaste] = useState('');
  const [selectedSavedDocs, setSelectedSavedDocs] = useState<Set<string>>(new Set());
  // Default-select only ENABLED domains (client-profile). Disabled domains are
  // never default-selected.
  const [selectedDomains, setSelectedDomains] = useState<Set<string>>(new Set(['client-profile']));
  const [recommending, setRecommending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  // ── Data fetching (react-query) ──────────────────────────────────────────

  const blueprintsQuery = useQuery({
    queryKey: ['workspace-blueprints'],
    queryFn: () => api.listBlueprints(),
  });
  const draftsQuery = useQuery({
    queryKey: ['workspace-drafts', 'mine'],
    queryFn: () => api.listDrafts({ scope: 'mine' }),
  });
  const clientsQuery = useQuery({
    queryKey: ['workspace-quick-draft-clients'],
    queryFn: async () => (await coreApi.get('/api/clients')).data,
    staleTime: 60_000,
  });
  // The two-step Max draft capability is also gated at the route. Re-check here
  // so a stale gate surfaces gracefully instead of a failed submit.
  const capabilityQuery = useQuery({
    queryKey: ['two-step-draft-capability'],
    queryFn: () => getTwoStepDraftCapability(),
    staleTime: 5 * 60_000,
  });
  const capabilityDisabled = Boolean(capabilityQuery.data && !capabilityQuery.data.enabled);

  const blueprints = blueprintsQuery.data?.blueprints ?? [];
  const drafts = draftsQuery.data?.drafts ?? [];
  const clients = useMemo(() => toClientOptions(clientsQuery.data), [clientsQuery.data]);

  // ── Derived selections ───────────────────────────────────────────────────

  const selectedClient = useMemo(
    () => clients.find((c) => c.id === clientId) ?? null,
    [clientId, clients],
  );
  const publishedBlueprints = useMemo(
    () => blueprints.filter((b) => latestPublishedVersion(b)),
    [blueprints],
  );
  const selectedBlueprint = useMemo(
    () => publishedBlueprints.find((b) => b.blueprintId === selectedBlueprintId) ?? null,
    [publishedBlueprints, selectedBlueprintId],
  );
  const clientSavedDocs = useMemo(
    () => (selectedClient ? draftsForClient(drafts, selectedClient.id) : []),
    [drafts, selectedClient],
  );
  const uploadsInFlight = useMemo(
    () =>
      [...relevantUploads, ...sampleUploads].some(
        (u) => u.status === 'uploading' || u.status === 'scanning' || u.status === 'extracting',
      ),
    [relevantUploads, sampleUploads],
  );
  const readyUploadCount =
    relevantUploads.filter((u) => u.status === 'ready').length +
    sampleUploads.filter((u) => u.status === 'ready').length;
  const selectedSourceCount =
    readyUploadCount +
    selectedSavedDocs.size +
    Array.from(selectedDomains).filter((id) => ENABLED_DOMAIN_IDS.has(id)).length +
    (relevantPaste.trim() ? 1 : 0) +
    (samplePaste.trim() ? 1 : 0);

  // Default-select the first published blueprint once the catalog resolves.
  useEffect(() => {
    if (selectedBlueprintId || !publishedBlueprints.length) return;
    setSelectedBlueprintId(publishedBlueprints[0]?.blueprintId ?? '');
  }, [publishedBlueprints, selectedBlueprintId]);

  // Reset saved-doc selections whenever the client changes.
  useEffect(() => {
    setSelectedSavedDocs(new Set());
  }, [clientId]);

  // ── Attachment uploads (presigned S3 → confirm → extract-text) ────────────
  //
  // The browser NEVER reads file bodies. Each file flows through the canonical
  // attachment pipeline and is referenced by its server attachment id in the
  // intake request. The backend re-fetches and authorizes every id.

  const setList = (target: 'relevant' | 'sample', updater: (list: AttachmentUpload[]) => AttachmentUpload[]) =>
    (target === 'relevant' ? setRelevantUploads : setSampleUploads)(updater);

  const uploadOne = async (file: File, target: 'relevant' | 'sample') => {
    const localId = `${file.name}:${file.lastModified}:${file.size}`;
    if (relevantUploads.some((u) => u.id === localId)) return;
    setList(target, (list) => [...list, { id: localId, name: file.name, size: file.size, status: 'uploading' }]);
    const patch = (next: Partial<AttachmentUpload>) =>
      setList(target, (list) => list.map((u) => (u.id === localId ? { ...u, ...next } : u)));

    try {
      const contentType = file.type || 'application/octet-stream';
      const presigned = (
        await coreApi.post<{ url: string; fields: Record<string, string>; s3Key: string }>(
          '/api/engagement/attachments/upload-url',
          { fileName: file.name, contentType, contentLength: file.size, clientId: clientId || undefined },
        )
      ).data;
      const form = new FormData();
      Object.entries(presigned.fields).forEach(([key, value]) => form.append(key, value));
      form.append('file', file);
      const s3 = await fetch(presigned.url, { method: 'POST', body: form });
      if (!s3.ok) throw new Error('Storage rejected the upload');

      patch({ status: 'scanning' });
      const confirmed = (
        await coreApi.post<{ id: string }>('/api/engagement/attachments/confirm', {
          fileName: file.name,
          contentType,
          s3Key: presigned.s3Key,
          clientId: clientId || undefined,
        })
      ).data;

      patch({ status: 'extracting', attachmentId: confirmed.id });
      try {
        await coreApi.post(`/api/engagement/attachments/${encodeURIComponent(confirmed.id)}/extract-text`);
      } catch {
        // Attachment is stored; the backend re-extracts server-side during intake.
      }
      patch({ status: 'ready' });
    } catch (caught) {
      patch({ status: 'failed', message: errorMessage(caught, 'Upload failed') });
    }
  };

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>, target: 'relevant' | 'sample') => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!picked.length) return;
    setFileError(null);
    const rejected: string[] = [];
    for (const file of picked) {
      if (file.size > MAX_FILE_BYTES) {
        rejected.push(`${file.name} (larger than ${MAX_FILE_BYTES / 1024 / 1024} MB)`);
        continue;
      }
      void uploadOne(file, target); // parallel uploads
    }
    if (rejected.length) setFileError(`Not added: ${rejected.join(', ')}.`);
  };

  // ── Recommend a template (still uses the /recommend workspace endpoint) ──

  const recommendTemplate = async () => {
    if (!goal.trim() || recommending) return;
    setRecommending(true);
    setError(null);
    try {
      const result = await api.recommend(goal.trim(), selectedClient?.name);
      setRecommendation(result);
      const recommended = result.recommendedBlueprints.find((item) =>
        publishedBlueprints.some((b) => b.blueprintId === item.blueprintId),
      );
      if (recommended) setSelectedBlueprintId(recommended.blueprintId);
    } catch (caught) {
      setError(errorMessage(caught, 'Meri could not recommend a template. You can still choose one manually.'));
    } finally {
      setRecommending(false);
    }
  };

  // ── Aggregate intake submit → immediate redirect to the editor ──────────

  const handleSubmit = async () => {
    if (!goal.trim() || !selectedBlueprint || submitting) return;
    const publishedVersion = latestPublishedVersion(selectedBlueprint);
    if (!publishedVersion) {
      setError('Select a published template version.');
      return;
    }
    if (uploadsInFlight) {
      setError('Wait for the uploaded files to finish processing.');
      return;
    }

    // Idempotency key is generated client-side. Fail gracefully if the
    // environment cannot produce one rather than sending an unkeyed request.
    const idempotencyKey =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : '';
    if (!idempotencyKey) {
      setError('Could not generate a request key. Please reload and try again.');
      return;
    }

    setSubmitting(true);
    setError(null);
    setRedirecting(false);
    try {
      const title = safeTitle(
        goal,
        selectedClient ? `${selectedBlueprint.name} — ${selectedClient.name}` : selectedBlueprint.name,
      );
      const intake = buildIntakeRequest({
        goal: goal.trim(),
        clientId: selectedClient?.id,
        blueprintVersionId: publishedVersion.versionId,
        relevantUploads,
        sampleUploads,
        priorWorkspaceDraftIds: Array.from(selectedSavedDocs),
        selectedDomains,
        pastedContext: relevantPaste,
        pastedSample: samplePaste,
        title,
      });
      const response = await submitIntake(intake, idempotencyKey);

      // 202 received — navigate to the editor immediately. The editor polls the
      // run status and hydrates stages/sections. Show a brief redirect state so
      // the transition is not a blank flash.
      setRedirecting(true);
      window.setTimeout(() => navigate(`/workspace/${response.draftId}`, { replace: true }), 500);
    } catch (caught) {
      setError(errorMessage(caught, 'Workspace could not start this draft. Please try again.'));
      setSubmitting(false);
      setRedirecting(false);
    }
  };

  // ── Toggles ──────────────────────────────────────────────────────────────

  const toggleSavedDoc = (id: string) => {
    setSelectedSavedDocs((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleDomain = (id: string) => {
    if (!ENABLED_DOMAIN_IDS.has(id)) return; // only enabled domains are interactive
    setSelectedDomains((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const removeUpload = (target: 'relevant' | 'sample', id: string) =>
    setList(target, (list) => list.filter((u) => u.id !== id));

  const generateDisabled =
    !goal.trim() || !selectedBlueprint || submitting || uploadsInFlight || capabilityDisabled;
  const loadingTemplates = blueprintsQuery.isLoading;

  return (
    <div className="ws-vnext-creation ws-quick-intake">
      <header className="ws-quick-intake__header">
        <div>
          <div className="ws-audit-eyebrow">NEW DOCUMENT</div>
          <h1>Tell Meri what you need. Get the first draft next.</h1>
          <p>
            Choose a proven submission template, add the material that matters, and Meri will plan,
            draft, and edit the complete document with Max reasoning before opening Workspace.
          </p>
        </div>
        <CapiroButton variant="quiet" size="compact" onClick={() => navigate('/workspace')}>
          Cancel
        </CapiroButton>
      </header>

      {capabilityDisabled ? (
        <div className="ws-vnext-banner" data-variant="amber" role="status">
          <span className="ws-vnext-banner__text">
            Two-step Max draft isn’t enabled for your workspace yet. Contact an admin to enable it.
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="ws-vnext-banner" data-variant="red" role="alert">
          <span className="ws-vnext-banner__text">{error}</span>
          <span className="ws-quick-banner-actions">
            <button type="button" className="ws-vnext-banner__action" onClick={() => setError(null)}>
              Dismiss
            </button>
          </span>
        </div>
      ) : null}

      <main className="ws-quick-intake__body">
        <section className="ws-quick-goal-card">
          <div className="ws-quick-section-heading">
            <span>1</span>
            <div>
              <h2>What should this document accomplish?</h2>
              <p>Include the audience, the action you want, and why it matters now.</p>
            </div>
          </div>
          <textarea
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="Example: Create a two-page FY27 NDAA paper asking HASC staff to protect the Ground Robotics request and support accelerated fielding."
            autoFocus
          />
          <div className="ws-quick-goal-card__footer">
            <label>
              Client
              <select value={clientId} onChange={(event) => setClientId(event.target.value)}>
                <option value="">No client selected</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                    {client.industry ? ` · ${client.industry}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <CapiroButton
              variant="secondary"
              size="compact"
              disabled={!goal.trim() || recommending}
              loading={recommending}
              onClick={() => void recommendTemplate()}
            >
              Recommend a template
            </CapiroButton>
          </div>
          {recommendation ? (
            <div className="ws-quick-recommendation">
              <strong>Meri recommends {recommendation.documentType.label}</strong>
              <span>{recommendation.rationale}</span>
            </div>
          ) : null}
        </section>

        <section className="ws-quick-template-section">
          <div className="ws-quick-section-heading">
            <span>2</span>
            <div>
              <h2>Choose a submission template</h2>
              <p>
                Published Capiro and firm templates control structure, evidence rules, and the
                default document design.
              </p>
            </div>
            <button type="button" onClick={() => navigate('/workspace/studio')}>Create your own →</button>
          </div>
          {loadingTemplates ? (
            <div className="ws-quick-template-grid" aria-busy="true">
              {Array.from({ length: 4 }, (_, index) => (
                <div className="ws-quick-template-card" key={index}>
                  <div className="ws-vnext-skeleton-row" />
                  <div className="ws-vnext-skeleton-row" />
                </div>
              ))}
            </div>
          ) : publishedBlueprints.length ? (
            <div className="ws-quick-template-grid">
              {publishedBlueprints.map((blueprint) => {
                const version = latestPublishedVersion(blueprint);
                const selected = blueprint.blueprintId === selectedBlueprintId;
                return (
                  <button
                    type="button"
                    key={blueprint.blueprintId}
                    className="ws-quick-template-card"
                    data-selected={selected}
                    onClick={() => setSelectedBlueprintId(blueprint.blueprintId)}
                  >
                    <span className="ws-quick-template-card__meta">
                      {blueprint.scope === 'firm' ? 'FIRM' : 'CAPIRO'} · {blueprint.documentType || 'DOCUMENT'}
                    </span>
                    <strong>{blueprint.name}</strong>
                    <p>{blueprint.description || 'Firm-ready structure with governed evidence and content rules.'}</p>
                    <em>Published v{version?.version ?? '—'}</em>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="ws-vnext-empty">
              <div className="ws-vnext-empty__title">No published templates are available</div>
              <div className="ws-vnext-empty__desc">
                Publish a firm template in Template Studio before creating this document.
              </div>
            </div>
          )}
        </section>

        <section className="ws-quick-sources-section">
          <div className="ws-quick-section-heading">
            <span>3</span>
            <div>
              <h2>Give Meri the right material</h2>
              <p>Four simple source groups keep factual evidence separate from sample-writing references.</p>
            </div>
          </div>

          {fileError ? (
            <div className="ws-vnext-banner" data-variant="amber" role="status">
              <span className="ws-vnext-banner__text">{fileError}</span>
              <button type="button" className="ws-vnext-banner__action" onClick={() => setFileError(null)}>
                Dismiss
              </button>
            </div>
          ) : null}

          <div className="ws-quick-source-grid">
            <article className="ws-quick-source-card">
              <header><span>01</span><div><h3>Relevant context</h3><p>Anything you believe Meri should know or cite.</p></div></header>
              <label className="ws-quick-upload">
                Add files (PDF, DOCX, TXT, CSV, XLSX…)
                <input type="file" multiple onChange={(event) => void handleFiles(event, 'relevant')} />
              </label>
              <textarea
                value={relevantPaste}
                onChange={(event) => setRelevantPaste(event.target.value)}
                placeholder="Or paste relevant notes or source text…"
              />
              <AttachmentUploadList uploads={relevantUploads} onRemove={(id) => removeUpload('relevant', id)} />
            </article>

            <article className="ws-quick-source-card">
              <header><span>02</span><div><h3>Client saved documents</h3><p>Reuse prior Workspace documents already associated with this client.</p></div></header>
              {!selectedClient ? (
                <div className="ws-quick-source-empty">Choose a client above to see saved documents.</div>
              ) : clientSavedDocs.length ? (
                <div className="ws-quick-saved-docs">
                  {clientSavedDocs.map((draft) => (
                    <label key={draft.id}>
                      <input
                        type="checkbox"
                        checked={selectedSavedDocs.has(draft.id)}
                        onChange={() => toggleSavedDoc(draft.id)}
                      />
                      <span>
                        <strong>{draft.docTitle}</strong>
                        <em>
                          {draft.documentType || 'Workspace document'} ·{' '}
                          {new Date(draft.updatedAt).toLocaleDateString()}
                        </em>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <div className="ws-quick-source-empty">
                  No saved Workspace documents were found for {selectedClient.name}.
                </div>
              )}
            </article>

            <article className="ws-quick-source-card">
              <header><span>03</span><div><h3>Sample documents</h3><p>Examples Meri can study for structure, tone, and drafting quality—not factual evidence.</p></div></header>
              <label className="ws-quick-upload">
                Add sample files
                <input type="file" multiple onChange={(event) => void handleFiles(event, 'sample')} />
              </label>
              <textarea
                value={samplePaste}
                onChange={(event) => setSamplePaste(event.target.value)}
                placeholder="Or paste sample document text…"
              />
              <AttachmentUploadList uploads={sampleUploads} onRemove={(id) => removeUpload('sample', id)} />
              <div className="ws-quick-style-policy">
                STYLE ONLY · Samples cannot support factual claims and distinctive wording should not be copied.
              </div>
            </article>

            <article className="ws-quick-source-card">
              <header><span>04</span><div><h3>Capiro context</h3><p>Select the internal context domains Meri should use.</p></div></header>
              <div className="ws-quick-domain-grid">
                {CONTEXT_DOMAINS.map((domain) => {
                  const selected = selectedDomains.has(domain.id);
                  return (
                    <label key={domain.id} data-selected={selected} data-disabled={!domain.enabled ? true : undefined}>
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={!domain.enabled}
                        onChange={() => toggleDomain(domain.id)}
                      />
                      <span>
                        <strong>{domain.label}</strong>
                        <em>{domain.description}{!domain.enabled ? ' · Not available yet' : ''}</em>
                      </span>
                    </label>
                  );
                })}
              </div>
              <div className="ws-quick-style-policy">
                Only enabled domains are sent to Meri. The backend re-fetches and authorizes every selected context source.
              </div>
            </article>
          </div>
        </section>
      </main>

      <footer className="ws-quick-intake__footer">
        <div>
          <span>{selectedBlueprint ? selectedBlueprint.name : 'Choose a template'}</span>
          <strong>
            {selectedSourceCount} source selection{selectedSourceCount === 1 ? '' : 's'} · MAX REASONING
          </strong>
        </div>
        <CapiroButton
          variant="primary"
          disabled={generateDisabled}
          loading={submitting}
          onClick={() => void handleSubmit()}
        >
          Generate first draft
        </CapiroButton>
      </footer>

      {submitting || redirecting ? (
        <div className="ws-quick-generating" role="status" aria-live="polite">
          <div className="ws-quick-generating__card">
            <div className="ws-quick-generating__mark">M</div>
            <div className="ws-audit-eyebrow">MAX REASONING</div>
            <h2>{redirecting ? 'Opening editor…' : 'Starting your draft'}</h2>
            <p>
              {redirecting
                ? 'Workspace is opening the draft. The editor will hydrate each stage as Meri works.'
                : 'Submitting the intake and queuing the first-draft run.'}
            </p>
            <span>Keep this page open.</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
