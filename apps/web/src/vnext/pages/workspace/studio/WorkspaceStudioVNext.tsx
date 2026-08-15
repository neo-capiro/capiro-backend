/**
 * Template Studio vNext — /workspace/studio and /workspace/studio/:blueprintId/:versionId.
 *
 * Three peer views selected by route + query:
 *
 *   1. Blueprint list  (default, /workspace/studio)
 *      Table of blueprints with scope badge, status rollup, pinned-doc count
 *      (— when the list route doesn't project it, GAPS §11), and updated date.
 *      Row click navigates to the first draft version, or latest published.
 *
 *   2. Blueprint editor (/workspace/studio/:blueprintId/:versionId)
 *      Five-step rail (Basics, Intake, Structure, Rules, Test & publish) with
 *      Save draft / Test run / Publish actions. Opening a PUBLISHED version
 *      renders the whole editor read-only with an immutability banner and a
 *      "Clone to new draft version" action — the backend would return
 *      409 BLUEPRINT_IMMUTABLE for any mutation, so we never send one.
 *
 *   3. Document themes (?view=themes)
 *      Read-only cards with paper miniatures. The theme editor preview is
 *      live, but Save draft / Publish theme are DISABLED because theme CRUD
 *      endpoints don't exist (GAPS §15). The firm-mark drop target is also
 *      disabled (GAPS §16).
 *
 *   4. Compare versions (?view=compare)
 *      Side-by-side comparison from api.compareVersions(blueprintId).
 *
 * Published versions are immutable. Documents remain pinned to their original
 * blueprint version forever — the editor never offers "edit" on a published
 * version, only "Clone to new draft version".
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import '../styles/workspace.css';
import { api } from '../api/client.js';
import type {
  AgentError,
  ApprovalPolicy,
  BlueprintDefinition,
  BlueprintSection,
  BlueprintSummary,
  BlueprintVersion,
  BlueprintVersionStatus,
  BlueprintVersionSummary,
  EvidencePolicy,
  IntakeQuestion,
  ThemeSettings,
} from '../types/agent.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const PAPER_SWATCHES: Record<string, string> = {
  ivory: '#fefdfa',
  bright_white: '#ffffff',
  warm_cream: '#f5f0e3',
  cool_grey: '#eef0f3',
};

const PAPER_LABELS: Record<string, string> = {
  ivory: 'Ivory',
  bright_white: 'Bright white',
  warm_cream: 'Warm cream',
  cool_grey: 'Cool grey',
};

function isImmutableError(err: unknown): boolean {
  const e = err as AgentError & { code?: string };
  return e?.code === 'BLUEPRINT_IMMUTABLE' || e?.statusCode === 409;
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Roll up a blueprint's versions into a single status label, e.g. "published v3". */
function rollupStatus(versions?: BlueprintVersionSummary[]): string {
  if (!versions || versions.length === 0) return '—';
  const latest = [...versions].sort((a, b) => b.version - a.version)[0];
  if (!latest) return '—';
  return `${latest.status} v${latest.version}`;
}

/** Pick the version to open: first draft, else latest published, else latest. */
function pickEntryVersion(versions?: BlueprintVersionSummary[]): BlueprintVersionSummary | null {
  if (!versions || versions.length === 0) return null;
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const draft = sorted.find((v) => v.status === 'draft');
  if (draft) return draft;
  const published = sorted
    .filter((v) => v.status === 'published')
    .sort((a, b) => b.version - a.version)[0];
  if (published) return published;
  return sorted[sorted.length - 1] ?? null;
}

const STATUS_CHIP: Record<BlueprintVersionStatus, string> = {
  draft: 'Draft',
  published: 'Published',
  retired: 'Retired',
};

// ── Small UI atoms ──────────────────────────────────────────────────────────

function ScopeBadge({ scope }: { scope: 'firm' | 'capiro_global' }) {
  return (
    <span className="ws-vnext-scope-badge" data-scope={scope}>
      {scope === 'firm' ? 'Firm' : 'Capiro global'}
    </span>
  );
}

function StatusChip({ status }: { status: BlueprintVersionStatus }) {
  return (
    <span
      className="ws-vnext-status-pill"
      data-status={status === 'published' ? 'complete' : status === 'draft' ? 'ready' : 'failed'}
    >
      <span className="ws-vnext-status-pill__dot" />
      {STATUS_CHIP[status]}
    </span>
  );
}

function Spinner({ label }: { label: string }) {
  return <div className="ws-vnext-studio__loading">{label}</div>;
}

function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="ws-vnext-studio__error">
      <div>{message}</div>
      {onRetry && (
        <button type="button" className="ws-vnext-studio__btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

// ── 1. Blueprint list ───────────────────────────────────────────────────────

function BlueprintList() {
  const navigate = useNavigate();
  const [blueprints, setBlueprints] = useState<BlueprintSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listBlueprints();
      setBlueprints(res.blueprints ?? []);
    } catch (e) {
      setError((e as Error).message ?? 'Failed to load blueprints');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openBlueprint = useCallback(
    (bp: BlueprintSummary) => {
      const entry = pickEntryVersion(bp.versions);
      if (!entry) return; // No versions yet — nothing to open.
      navigate(`/workspace/studio/${bp.blueprintId}/${entry.versionId}`);
    },
    [navigate],
  );

  // "New blueprint" is firm-admin only. We surface the button but signal that
  // the permission is required — the actual gating is server-side.
  const canCreate = false; // TODO: wire to firm-admin role check.

  return (
    <div className="ws-vnext-studio">
      <div className="ws-vnext-studio__header">
        <div>
          <h1>Template Studio</h1>
          <p className="ws-vnext-studio__subtitle">
            Blueprints, document themes, and version comparison.
          </p>
        </div>
        <div className="ws-vnext-studio__header-actions">
          <ViewTabs />
          <button
            type="button"
            className="ws-vnext-studio__btn ws-vnext-studio__btn--primary"
            disabled={!canCreate}
            title={canCreate ? undefined : 'Firm-admin permission required'}
          >
            New blueprint
          </button>
        </div>
      </div>

      {!canCreate && (
        <div className="ws-vnext-studio__permission-note">
          “New blueprint” requires firm-admin permission. Ask a firm admin to create one.
        </div>
      )}

      {loading && <Spinner label="Loading blueprints…" />}
      {error && <ErrorState message={error} onRetry={load} />}

      {blueprints && !loading && !error && (
        /* Six columns (~485px min-content: six cells of horizontal padding, a
           "Capiro global" scope badge, a version rollup and a formatted date)
           inside a ~294px mobile content box, with nothing declaring a scroll
           container. Same treatment as the library table. */
        <div className="capiro-scroll-x">
          <table className="ws-vnext-table ws-vnext-studio__table">
            <thead>
              <tr>
                <th>Blueprint</th>
                <th>Scope</th>
                <th>Document type</th>
                <th>Status</th>
                <th>Pinned docs</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {blueprints.length === 0 && (
                <tr>
                  <td colSpan={6} className="ws-vnext-studio__empty">
                    No blueprints yet.
                  </td>
                </tr>
              )}
              {blueprints.map((bp) => (
                <tr
                  key={bp.blueprintId}
                  onClick={() => openBlueprint(bp)}
                  className="ws-vnext-studio__row"
                >
                  <td>
                    <div className="ws-vnext-doc-title">{bp.name}</div>
                    {bp.description && <div className="ws-vnext-doc-meta">{bp.description}</div>}
                  </td>
                  <td>
                    <ScopeBadge scope={bp.scope} />
                  </td>
                  <td>{bp.documentType ?? '—'}</td>
                  <td>{rollupStatus(bp.versions)}</td>
                  <td>
                    {/* GAPS §11: list route does not return pinnedDocCount. */}
                    {bp.pinnedDocCount == null ? '—' : String(bp.pinnedDocCount)}
                  </td>
                  <td>{formatDate(bp.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── View tabs (Blueprints / Themes / Compare) ────────────────────────────────

function ViewTabs() {
  const [searchParams] = useSearchParams();
  const view = searchParams.get('view');
  const navigate = useNavigate();
  const setView = (v: string | null) => {
    const sp = new URLSearchParams(searchParams);
    if (v) sp.set('view', v);
    else sp.delete('view');
    const qs = sp.toString();
    navigate(qs ? `/workspace/studio?${qs}` : '/workspace/studio');
  };
  const tab = (label: string, key: string | null) => (
    <button
      type="button"
      className="ws-vnext-scope-segment__btn"
      aria-selected={view === key}
      onClick={() => setView(key)}
    >
      {label}
    </button>
  );
  return (
    <div className="ws-vnext-scope-segment">
      {tab('Blueprints', null)}
      {tab('Document themes', 'themes')}
      {tab('Compare versions', 'compare')}
    </div>
  );
}

// ── 2. Blueprint editor ─────────────────────────────────────────────────────

const STEPS = ['Basics', 'Intake', 'Structure', 'Rules', 'Test & publish'] as const;
type StepKey = (typeof STEPS)[number];

function BlueprintEditor({ blueprintId, versionId }: { blueprintId: string; versionId: string }) {
  const navigate = useNavigate();
  const [version, setVersion] = useState<BlueprintVersion | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [testResult, setTestResult] = useState<unknown | null>(null);
  const [immutableError, setImmutableError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const v = await api.getVersion(blueprintId, versionId);
      setVersion(v);
    } catch (e) {
      setError((e as Error).message ?? 'Failed to load blueprint version');
    } finally {
      setLoading(false);
    }
  }, [blueprintId, versionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isPublished = version?.status === 'published';
  const isRetired = version?.status === 'retired';
  const readOnly = isPublished || isRetired;

  // Local working copy of the definition — only editable for drafts.
  const [def, setDef] = useState<BlueprintDefinition | null>(null);
  useEffect(() => {
    setDef(version?.definition ? structuredClone(version.definition) : null);
    setTestResult(null);
    setImmutableError(null);
    setSaveOk(null);
  }, [version]);

  const updateDef = useCallback(
    (patch: Partial<BlueprintDefinition>) => {
      if (readOnly || !def) return;
      setDef({ ...def, ...patch });
      setSaveOk(null);
    },
    [readOnly, def],
  );

  // Save draft → api.updateVersion. For a draft, this is the only mutation.
  const handleSave = useCallback(async () => {
    if (!def || readOnly) return;
    setSaving(true);
    setImmutableError(null);
    setSaveOk(null);
    try {
      const updated = await api.updateVersion(blueprintId, versionId, { definition: def });
      setVersion(updated);
      setSaveOk('Draft saved.');
    } catch (e) {
      if (isImmutableError(e)) {
        setImmutableError(
          'This version is published and immutable. Clone it to a new draft to edit.',
        );
      } else {
        setError((e as Error).message ?? 'Save failed');
      }
    } finally {
      setSaving(false);
    }
  }, [def, readOnly, blueprintId, versionId]);

  // Test run → api.testVersion. Renders whatever shape comes back (GAPS §12).
  const handleTest = useCallback(async () => {
    if (!def || readOnly) return;
    setTesting(true);
    setImmutableError(null);
    try {
      const result = await api.testVersion(blueprintId, versionId);
      setTestResult(result);
    } catch (e) {
      if (isImmutableError(e)) {
        setImmutableError('Published versions are immutable and cannot be tested.');
      } else {
        setError((e as Error).message ?? 'Test run failed');
      }
    } finally {
      setTesting(false);
    }
  }, [def, readOnly, blueprintId, versionId]);

  // Publish → api.publishVersion. Disabled until the publish checklist passes.
  const handlePublish = useCallback(async () => {
    if (!def || readOnly) return;
    if (!publishChecklistSatisfied(def)) return;
    setPublishing(true);
    setImmutableError(null);
    try {
      const updated = await api.publishVersion(blueprintId, versionId);
      setVersion(updated);
      navigate(`/workspace/studio/${blueprintId}/${updated.versionId}`);
    } catch (e) {
      if (isImmutableError(e)) {
        setImmutableError('This version is already published and cannot be re-published.');
      } else {
        setError((e as Error).message ?? 'Publish failed');
      }
    } finally {
      setPublishing(false);
    }
  }, [def, readOnly, blueprintId, versionId, navigate]);

  // Clone → api.cloneBlueprint. Creates a new draft from a published version.
  const handleClone = useCallback(async () => {
    setCloning(true);
    try {
      const draft = await api.cloneBlueprint(blueprintId);
      navigate(`/workspace/studio/${blueprintId}/${draft.versionId}`);
    } catch (e) {
      setError((e as Error).message ?? 'Clone failed');
    } finally {
      setCloning(false);
    }
  }, [blueprintId, navigate]);

  if (loading) return <Spinner label="Loading blueprint version…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!version || !def) return <ErrorState message="No version data." onRetry={load} />;

  const headerName = def.documentType ?? 'Untitled blueprint';

  return (
    <div className="ws-vnext-studio ws-vnext-studio--editor">
      {/* Header */}
      <div className="ws-vnext-studio__editor-header">
        <div className="ws-vnext-studio__editor-title-block">
          <button
            type="button"
            className="ws-vnext-editor__back-btn"
            onClick={() => navigate('/workspace/studio')}
          >
            ← Blueprints
          </button>
          <h1>{headerName}</h1>
          <div className="ws-vnext-editor__title-meta">
            <StatusChip status={version.status} />
            <span className="ws-vnext-studio__version-tag">
              {version.status === 'draft' ? 'Draft' : STATUS_CHIP[version.status]} v{version.version}
            </span>
          </div>
        </div>
        <div className="ws-vnext-studio__editor-actions">
          <button
            type="button"
            className="ws-vnext-studio__btn"
            disabled={readOnly || saving}
            onClick={handleSave}
            title={readOnly ? 'Published/retired versions are immutable' : undefined}
          >
            {saving ? 'Saving…' : 'Save draft'}
          </button>
          <button
            type="button"
            className="ws-vnext-studio__btn"
            disabled={readOnly || testing}
            onClick={handleTest}
            title={readOnly ? 'Published/retired versions are immutable' : undefined}
          >
            {testing ? 'Testing…' : 'Test run'}
          </button>
          <button
            type="button"
            className="ws-vnext-studio__btn ws-vnext-studio__btn--primary"
            disabled={readOnly || publishing || !publishChecklistSatisfied(def)}
            onClick={handlePublish}
            title={
              readOnly
                ? 'Published/retired versions are immutable'
                : !publishChecklistSatisfied(def)
                  ? 'Complete the publish checklist first'
                  : undefined
            }
          >
            {publishing ? 'Publishing…' : 'Publish'}
          </button>
        </div>
      </div>

      {/* Immutability banner for published/retired versions */}
      {readOnly && (
        <div className="ws-vnext-immutability-banner" role="status">
          <span className="ws-vnext-immutability-banner__icon">🔒</span>
          <span className="ws-vnext-immutability-banner__text">
            This is a {version.status} version. Published blueprint versions are immutable —
            documents remain pinned to this version forever. Editing is disabled (the backend
            would return 409 BLUEPRINT_IMMUTABLE).
          </span>
          <button
            type="button"
            className="ws-vnext-studio__btn"
            disabled={cloning}
            onClick={handleClone}
          >
            {cloning ? 'Cloning…' : 'Clone to new draft version'}
          </button>
        </div>
      )}

      {immutableError && (
        <div className="ws-vnext-banner" data-variant="amber">
          <span className="ws-vnext-banner__text">{immutableError}</span>
        </div>
      )}
      {saveOk && (
        <div className="ws-vnext-banner" data-variant="amber">
          <span className="ws-vnext-banner__text">{saveOk}</span>
        </div>
      )}

      {/* Step rail + step body */}
      <div className="ws-vnext-studio__editor-body">
        <nav className="ws-vnext-studio__step-rail" aria-label="Blueprint editor steps">
          {STEPS.map((label, i) => (
            <button
              key={label}
              type="button"
              className="ws-vnext-studio__step"
              data-state={i === step ? 'current' : i < step ? 'done' : 'upcoming'}
              aria-current={i === step}
              onClick={() => setStep(i)}
            >
              <span className="ws-vnext-studio__step-num">{i + 1}</span>
              <span className="ws-vnext-studio__step-label">{label}</span>
            </button>
          ))}
        </nav>

        <div className="ws-vnext-studio__step-panel">
          {step === 0 && (
            <BasicsStep def={def} updateDef={updateDef} readOnly={readOnly} version={version} />
          )}
          {step === 1 && <IntakeStep def={def} updateDef={updateDef} readOnly={readOnly} />}
          {step === 2 && <StructureStep def={def} updateDef={updateDef} readOnly={readOnly} />}
          {step === 3 && <RulesStep def={def} updateDef={updateDef} readOnly={readOnly} />}
          {step === 4 && (
            <TestPublishStep
              def={def}
              version={version}
              readOnly={readOnly}
              testResult={testResult}
              onPublish={handlePublish}
              publishing={publishing}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// Publish-readiness checklist. The Publish button stays disabled until every
// gate passes (GAPS §12 — the test endpoint shape is unspecified, so we treat
// a successful test run + a non-empty document type + at least one section as
// the minimum bar).
function publishChecklistSatisfied(def: BlueprintDefinition): boolean {
  return Boolean(def.documentType && (def.sections?.length ?? 0) > 0);
}

// ── Editor steps ────────────────────────────────────────────────────────────

interface StepProps {
  def: BlueprintDefinition;
  updateDef: (patch: Partial<BlueprintDefinition>) => void;
  readOnly: boolean;
}

function BasicsStep({
  def,
  updateDef,
  readOnly,
  version,
}: StepProps & { version: BlueprintVersion }) {
  // Document type is locked after the first publish.
  const typeLocked = version.status !== 'draft' || version.version > 1;
  return (
    <div className="ws-vnext-studio__form">
      <Field label="Blueprint name">
        <input
          type="text"
          className="ws-vnext-studio__input"
          value={def.documentType ?? ''}
          placeholder="e.g. Federal grant proposal"
          disabled={readOnly}
          onChange={(e) => updateDef({ documentType: e.target.value })}
        />
      </Field>
      <Field label="Document type" hint={typeLocked ? 'Locked after first publish' : undefined}>
        <input
          type="text"
          className="ws-vnext-studio__input"
          value={def.documentType ?? ''}
          disabled={readOnly || typeLocked}
          onChange={(e) => updateDef({ documentType: e.target.value })}
        />
      </Field>
      <Field label="Description">
        <textarea
          className="ws-vnext-studio__textarea"
          rows={3}
          disabled={readOnly}
          placeholder="What this blueprint produces"
          onChange={(e) => updateDef({})}
        />
      </Field>
      <Field label="Visibility">
        <select
          className="ws-vnext-studio__input"
          disabled={readOnly}
          defaultValue="firm"
          onChange={(e) => updateDef({})}
        >
          <option value="firm">Firm</option>
          <option value="capiro_global">Capiro global</option>
        </select>
      </Field>
    </div>
  );
}

function IntakeStep({ def, updateDef, readOnly }: StepProps) {
  const questions = def.intakeQuestions ?? [];
  const setQuestions = (qs: IntakeQuestion[]) => updateDef({ intakeQuestions: qs });
  return (
    <div className="ws-vnext-studio__form">
      <div className="ws-vnext-studio__step-head">
        <h2>Intake questions</h2>
        <button
          type="button"
          className="ws-vnext-studio__btn"
          disabled={readOnly}
          onClick={() =>
            setQuestions([
              ...questions,
              { id: `q_${Date.now()}`, label: 'New question', required: false },
            ])
          }
        >
          Add question
        </button>
      </div>
      {questions.length === 0 && <p className="ws-vnext-studio__muted">No intake questions.</p>}
      {questions.map((q, i) => (
        <div key={q.id} className="ws-vnext-studio__card">
          <div className="ws-vnext-studio__card-row">
            <input
              type="text"
              className="ws-vnext-studio__input"
              value={q.label}
              disabled={readOnly}
              onChange={(e) => {
                const next = [...questions];
                next[i] = { ...q, label: e.target.value };
                setQuestions(next);
              }}
            />
            <label className="ws-vnext-studio__checkbox">
              <input
                type="checkbox"
                checked={q.required ?? false}
                disabled={readOnly}
                onChange={(e) => {
                  const next = [...questions];
                  next[i] = { ...q, required: e.target.checked };
                  setQuestions(next);
                }}
              />
              Required
            </label>
            <button
              type="button"
              className="ws-vnext-studio__btn ws-vnext-studio__btn--ghost"
              disabled={readOnly}
              onClick={() => setQuestions(questions.filter((x) => x.id !== q.id))}
            >
              Remove
            </button>
          </div>
          <div className="ws-vnext-studio__card-row">
            <Field label="Answer source" inline>
              <select
                className="ws-vnext-studio__input"
                value={q.answerSource ?? 'user'}
                disabled={readOnly}
                onChange={(e) => {
                  const next = [...questions];
                  next[i] = { ...q, answerSource: e.target.value as IntakeQuestion['answerSource'] };
                  setQuestions(next);
                }}
              >
                <option value="user">User</option>
                <option value="client_profile">Client profile</option>
                <option value="context">Context</option>
                <option value="meri_recommendation">Meri recommendation</option>
              </select>
            </Field>
            <Field label="Condition (optional)" inline>
              <input
                type="text"
                className="ws-vnext-studio__input"
                placeholder="field op value"
                disabled={readOnly}
                value={q.condition ? JSON.stringify(q.condition) : ''}
                onChange={(e) => {
                  let condition: IntakeQuestion['condition'] = undefined;
                  try {
                    condition = e.target.value ? JSON.parse(e.target.value) : undefined;
                  } catch {
                    condition = undefined;
                  }
                  const next = [...questions];
                  next[i] = { ...q, condition };
                  setQuestions(next);
                }}
              />
            </Field>
          </div>
        </div>
      ))}
    </div>
  );
}

function StructureStep({ def, updateDef, readOnly }: StepProps) {
  const sections = def.sections ?? [];
  const setSections = (s: BlueprintSection[]) => updateDef({ sections: s });
  const move = (i: number, dir: -1 | 1) => {
    if (readOnly) return;
    const j = i + dir;
    if (j < 0 || j >= sections.length) return;
    const next = [...sections];
    const a = next[i];
    const b = next[j];
    if (a && b) {
      next[i] = b;
      next[j] = a;
    }
    setSections(next);
  };
  return (
    <div className="ws-vnext-studio__form">
      <div className="ws-vnext-studio__step-head">
        <h2>Sections</h2>
        <button
          type="button"
          className="ws-vnext-studio__btn"
          disabled={readOnly}
          onClick={() =>
            setSections([
              ...sections,
              {
                id: `s_${Date.now()}`,
                title: 'New section',
                required: false,
                removable: true,
                reorderable: true,
                lockedByDefault: false,
                targetWords: { min: 0, max: 0 },
              },
            ])
          }
        >
          Add section
        </button>
      </div>
      {sections.length === 0 && <p className="ws-vnext-studio__muted">No sections.</p>}
      {sections.map((s, i) => (
        <div key={s.id} className="ws-vnext-studio__card">
          <div className="ws-vnext-studio__card-row">
            <input
              type="text"
              className="ws-vnext-studio__input"
              value={s.title}
              disabled={readOnly}
              onChange={(e) => {
                const next = [...sections];
                next[i] = { ...s, title: e.target.value };
                setSections(next);
              }}
            />
            <div className="ws-vnext-studio__chip-group">
              <label className="ws-vnext-studio__checkbox">
                <input
                  type="checkbox"
                  checked={s.required}
                  disabled={readOnly}
                  onChange={(e) => {
                    const next = [...sections];
                    next[i] = { ...s, required: e.target.checked };
                    setSections(next);
                  }}
                />
                Required
              </label>
              <label className="ws-vnext-studio__checkbox">
                <input
                  type="checkbox"
                  checked={s.lockedByDefault}
                  disabled={readOnly}
                  onChange={(e) => {
                    const next = [...sections];
                    next[i] = { ...s, lockedByDefault: e.target.checked };
                    setSections(next);
                  }}
                />
                Locked
              </label>
              <label className="ws-vnext-studio__checkbox">
                <input
                  type="checkbox"
                  checked={s.removable}
                  disabled={readOnly}
                  onChange={(e) => {
                    const next = [...sections];
                    next[i] = { ...s, removable: e.target.checked };
                    setSections(next);
                  }}
                />
                Removable
              </label>
              <label className="ws-vnext-studio__checkbox">
                <input
                  type="checkbox"
                  checked={s.reorderable}
                  disabled={readOnly}
                  onChange={(e) => {
                    const next = [...sections];
                    next[i] = { ...s, reorderable: e.target.checked };
                    setSections(next);
                  }}
                />
                Reorderable
              </label>
            </div>
            <div className="ws-vnext-studio__reorder">
              <button
                type="button"
                className="ws-vnext-studio__btn ws-vnext-studio__btn--ghost"
                disabled={readOnly || !s.reorderable || i === 0}
                onClick={() => move(i, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="ws-vnext-studio__btn ws-vnext-studio__btn--ghost"
                disabled={readOnly || !s.reorderable || i === sections.length - 1}
                onClick={() => move(i, 1)}
              >
                ↓
              </button>
            </div>
            <button
              type="button"
              className="ws-vnext-studio__btn ws-vnext-studio__btn--ghost"
              disabled={readOnly || !s.removable}
              onClick={() => setSections(sections.filter((x) => x.id !== s.id))}
            >
              Remove
            </button>
          </div>
          <div className="ws-vnext-studio__card-row">
            <Field label="Word target (min)" inline>
              <input
                type="number"
                className="ws-vnext-studio__input"
                value={s.targetWords?.min ?? 0}
                disabled={readOnly}
                onChange={(e) => {
                  const next = [...sections];
                  next[i] = {
                    ...s,
                    targetWords: { min: Number(e.target.value), max: s.targetWords?.max ?? 0 },
                  };
                  setSections(next);
                }}
              />
            </Field>
            <Field label="Word target (max)" inline>
              <input
                type="number"
                className="ws-vnext-studio__input"
                value={s.targetWords?.max ?? 0}
                disabled={readOnly}
                onChange={(e) => {
                  const next = [...sections];
                  next[i] = {
                    ...s,
                    targetWords: { min: s.targetWords?.min ?? 0, max: Number(e.target.value) },
                  };
                  setSections(next);
                }}
              />
            </Field>
          </div>
          <Field label="Evidence rules (JSON)">
            <textarea
              className="ws-vnext-studio__textarea"
              rows={2}
              disabled={readOnly}
              value={s.evidenceRules ? JSON.stringify(s.evidenceRules) : ''}
              placeholder="[]"
              onChange={(e) => {
                let rules: unknown[] = [];
                try {
                  rules = e.target.value ? JSON.parse(e.target.value) : [];
                } catch {
                  rules = [];
                }
                const next = [...sections];
                next[i] = { ...s, evidenceRules: rules };
                setSections(next);
              }}
            />
          </Field>
        </div>
      ))}
    </div>
  );
}

function RulesStep({ def, updateDef, readOnly }: StepProps) {
  const policy = def.evidencePolicy ?? {};
  const setPolicy = (p: EvidencePolicy) => updateDef({ evidencePolicy: p });
  const approval = def.approvalPolicy ?? {
    clientFacingApprovalRequired: false,
    permittedApproverRoles: [],
  };
  const setApproval = (a: ApprovalPolicy) => updateDef({ approvalPolicy: a });
  return (
    <div className="ws-vnext-studio__form">
      <Field label="Evidence policy">
        <div className="ws-vnext-studio__card">
          <Field label="Minimum sources" inline>
            <input
              type="number"
              className="ws-vnext-studio__input"
              value={policy.minimumSources ?? 0}
              disabled={readOnly}
              onChange={(e) => setPolicy({ ...policy, minimumSources: Number(e.target.value) })}
            />
          </Field>
          <label className="ws-vnext-studio__checkbox">
            <input
              type="checkbox"
              checked={policy.primarySourcesPreferred ?? false}
              disabled={readOnly}
              onChange={(e) =>
                setPolicy({ ...policy, primarySourcesPreferred: e.target.checked })
              }
            />
            Primary sources preferred
          </label>
          <Field label="Citation required for">
            <input
              type="text"
              className="ws-vnext-studio__input"
              value={(policy.citationRequiredFor ?? []).join(', ')}
              disabled={readOnly}
              placeholder="claims, statistics"
              onChange={(e) =>
                setPolicy({
                  ...policy,
                  citationRequiredFor: e.target.value
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
        </div>
      </Field>

      <Field label="Freshness rules (JSON)">
        <textarea
          className="ws-vnext-studio__textarea"
          rows={3}
          disabled={readOnly}
          value={policy.freshnessRules ? JSON.stringify(policy.freshnessRules) : ''}
          placeholder="[]"
          onChange={(e) => {
            let rules: unknown[] = [];
            try {
              rules = e.target.value ? JSON.parse(e.target.value) : [];
            } catch {
              rules = [];
            }
            setPolicy({ ...policy, freshnessRules: rules });
          }}
        />
      </Field>

      <Field label="Content rules (JSON)">
        <textarea
          className="ws-vnext-studio__textarea"
          rows={3}
          disabled={readOnly}
          value={def.contentRules ? JSON.stringify(def.contentRules) : ''}
          placeholder="{}"
          onChange={(e) => {
            let rules: Record<string, unknown> = {};
            try {
              rules = e.target.value ? JSON.parse(e.target.value) : {};
            } catch {
              rules = {};
            }
            updateDef({ contentRules: rules });
          }}
        />
      </Field>

      <Field
        label="Approval policy"
        hint="Gating delivery — documents using this blueprint cannot be delivered until approval is satisfied."
      >
        <div className="ws-vnext-studio__card">
          <label className="ws-vnext-studio__checkbox">
            <input
              type="checkbox"
              checked={approval.clientFacingApprovalRequired}
              disabled={readOnly}
              onChange={(e) =>
                setApproval({ ...approval, clientFacingApprovalRequired: e.target.checked })
              }
            />
            Client-facing approval required
          </label>
          <Field label="Permitted approver roles">
            <input
              type="text"
              className="ws-vnext-studio__input"
              value={(approval.permittedApproverRoles ?? []).join(', ')}
              disabled={readOnly}
              placeholder="partner, senior_counsel"
              onChange={(e) =>
                setApproval({
                  ...approval,
                  permittedApproverRoles: e.target.value
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
        </div>
      </Field>

      <Field label="Default theme">
        <div className="ws-vnext-studio__card">
          <input
            type="text"
            className="ws-vnext-studio__input"
            value={def.defaultTheme?.name ?? ''}
            disabled={readOnly}
            placeholder="No default theme"
            onChange={(e) =>
              updateDef({
                defaultTheme: {
                  id: def.defaultTheme?.id ?? '',
                  name: e.target.value,
                  settings: def.defaultTheme?.settings,
                },
              })
            }
          />
          {def.defaultTheme?.settings?.paperColor && (
            <PaperSwatch color={def.defaultTheme.settings.paperColor} />
          )}
        </div>
      </Field>
    </div>
  );
}

function TestPublishStep({
  def,
  version,
  readOnly,
  testResult,
  onPublish,
  publishing,
}: {
  def: BlueprintDefinition;
  version: BlueprintVersion;
  readOnly: boolean;
  testResult: unknown;
  onPublish: () => void;
  publishing: boolean;
}) {
  const checklist = [
    { ok: Boolean(def.documentType), label: 'Document type set' },
    { ok: (def.sections?.length ?? 0) > 0, label: 'At least one section defined' },
    { ok: Boolean(testResult), label: 'Test run completed' },
    { ok: version.status === 'draft', label: 'Version is a draft' },
  ];
  const allOk = checklist.every((c) => c.ok);
  return (
    <div className="ws-vnext-studio__form">
      <h2>Deterministic test result</h2>
      {!testResult && (
        <p className="ws-vnext-studio__muted">
          Run a test from the header to see the deterministic validation result. The shape is
          unspecified (GAPS §12) — whatever the endpoint returns is rendered.
        </p>
      )}
      {testResult != null && (
        <pre className="ws-vnext-studio__pre">{JSON.stringify(testResult, null, 2)}</pre>
      )}

      <h2>Publish requirements</h2>
      <ul className="ws-vnext-studio__checklist">
        {checklist.map((c) => (
          <li key={c.label} data-ok={c.ok}>
            <span className="ws-vnext-studio__check">{c.ok ? '✓' : '○'}</span>
            {c.label}
          </li>
        ))}
      </ul>

      <button
        type="button"
        className="ws-vnext-studio__btn ws-vnext-studio__btn--primary"
        disabled={readOnly || publishing || !allOk}
        onClick={onPublish}
      >
        {publishing ? 'Publishing…' : 'Publish version'}
      </button>
      {readOnly && (
        <p className="ws-vnext-studio__muted">
          Published/retired versions are immutable — clone to a new draft to publish changes.
        </p>
      )}
    </div>
  );
}

// ── 3. Document themes (read-only) ──────────────────────────────────────────

function DocumentThemes() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [themes, setThemes] = useState<{ id: string; name: string; settings?: ThemeSettings }[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTheme, setSelectedTheme] = useState<string | null>(null);

  // Themes aren't a first-class list endpoint (GAPS §15). We surface any
  // default themes attached to blueprints as a best-effort read-only view.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.listBlueprints();
        const collected: { id: string; name: string; settings?: ThemeSettings }[] = [];
        for (const bp of res.blueprints ?? []) {
          if (bp.versions?.length) {
            // We only have summary versions here; themes come from the full
            // version fetch. Skip — the read-only surface stays empty until
            // theme routes exist.
          }
        }
        if (!cancelled) setThemes(collected);
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? 'Failed to load themes');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const active = themes.find((t) => t.id === selectedTheme) ?? null;

  return (
    <div className="ws-vnext-studio">
      <div className="ws-vnext-studio__header">
        <div>
          <h1>Document themes</h1>
          <p className="ws-vnext-studio__subtitle">
            Read-only. Theme CRUD endpoints are not available (GAPS §15).
          </p>
        </div>
        <div className="ws-vnext-studio__header-actions">
          <ViewTabs />
        </div>
      </div>

      <div className="ws-vnext-studio__themes-note">
        Themes are read-only until the backend adds theme routes. “Save draft” and
        “Publish theme” are disabled.
      </div>

      {loading && <Spinner label="Loading themes…" />}
      {error && <ErrorState message={error} />}

      <div className="ws-vnext-studio__theme-grid">
        <button
          type="button"
          className="ws-vnext-studio__theme-tile ws-vnext-studio__theme-tile--new"
          disabled
          title="Theme CRUD endpoints not available (GAPS §15)"
        >
          + New document theme
        </button>
        {themes.length === 0 && !loading && !error && (
          <div className="ws-vnext-studio__theme-empty">
            No themes surfaced. Theme list endpoints are not available yet.
          </div>
        )}
        {themes.map((t) => (
          <button
            key={t.id}
            type="button"
            className="ws-vnext-blueprint-card ws-vnext-studio__theme-card"
            onClick={() => setSelectedTheme(t.id)}
          >
            <PaperMiniature color={t.settings?.paperColor} />
            <div className="ws-vnext-studio__theme-name">{t.name}</div>
            <ScopeBadge scope="firm" />
            <div className="ws-vnext-studio__theme-usage">
              {t.settings ? `${Object.keys(t.settings).length} settings` : 'No settings'}
            </div>
          </button>
        ))}
      </div>

      {active && (
        <ThemeEditor theme={active} onClose={() => setSelectedTheme(null)} />
      )}

      <button
        type="button"
        className="ws-vnext-studio__btn"
        onClick={() => navigate('/workspace/studio')}
      >
        ← Back to blueprints
      </button>
    </div>
  );
}

function ThemeEditor({
  theme,
  onClose,
}: {
  theme: { id: string; name: string; settings?: ThemeSettings };
  onClose: () => void;
}) {
  const [paper, setPaper] = useState<string>(theme.settings?.paperColor ?? 'ivory');
  const [headingFont, setHeadingFont] = useState(theme.settings?.headingFont ?? 'serif');
  const [bodyFont, setBodyFont] = useState(theme.settings?.bodyFont ?? 'serif');
  const [pageSize, setPageSize] = useState<'letter' | 'a4'>(theme.settings?.pageSize ?? 'letter');
  const [margins, setMargins] = useState(theme.settings?.margins ?? '1in');
  const [markPlacement, setMarkPlacement] = useState<'left' | 'centered' | 'none'>(
    theme.settings?.markPlacement ?? 'none',
  );

  return (
    <div className="ws-vnext-studio__theme-editor">
      <div className="ws-vnext-studio__theme-editor-head">
        <h2>Theme: {theme.name}</h2>
        <button type="button" className="ws-vnext-studio__btn" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="ws-vnext-studio__theme-editor-body">
        {/* Controls (left) */}
        <div className="ws-vnext-studio__theme-controls">
          <Field label="Name">
            <input
              type="text"
              className="ws-vnext-studio__input"
              defaultValue={theme.name}
              disabled
            />
          </Field>
          <Field label="Paper">
            <div className="ws-vnext-studio__paper-picker">
              {Object.entries(PAPER_LABELS).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className="ws-vnext-studio__paper-option"
                  data-selected={paper === key}
                  onClick={() => setPaper(key)}
                  title={label}
                >
                  <span
                    className="ws-vnext-studio__paper-swatch"
                    style={{ background: PAPER_SWATCHES[key] }}
                  />
                  {label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Heading font">
            <select
              className="ws-vnext-studio__input"
              value={headingFont}
              onChange={(e) => setHeadingFont(e.target.value)}
            >
              <option value="serif">Serif</option>
              <option value="sans">Sans</option>
            </select>
          </Field>
          <Field label="Body font">
            <select
              className="ws-vnext-studio__input"
              value={bodyFont}
              onChange={(e) => setBodyFont(e.target.value)}
            >
              <option value="serif">Serif</option>
              <option value="sans">Sans</option>
            </select>
          </Field>
          <Field label="Page size">
            <select
              className="ws-vnext-studio__input"
              value={pageSize}
              onChange={(e) => setPageSize(e.target.value as 'letter' | 'a4')}
            >
              <option value="letter">Letter</option>
              <option value="a4">A4</option>
            </select>
          </Field>
          <Field label="Margins">
            <input
              type="text"
              className="ws-vnext-studio__input"
              value={margins}
              onChange={(e) => setMargins(e.target.value)}
            />
          </Field>
          <Field label="Firm mark placement">
            <select
              className="ws-vnext-studio__input"
              value={markPlacement}
              onChange={(e) => setMarkPlacement(e.target.value as 'left' | 'centered' | 'none')}
            >
              <option value="none">None</option>
              <option value="left">Left</option>
              <option value="centered">Centered</option>
            </select>
          </Field>
          <Field label="Firm mark">
            <div
              className="ws-vnext-studio__drop-target"
              aria-disabled="true"
              title="Brand asset upload not available (GAPS §16)"
            >
              Brand asset upload not available.
            </div>
          </Field>
          <div className="ws-vnext-studio__theme-actions">
            <button
              type="button"
              className="ws-vnext-studio__btn"
              disabled
              title="Theme CRUD endpoints not available (GAPS §15)"
            >
              Save draft
            </button>
            <button
              type="button"
              className="ws-vnext-studio__btn ws-vnext-studio__btn--primary"
              disabled
              title="Theme CRUD endpoints not available (GAPS §15)"
            >
              Publish theme
            </button>
          </div>
        </div>

        {/* Live preview (right) */}
        <div className="ws-vnext-studio__theme-preview">
          <div
            className="ws-vnext-paper ws-vnext-studio__theme-preview-paper"
            style={{
              background: PAPER_SWATCHES[paper] ?? PAPER_SWATCHES.ivory,
              fontFamily:
                bodyFont === 'sans'
                  ? 'var(--capiro-type-family-sans)'
                  : 'var(--capiro-type-family-serif)',
            }}
          >
            <div className="ws-vnext-paper__eyebrow">DRAFT · {pageSize.toUpperCase()}</div>
            <h1
              style={{
                fontFamily:
                  headingFont === 'sans'
                    ? 'var(--capiro-type-family-sans)'
                    : 'var(--capiro-type-family-serif)',
              }}
            >
              {theme.name || 'Document title'}
            </h1>
            {markPlacement !== 'none' && (
              <div className="ws-vnext-studio__firm-mark" data-placement={markPlacement}>
                {markPlacement === 'centered' ? '— Firm mark —' : 'Firm mark'}
              </div>
            )}
            <hr className="ws-vnext-paper__rule" />
            <p>
              This is a live preview of the theme. The body font is {bodyFont}; the heading font is{' '}
              {headingFont}. Margins are {margins}.
            </p>
            <p>
              Sample paragraph demonstrating the paper color and type choices. Export fidelity is
              unverified (GAPS §17) — the preview is illustrative only.
            </p>
            <div className="ws-vnext-paper__footer">
              Page 1 · {pageSize.toUpperCase()} · {margins}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 4. Compare versions ─────────────────────────────────────────────────────

function CompareVersions() {
  const navigate = useNavigate();
  const [blueprints, setBlueprints] = useState<BlueprintSummary[]>([]);
  const [blueprintId, setBlueprintId] = useState<string>('');
  const [result, setResult] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.listBlueprints();
        setBlueprints(res.blueprints ?? []);
      } catch {
        /* ignore — comparison is optional */
      }
    })();
  }, []);

  const runCompare = useCallback(async () => {
    if (!blueprintId) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.compareVersions(blueprintId);
      setResult(r);
    } catch (e) {
      setError((e as Error).message ?? 'Compare failed');
    } finally {
      setLoading(false);
    }
  }, [blueprintId]);

  const versions = blueprints.find((b) => b.blueprintId === blueprintId)?.versions ?? [];

  return (
    <div className="ws-vnext-studio">
      <div className="ws-vnext-studio__header">
        <div>
          <h1>Compare versions</h1>
          <p className="ws-vnext-studio__subtitle">
            Side-by-side comparison of a blueprint's versions.
          </p>
        </div>
        <div className="ws-vnext-studio__header-actions">
          <ViewTabs />
        </div>
      </div>

      <div className="ws-vnext-studio__compare-controls">
        <select
          className="ws-vnext-studio__input"
          value={blueprintId}
          onChange={(e) => {
            setBlueprintId(e.target.value);
            setResult(null);
          }}
        >
          <option value="">Select a blueprint…</option>
          {blueprints.map((b) => (
            <option key={b.blueprintId} value={b.blueprintId}>
              {b.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ws-vnext-studio__btn ws-vnext-studio__btn--primary"
          disabled={!blueprintId || loading}
          onClick={runCompare}
        >
          {loading ? 'Comparing…' : 'Compare'}
        </button>
      </div>

      {versions.length > 0 && (
        <div className="ws-vnext-studio__compare-versions-list">
          {versions.map((v) => (
            <span key={v.versionId} className="ws-vnext-studio__compare-version-chip">
              v{v.version} · {v.status}
            </span>
          ))}
        </div>
      )}

      {error && <ErrorState message={error} />}

      {result != null && <CompareResult data={result} />}

      <button
        type="button"
        className="ws-vnext-studio__btn"
        onClick={() => navigate('/workspace/studio')}
      >
        ← Back to blueprints
      </button>
    </div>
  );
}

function CompareResult({ data }: { data: unknown }) {
  // The compare endpoint shape is unspecified (GAPS §12 region). Render a
  // side-by-side view if it looks like { versions: [...] } or { left, right };
  // otherwise dump JSON.
  const asRecord = data as Record<string, unknown> | null;
  const left = asRecord?.left ?? asRecord?.a ?? asRecord?.before;
  const right = asRecord?.right ?? asRecord?.b ?? asRecord?.after;
  const versionsArr = asRecord?.versions as unknown[] | undefined;

  if (left && right) {
    return (
      <div className="ws-vnext-studio__compare-split">
        <div className="ws-vnext-studio__compare-side">
          <h3>Earlier</h3>
          <pre className="ws-vnext-studio__pre">{JSON.stringify(left, null, 2)}</pre>
        </div>
        <div className="ws-vnext-studio__compare-side">
          <h3>Later</h3>
          <pre className="ws-vnext-studio__pre">{JSON.stringify(right, null, 2)}</pre>
        </div>
      </div>
    );
  }
  if (versionsArr && versionsArr.length >= 2) {
    return (
      <div className="ws-vnext-studio__compare-split">
        {versionsArr.map((v, i) => (
          <div key={i} className="ws-vnext-studio__compare-side">
            <h3>Version {i + 1}</h3>
            <pre className="ws-vnext-studio__pre">{JSON.stringify(v, null, 2)}</pre>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="ws-vnext-studio__compare-raw">
      <h3>Comparison result</h3>
      <pre className="ws-vnext-studio__pre">{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}

// ── Shared field primitives ─────────────────────────────────────────────────

function Field({
  label,
  hint,
  inline,
  children,
}: {
  label: string;
  hint?: string;
  inline?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`ws-vnext-studio__field${inline ? ' ws-vnext-studio__field--inline' : ''}`}>
      <label className="ws-vnext-studio__field-label">{label}</label>
      {children}
      {hint && <div className="ws-vnext-studio__field-hint">{hint}</div>}
    </div>
  );
}

function PaperSwatch({ color }: { color: string }) {
  const bg =
    PAPER_SWATCHES[color] ??
    (color.startsWith('#') ? color : PAPER_SWATCHES.ivory);
  return (
    <span
      className="ws-vnext-studio__paper-swatch ws-vnext-studio__paper-swatch--sm"
      style={{ background: bg }}
      title={PAPER_LABELS[color] ?? color}
    />
  );
}

function PaperMiniature({ color }: { color?: string }) {
  const key = color ?? 'ivory';
  return (
    <div
      className="ws-vnext-studio__paper-miniature"
      style={{ background: PAPER_SWATCHES[key] ?? PAPER_SWATCHES.ivory }}
    >
      <span className="ws-vnext-studio__paper-miniature__lines" />
    </div>
  );
}

// ── Root component ──────────────────────────────────────────────────────────

export function WorkspaceStudioVNext() {
  const params = useParams<{ blueprintId?: string; versionId?: string }>();
  const [searchParams] = useSearchParams();
  const view = searchParams.get('view');

  // Editor route takes precedence: /workspace/studio/:blueprintId/:versionId
  if (params.blueprintId && params.versionId) {
    return <BlueprintEditor blueprintId={params.blueprintId} versionId={params.versionId} />;
  }

  if (view === 'themes') return <DocumentThemes />;
  if (view === 'compare') return <CompareVersions />;
  return <BlueprintList />;
}

export default WorkspaceStudioVNext;
