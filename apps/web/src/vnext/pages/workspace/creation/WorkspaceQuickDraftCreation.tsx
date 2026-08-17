/**
 * Workspace vNext — New-document intake (design-handoff §6).
 *
 * One scrolling column, four numbered sections + a sticky footer. Section 3
 * (template questions) only exists once a template is chosen, so the material
 * section's number is computed (3 or 4). Wires the aggregate intake pipeline
 * (submitIntake + crypto.randomUUID + the dual-client attachment pipeline) —
 * the browser never reads file bodies.
 */
import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { api } from '../api/client.js';
import type {
  BlueprintSummary,
  BlueprintVersionSummary,
  DraftSummary,
  RecommendResponse,
} from '../types/agent.js';
import {
  submitIntake,
  getTwoStepDraftCapability,
  type IntakeRequest,
} from './intake-client.js';
import { WorkspaceIcon } from '../components/WorkspaceIcon.js';
import {
  WsButton,
  WsMono,
  WsPill,
  WsSpinner,
} from '../components/WorkspacePrimitives.js';
import '../styles/workspace.css';
import '../styles/workspace-parity.css';

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_PASTED_CHARS = 50_000;

interface ClientOption {
  id: string;
  name: string;
  industry?: string | null;
}
type UploadStatus = 'uploading' | 'scanning' | 'extracting' | 'ready' | 'failed';

interface AttachmentUpload {
  id: string;
  name: string;
  size: number;
  status: UploadStatus;
  attachmentId?: string;
  message?: string;
}

interface ContextDomain {
  id: string;
  label: string;
  sub: string;
  enabled: boolean;
}

/** Capiro context domains (handoff §6.5 card 04). All domains are now enabled —
 *  the backend intake service accepts any domain label and sanitizes it as a
 *  planning instruction for the context compiler (no validation against a fixed
 *  set). Each domain produces a planning instruction, not a hardcoded evidence
 *  source. */
const CONTEXT_DOMAINS: ContextDomain[] = [
  { id: 'client-profile', label: 'Client profile', sub: 'Identity, programs, positions', enabled: true },
  { id: 'institutional-memory', label: 'Institutional memory', sub: 'What the firm already knows', enabled: true },
  { id: 'strategies', label: 'Strategies & priorities', sub: 'Active plays for this client', enabled: true },
  { id: 'relationships', label: 'Relationships & targets', sub: 'Who the firm can reach', enabled: true },
  { id: 'engagement', label: 'Engagement history', sub: 'Meetings, calls, outcomes', enabled: true },
  { id: 'client-files', label: 'Client files & notes', sub: 'Uploaded client material', enabled: true },
  { id: 'budget', label: 'Defense budget', sub: 'PB, marks, enacted by PE', enabled: true },
  { id: 'legislation', label: 'Legislation & hearings', sub: 'Bills, marks, hearing records', enabled: true },
  { id: 'nexus', label: 'District Nexus', sub: 'Facilities, jobs, districts', enabled: true },
  { id: 'mailbox', label: 'Mailbox & correspondence', sub: 'Email threads, correspondence', enabled: true },
  { id: 'people', label: 'People & stakeholders', sub: 'Key contacts, roles, influence', enabled: true },
  { id: 'grants', label: 'Grants & contracts', sub: 'Active awards, obligations', enabled: true },
  { id: 'news', label: 'News & intelligence', sub: 'Recent developments, alerts', enabled: true },
];

const ENABLED_DOMAIN_IDS = new Set(
  CONTEXT_DOMAINS.filter((d) => d.enabled).map((d) => d.id),
);

// ── Pure helpers ───────────────────────────────────────────────────────────

function latestPublishedVersion(
  blueprint: BlueprintSummary,
): BlueprintVersionSummary | null {
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

function draftsForClient(drafts: DraftSummary[], clientId: string): DraftSummary[] {
  return drafts.filter((d) => {
    const config = d.config as Record<string, unknown> | undefined;
    return String(config?.clientId ?? '') === clientId;
  });
}

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
    uploads
      .filter((u) => u.status === 'ready' && u.attachmentId)
      .map((u) => u.attachmentId as string);
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

// ── File state pill ─────────────────────────────────────────────────────────

const FILE_STATE_LABEL: Record<UploadStatus, string> = {
  uploading: 'Uploading',
  scanning: 'Scanning',
  extracting: 'Extracting',
  ready: 'Ready',
  failed: 'Failed',
};

function FileStatePill({ state }: { state: UploadStatus }) {
  const spinning =
    state === 'uploading' || state === 'scanning' || state === 'extracting';
  return (
    <span className="ws-intake-file__state" data-state={state}>
      {spinning ? <WsSpinner size={8} /> : null}
      {FILE_STATE_LABEL[state]}
    </span>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export function WorkspaceQuickDraftCreation() {
  const navigate = useNavigate();
  const coreApi = useApi();

  const [goal, setGoal] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientQuery, setClientQuery] = useState('');
  const [selectedBlueprintId, setSelectedBlueprintId] = useState('');
  const [recommendation, setRecommendation] = useState<RecommendResponse | null>(null);
  const [relevantUploads, setRelevantUploads] = useState<AttachmentUpload[]>([]);
  const [sampleUploads, setSampleUploads] = useState<AttachmentUpload[]>([]);
  const [relevantPaste, setRelevantPaste] = useState('');
  const [samplePaste, setSamplePaste] = useState('');
  const [selectedSavedDocs, setSelectedSavedDocs] = useState<Set<string>>(new Set());
  const [selectedDomains, setSelectedDomains] = useState<Set<string>>(
    new Set(['client-profile']),
  );
  const [recommending, setRecommending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [srcTab, setSrcTab] = useState<'files' | 'workspace'>('files');

  // ── Data ──────────────────────────────────────────────────────────────────
  const blueprintsQuery = useQuery({
    queryKey: ['ws-vnext', 'blueprints'],
    queryFn: () => api.listBlueprints(),
  });
  const draftsQuery = useQuery({
    queryKey: ['ws-vnext', 'drafts', 'mine'],
    queryFn: () => api.listDrafts({ scope: 'mine' }),
  });
  const clientsQuery = useQuery({
    queryKey: ['ws-vnext', 'clients'],
    queryFn: async () => (await coreApi.get('/api/clients')).data,
    staleTime: 60_000,
  });
  const capabilityQuery = useQuery({
    queryKey: ['ws-vnext', 'two-step-draft-capability'],
    queryFn: () => getTwoStepDraftCapability(),
    staleTime: 5 * 60_000,
  });
  const capabilityDisabled = Boolean(
    capabilityQuery.data && !capabilityQuery.data.enabled,
  );

  const blueprints = blueprintsQuery.data?.blueprints ?? [];
  const drafts = draftsQuery.data?.drafts ?? [];
  const clients = useMemo(() => toClientOptions(clientsQuery.data), [clientsQuery.data]);

  // ── Derived ────────────────────────────────────────────────────────────────
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
  const filteredClients = useMemo(() => {
    const q = clientQuery.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter((c) => c.name.toLowerCase().includes(q));
  }, [clients, clientQuery]);
  const clientSavedDocs = useMemo(
    () => (selectedClient ? draftsForClient(drafts, selectedClient.id) : []),
    [drafts, selectedClient],
  );
  const uploadsInFlight = useMemo(
    () =>
      [...relevantUploads, ...sampleUploads].some(
        (u) =>
          u.status === 'uploading' || u.status === 'scanning' || u.status === 'extracting',
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

  // Section numbering: section 3 (questions) exists only with a template, so
  // material is section 3 or 4.
  const materialNum = selectedBlueprint ? '4' : '3';

  useEffect(() => {
    if (selectedBlueprintId || !publishedBlueprints.length) return;
    setSelectedBlueprintId(publishedBlueprints[0]?.blueprintId ?? '');
  }, [publishedBlueprints, selectedBlueprintId]);

  useEffect(() => {
    setSelectedSavedDocs(new Set());
  }, [clientId]);

  // ── Attachments (presigned S3 → confirm → extract-text) ───────────────────
  const setList = (
    target: 'relevant' | 'sample',
    updater: (list: AttachmentUpload[]) => AttachmentUpload[],
  ) => (target === 'relevant' ? setRelevantUploads : setSampleUploads)(updater);

  const uploadOne = async (file: File, target: 'relevant' | 'sample') => {
    const localId = `${file.name}:${file.lastModified}:${file.size}`;
    setList(target, (list) => [
      ...list,
      { id: localId, name: file.name, size: file.size, status: 'uploading' },
    ]);
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
        await coreApi.post(
          `/api/engagement/attachments/${encodeURIComponent(confirmed.id)}/extract-text`,
        );
      } catch {
        /* backend re-extracts during intake */
      }
      patch({ status: 'ready' });
    } catch (caught) {
      patch({ status: 'failed', message: errorMessage(caught, 'Upload failed') });
    }
  };

  const handleFiles = async (
    event: ChangeEvent<HTMLInputElement>,
    target: 'relevant' | 'sample',
  ) => {
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
      void uploadOne(file, target);
    }
    if (rejected.length) setFileError(`Not added: ${rejected.join(', ')}.`);
  };

  // ── Recommend ─────────────────────────────────────────────────────────────
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
      setError(
        errorMessage(caught, 'Meri could not recommend a template. You can still choose one manually.'),
      );
    } finally {
      setRecommending(false);
    }
  };

  // ── Submit ────────────────────────────────────────────────────────────────
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
      setRedirecting(true);
      window.setTimeout(() => navigate(`/workspace/${response.draftId}`, { replace: true }), 500);
    } catch (caught) {
      setError(errorMessage(caught, 'Workspace could not start this draft. Please try again.'));
      setSubmitting(false);
      setRedirecting(false);
    }
  };

  const toggleSavedDoc = (id: string) => {
    setSelectedSavedDocs((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleDomain = (id: string) => {
    if (!ENABLED_DOMAIN_IDS.has(id)) return;
    setSelectedDomains((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const removeUpload = (target: 'relevant' | 'sample', id: string) =>
    setList(target, (list) => list.filter((u) => u.id !== id));

  // Blockers (prototype order: goal → template → questions → files).
  const blockers: string[] = [];
  if (goal.trim().length < 12) blockers.push('Tell Meri what you are trying to accomplish.');
  if (!selectedBlueprint) blockers.push('Choose a submission template before generating.');
  if (uploadsInFlight) blockers.push('Files are still being prepared.');
  const canGenerate = blockers.length === 0 && !capabilityDisabled && !submitting;

  const loadingTemplates = blueprintsQuery.isLoading;

  return (
    <div className="ws-intake">
      <div className="ws-intake__scroll">
        {/* Header */}
        <div className="ws-intake__header">
          <div className="ws-intake__header-lead">
            <WsMono variant="eyebrow">New document</WsMono>
            <h1 className="ws-intake__title">What do you want Meri to create?</h1>
            <p className="ws-intake__sub">
              Tell Meri the outcome you need, choose a proven submission template, answer
              the few questions that matter, and give her the material she should use. Meri
              will handle the brief, research plan, structure, and first draft.
            </p>
          </div>
          <WsButton variant="secondary" size="md" onClick={() => navigate('/workspace')}>
            Cancel
          </WsButton>
        </div>

        {capabilityDisabled ? (
          <div className="ws-intake-banner" data-tone="amber" role="status">
            Two-step Max draft isn’t enabled for your workspace yet. Contact an admin to enable it.
          </div>
        ) : null}
        {error ? (
          <div className="ws-intake-banner" data-tone="red" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)}>Dismiss</button>
          </div>
        ) : null}

        {/* Section 1 — goal + client */}
        <section className="ws-intake-card">
          <h2 className="ws-intake-card__title">
            <span className="ws-intake-card__num">1 ·</span> Tell Meri what you’re trying to accomplish
          </h2>
          <div className="ws-intake-goal">
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Create a two-page FY27 NDAA paper for HASC staff asking them to protect the Ground Robotics funding request and support accelerated fielding. Lead with operational readiness and explain why the reduction would delay deployment."
              autoFocus
            />
          </div>
          <p className="ws-intake-hint">
            Include the audience, the action you want, and why it matters. You don’t need to
            structure the document — Meri will do that.
          </p>

          <div className="ws-intake-client">
            <div className="ws-intake-client__row">
              <WsMono variant="field">Client</WsMono>
              <span className="ws-intake-client__selected">
                {selectedClient ? selectedClient.name : 'No client selected'}
              </span>
              <span className="ws-intake-client__spacer" />
              <input
                type="text"
                value={clientQuery}
                onChange={(e) => setClientQuery(e.target.value)}
                placeholder="Search clients"
                className="ws-intake-client__search"
              />
            </div>
            <div className="ws-intake-client__options">
              <button
                type="button"
                data-active={!clientId}
                onClick={() => setClientId('')}
              >
                No client / internal document
              </button>
              {filteredClients.map((client) => (
                <button
                  type="button"
                  key={client.id}
                  data-active={clientId === client.id}
                  onClick={() => setClientId(client.id)}
                >
                  {client.name}
                </button>
              ))}
            </div>
            <p className="ws-intake-caption">
              The client decides which authorized context and saved documents Meri may reach for.
            </p>
          </div>
        </section>

        {/* Section 2 — template */}
        <section className="ws-intake-card">
          <div className="ws-intake-card__row">
            <div className="ws-intake-card__row-lead">
              <h2 className="ws-intake-card__title">
                <span className="ws-intake-card__num">2 ·</span> Choose the type of submission
              </h2>
              <p className="ws-intake-hint">
                Templates give Meri the right structure, evidence rules, drafting instructions,
                follow-up questions, tone, and delivery requirements.
              </p>
            </div>
            <WsButton
              variant="secondary"
              size="md"
              icon="Stars02"
              disabled={!goal.trim() || recommending}
              onClick={() => void recommendTemplate()}
            >
              Recommend a template
            </WsButton>
          </div>

          {recommending ? (
            <div className="ws-intake-thinking">
              <WsSpinner size={15} />
              <span>
                Reading the goal against the client, the submission intent and every template
                available to your firm…
              </span>
            </div>
          ) : null}

          {recommendation && !recommending ? (
            <div className="ws-intake-rec">
              <span className="ws-intake-rec__tile">M</span>
              <span className="ws-intake-rec__body">
                <span className="ws-intake-rec__title">
                  Meri recommends: {recommendation.documentType.label}
                </span>
                <span className="ws-intake-rec__why">{recommendation.rationale}</span>
              </span>
            </div>
          ) : null}

          {loadingTemplates ? (
            <div className="ws-intake-templates" aria-busy="true">
              {[0, 1, 2, 3].map((i) => (
                <div className="ws-intake-template ws-intake-template--skeleton" key={i} />
              ))}
            </div>
          ) : publishedBlueprints.length ? (
            <div className="ws-intake-templates">
              {publishedBlueprints.map((blueprint) => {
                const version = latestPublishedVersion(blueprint);
                const selected = blueprint.blueprintId === selectedBlueprintId;
                const isRecommended =
                  recommendation?.recommendedBlueprints.some(
                    (r) => r.blueprintId === blueprint.blueprintId,
                  ) ?? false;
                return (
                  <button
                    type="button"
                    key={blueprint.blueprintId}
                    className="ws-intake-template"
                    data-selected={selected}
                    data-recommended={isRecommended && !selected}
                    onClick={() => setSelectedBlueprintId(blueprint.blueprintId)}
                  >
                    <span className="ws-intake-template__tags">
                      <WsPill tone={blueprint.scope === 'firm' ? 'cream' : 'neutral'}>
                        {blueprint.scope === 'firm' ? 'FIRM' : 'CAPIRO'}
                      </WsPill>
                      <WsMono variant="tag">{blueprint.documentType || 'Document'}</WsMono>
                      {isRecommended ? <WsPill tone="navy">Recommended</WsPill> : null}
                    </span>
                    <span className="ws-intake-template__name">{blueprint.name}</span>
                    <span className="ws-intake-template__desc">
                      {blueprint.description ||
                        'Firm-ready structure with governed evidence and content rules.'}
                    </span>
                    <span className="ws-intake-template__facts">
                      <WsMono variant="tag">Published v{version?.version ?? '—'}</WsMono>
                    </span>
                  </button>
                );
              })}
              <button
                type="button"
                className="ws-intake-template ws-intake-template--own"
                onClick={() => navigate('/workspace/studio')}
              >
                <span className="ws-intake-template__name">Create your own →</span>
                <span className="ws-intake-template__desc">
                  Build a firm template with its own sections, evidence rules and follow-up
                  questions in Template Studio.
                </span>
              </button>
            </div>
          ) : (
            <div className="ws-intake-empty-templates">
              <span className="ws-intake-empty-templates__title">No published templates are available</span>
              <span className="ws-intake-empty-templates__desc">
                Publish a firm template in Template Studio before creating this document.
              </span>
            </div>
          )}
        </section>

        {/* Section 3/4 — material */}
        <section className="ws-intake-card">
          <h2 className="ws-intake-card__title">
            <span className="ws-intake-card__num">{materialNum} ·</span> Give Meri the material that matters
          </h2>
          <p className="ws-intake-hint">
            Add anything Meri should use to understand the issue, support factual claims, or
            improve the quality of the draft.
          </p>

          {fileError ? (
            <div className="ws-intake-banner" data-tone="amber" role="status">
              <span>{fileError}</span>
              <button type="button" onClick={() => setFileError(null)}>Dismiss</button>
            </div>
          ) : null}

          <div className="ws-intake-material">
            {/* 01 · Relevant material */}
            <div className="ws-intake-sub">
              <WsMono variant="panel" className="ws-intake-sub__ordinal">01</WsMono>
              <span className="ws-intake-sub__title">Relevant material</span>
              <span className="ws-intake-sub__desc">
                Anything you believe Meri should know or use as factual context.
              </span>
              <div className="ws-intake-files">
                {relevantUploads.map((upload) => (
                  <div className="ws-intake-file" key={upload.id}>
                    <span className="ws-intake-file__main">
                      <span className="ws-intake-file__name">{upload.name}</span>
                      <span className="ws-intake-file__meta">
                        {Math.max(1, Math.round(upload.size / 1024))} KB
                      </span>
                    </span>
                    <FileStatePill state={upload.status} />
                    {upload.status === 'failed' ? (
                      <span className="ws-intake-file__failed-actions">
                        <button type="button" onClick={() => removeUpload('relevant', upload.id)}>
                          Remove
                        </button>
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
              <div className="ws-intake-sub__actions">
                <label className="ws-intake-upload">
                  <WorkspaceIcon name="Plus" size={14} color="#475467" />
                  Add files
                  <input
                    type="file"
                    multiple
                    onChange={(e) => void handleFiles(e, 'relevant')}
                  />
                </label>
                <button type="button" className="ws-intake-paste">
                  Paste notes or source text
                </button>
              </div>
              <textarea
                className="ws-intake-paste-area"
                value={relevantPaste}
                onChange={(e) => setRelevantPaste(e.target.value)}
                placeholder="Paste notes or source text…"
              />
              <WsMono variant="tag" className="ws-intake-formats">
                PDF · DOCX · TXT · Markdown · CSV
              </WsMono>
            </div>

            {/* 02 · Client saved documents */}
            <div className="ws-intake-sub">
              <WsMono variant="panel" className="ws-intake-sub__ordinal">02</WsMono>
              <span className="ws-intake-sub__title">Client saved documents</span>
              <span className="ws-intake-sub__desc">
                Reuse approved client files and prior Workspace work already associated with this client.
              </span>
              {!selectedClient ? (
                <div className="ws-intake-sub__empty">
                  Select a client above and Meri will list the files and prior documents that
                  client has authorized.
                </div>
              ) : (
                <>
                  <div className="ws-intake-tabs">
                    <button
                      type="button"
                      data-active={srcTab === 'files'}
                      onClick={() => setSrcTab('files')}
                    >
                      Client Files
                    </button>
                    <button
                      type="button"
                      data-active={srcTab === 'workspace'}
                      onClick={() => setSrcTab('workspace')}
                    >
                      Prior Workspace
                    </button>
                  </div>
                  <div className="ws-intake-files">
                    {srcTab === 'workspace' ? (
                      clientSavedDocs.length ? (
                        clientSavedDocs.map((draft) => {
                          const on = selectedSavedDocs.has(draft.id);
                          return (
                            <button
                              type="button"
                              className="ws-intake-doc"
                              key={draft.id}
                              onClick={() => toggleSavedDoc(draft.id)}
                            >
                              <span className="ws-intake-doc__box" data-on={on}>
                                {on ? <WorkspaceIcon name="Check" size={10} color="#ffffff" /> : null}
                              </span>
                              <span className="ws-intake-doc__main">
                                <span className="ws-intake-doc__name">{draft.docTitle}</span>
                                <span className="ws-intake-doc__meta">
                                  {draft.documentType || 'Workspace document'} ·{' '}
                                  {new Date(draft.updatedAt).toLocaleDateString()}
                                </span>
                              </span>
                            </button>
                          );
                        })
                      ) : (
                        <div className="ws-intake-sub__empty">
                          No saved Workspace documents were found for {selectedClient.name}.
                        </div>
                      )
                    ) : (
                      <div className="ws-intake-sub__empty">
                        Client files are not yet linked to the intake. Use “Add files” to upload
                        client documents directly.
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* 03 · Sample documents */}
            <div className="ws-intake-sub">
              <span className="ws-intake-sub__ordinal-row">
                <WsMono variant="panel" className="ws-intake-sub__ordinal">03</WsMono>
                <WsPill tone="amber">Style &amp; structure only</WsPill>
              </span>
              <span className="ws-intake-sub__title">Sample documents</span>
              <span className="ws-intake-sub__desc">
                Give Meri examples of what a strong final document should look and sound like.
              </span>
              <div className="ws-intake-files">
                {sampleUploads.map((upload) => (
                  <div className="ws-intake-file" key={upload.id}>
                    <span className="ws-intake-file__main">
                      <span className="ws-intake-file__name">{upload.name}</span>
                      <span className="ws-intake-file__meta">
                        {Math.max(1, Math.round(upload.size / 1024))} KB
                      </span>
                    </span>
                    <FileStatePill state={upload.status} />
                    {upload.status === 'failed' ? (
                      <span className="ws-intake-file__failed-actions">
                        <button type="button" onClick={() => removeUpload('sample', upload.id)}>
                          Remove
                        </button>
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
              <div className="ws-intake-sub__actions">
                <label className="ws-intake-upload">
                  <WorkspaceIcon name="Plus" size={14} color="#475467" />
                  Add a sample
                  <input
                    type="file"
                    multiple
                    onChange={(e) => void handleFiles(e, 'sample')}
                  />
                </label>
                <button type="button" className="ws-intake-paste">
                  Paste sample text
                </button>
              </div>
              <textarea
                className="ws-intake-paste-area"
                value={samplePaste}
                onChange={(e) => setSamplePaste(e.target.value)}
                placeholder="Paste sample document text…"
              />
              <span className="ws-intake-style-note">
                Samples can influence organization, tone, density, and rhetorical style. Their
                factual claims are not treated as verified evidence unless independently supported.
              </span>
            </div>

            {/* 04 · Capiro Context */}
            <div className="ws-intake-sub">
              <WsMono variant="panel" className="ws-intake-sub__ordinal">04</WsMono>
              <span className="ws-intake-sub__title">Capiro Context</span>
              <span className="ws-intake-sub__desc">
                Bring relevant information Capiro already knows into this draft.
              </span>
              <div className="ws-intake-domains">
                {CONTEXT_DOMAINS.map((domain) => {
                  const on = domain.enabled && selectedDomains.has(domain.id);
                  return (
                    <button
                      type="button"
                      key={domain.id}
                      className="ws-intake-domain"
                      data-on={on}
                      data-disabled={!domain.enabled}
                      disabled={!domain.enabled}
                      onClick={() => toggleDomain(domain.id)}
                    >
                      <span className="ws-intake-domain__tick">
                        {on ? <WorkspaceIcon name="Check" size={12} color="#294E68" /> : null}
                      </span>
                      <span className="ws-intake-domain__main">
                        <span className="ws-intake-domain__label">{domain.label}</span>
                        <span className="ws-intake-domain__sub">
                          {domain.enabled ? domain.sub : 'Not available yet'}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
              <span className="ws-intake-grey-note">
                Greyed categories have no retrieval route yet. Nothing is fetched from them and
                nothing is implied in the draft.
              </span>
            </div>
          </div>
        </section>

        {/* Source tray */}
        <section className="ws-intake-card ws-intake-tray">
          <div className="ws-intake-tray__row">
            <WsMono variant="panel">What Meri will use</WsMono>
            <span className="ws-intake-tray__spacer" />
            <span className="ws-intake-tray__count">{selectedSourceCount} sources selected</span>
          </div>
          <div className="ws-intake-tray__chips">
            {readyUploadCount ? (
              <span className="ws-intake-tray__chip">{readyUploadCount} uploaded sources</span>
            ) : null}
            {selectedSavedDocs.size ? (
              <span className="ws-intake-tray__chip">{selectedSavedDocs.size} client documents</span>
            ) : null}
            {sampleUploads.filter((u) => u.status === 'ready').length || samplePaste.trim() ? (
              <span className="ws-intake-tray__chip ws-intake-tray__chip--style">
                {sampleUploads.filter((u) => u.status === 'ready').length +
                  (samplePaste.trim() ? 1 : 0)}{' '}
                style samples
              </span>
            ) : null}
            {CONTEXT_DOMAINS.filter(
              (d) => d.enabled && selectedDomains.has(d.id),
            ).map((d) => (
              <span className="ws-intake-tray__chip ws-intake-tray__chip--ctx" key={d.id}>
                {d.label}
              </span>
            ))}
          </div>
        </section>
      </div>

      {/* Sticky footer */}
      <div className="ws-intake-footer">
        <div className="ws-intake-footer__template">
          <span className="ws-intake-footer__name">
            {selectedBlueprint ? selectedBlueprint.name : 'No template selected'}
          </span>
          <WsMono variant="tag" className="ws-intake-footer__meta">
            {selectedSourceCount} sources
          </WsMono>
        </div>
        <span className="ws-intake-footer__mode">Max reasoning</span>
        <span className="ws-intake-footer__spacer" />
        {!canGenerate && blockers.length ? (
          <span className="ws-intake-footer__blocker">
            <WorkspaceIcon name="AlertCircle" size={15} color="#B86E12" />
            {blockers[0]}
          </span>
        ) : null}
        <WsButton
          variant="metal"
          size="lg"
          icon="Stars02"
          disabled={!canGenerate}
          onClick={() => void handleSubmit()}
        >
          Generate first draft
        </WsButton>
      </div>

      {submitting || redirecting ? (
        <div className="ws-intake-generating" role="status" aria-live="polite">
          <div className="ws-intake-generating__card">
            <div className="ws-intake-generating__mark">M</div>
            <WsMono variant="eyebrow">Max reasoning</WsMono>
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
