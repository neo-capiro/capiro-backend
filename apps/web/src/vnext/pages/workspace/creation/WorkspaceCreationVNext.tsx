/**
 * Workspace vNext — Creation flow (`/workspace/new`).
 *
 * Four-step wizard that produces a draft + initialized agent in one sticky-
 * footer flow. The order is Goal → Type → Blueprint → Design.
 *
 * Composition rules (from WORKSPACE-HANDOFF §6 + `WorkspaceVNextRoutes`):
 *  - Steps 2–4 stay disabled until a recommendation returns from `Ask Meri`
 *    OR the user explicitly skips ahead. Before that, the step rail is locked
 *    and the footer's Next button is inert.
 *  - Recommendation is requested once on step 1 via `api.recommend(goal,
 *    client)`. The returned questions are NOT answered here — they are
 *    answered in conversation once the document opens. A note says so.
 *  - Create performs `POST /drafts` → `POST /drafts/:draftId/agent/initialize`
 *    → navigate to `/workspace/:draftId`. If `initialize` fails the orphan
 *    draft is deleted (`api.deleteDraft`) so no phantom draft is left behind.
 *  - The Design paper picker is local preview only — it does not persist
 *    (GAPS.md §1: there is no semantic theme-change route and persisting an
 *    unversioned browser-only theme blob would silently change what a pinned
 *    document renders as).
 *
 * Data: the workspace `api` client (raw fetch over `/workspace-api`), NOT the
 * axios `useApi` client that targets the main `/api` tenant surface. Styles
 * ship in `../styles/workspace.css` (`.ws-vnext-creation*`).
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import type {
  AgentQuestion,
  BlueprintDefinition,
  BlueprintSummary,
  BlueprintVersion,
  BlueprintVersionSummary,
  DocumentType,
  RecommendResponse,
} from '../types/agent.js';
import '../styles/workspace.css';

// ── Step model ──────────────────────────────────────────────────────────────

type StepId = 'goal' | 'type' | 'blueprint' | 'design';

const STEPS: ReadonlyArray<{ id: StepId; label: string; n: number }> = [
  { id: 'goal', label: 'Goal', n: 1 },
  { id: 'type', label: 'Type', n: 2 },
  { id: 'blueprint', label: 'Blueprint', n: 3 },
  { id: 'design', label: 'Design', n: 4 },
];

const STEP_ORDER: ReadonlyArray<StepId> = ['goal', 'type', 'blueprint', 'design'];

// ── Paper options (Design step, local preview only) ─────────────────────────

const PAPER_OPTIONS: ReadonlyArray<{ id: string; label: string; color: string }> = [
  { id: 'ivory', label: 'Ivory', color: '#FEFDFA' },
  { id: 'bright', label: 'Bright white', color: '#FFFFFF' },
  { id: 'cream', label: 'Warm cream', color: '#FBF6EC' },
  { id: 'cool', label: 'Cool grey', color: '#F7F8FA' },
];

const DEFAULT_PAPER_ID = 'ivory';

// ── Blueprint helpers ───────────────────────────────────────────────────────

/**
 * The latest published version of a blueprint, chosen by version number.
 * Returns `null` if the blueprint has no published version — in which case the
 * blueprint cannot be pinned (a draft-only blueprint is shown but disabled).
 */
function latestPublishedVersion(bp: BlueprintSummary): BlueprintVersionSummary | null {
  const versions = bp.versions ?? [];
  const published = versions.filter((v) => v.status === 'published');
  if (published.length === 0) return null;
  return published.reduce((a, b) => (b.version > a.version ? b : a));
}

/** A blueprint is pinnable iff it has at least one published version. */
function isPinnable(bp: BlueprintSummary): boolean {
  return latestPublishedVersion(bp) != null;
}

/**
 * Human-readable reason a blueprint cannot be pinned. Two cases:
 *  - no versions at all (the blueprint exists but nothing has been versioned),
 *  - every version is still `draft` (no published snapshot to pin against).
 */
function unpinnableReason(bp: BlueprintSummary): string {
  const versions = bp.versions ?? [];
  if (versions.length === 0) return 'No versions yet — cannot be pinned.';
  if (versions.every((v) => v.status === 'draft')) {
    return 'Only a draft version exists — publish a version before pinning.';
  }
  return 'No published version available — cannot be pinned.';
}

/** Compact version summary, e.g. "v1 · published, v2 · draft". */
function versionSummary(bp: BlueprintSummary): string {
  const versions = bp.versions ?? [];
  if (versions.length === 0) return 'no versions';
  return versions
    .slice()
    .sort((a, b) => a.version - b.version)
    .map((v) => `v${v.version} · ${v.status}`)
    .join(', ');
}

// ── Theme card model ────────────────────────────────────────────────────────

interface ThemeOption {
  id: string;
  name: string;
  /** Whether this is the blueprint's default theme. */
  isDefault: boolean;
  /** Whether Meri's recommendation flagged this theme. */
  isRecommended: boolean;
  /** Settings carried from the blueprint definition, if any. */
  settings?: Record<string, unknown>;
}

// ── Component ───────────────────────────────────────────────────────────────

export function WorkspaceCreationVNext() {
  const navigate = useNavigate();

  // Step + unlock state -----------------------------------------------------
  const [step, setStep] = useState<StepId>('goal');
  // Steps 2–4 unlock once a recommendation returns OR the user skips ahead.
  const [unlocked, setUnlocked] = useState(false);
  const [skipped, setSkipped] = useState(false);

  // Goal step state ---------------------------------------------------------
  const [goal, setGoal] = useState('');
  const [clientChips, setClientChips] = useState<string[]>([]);
  const [clientInput, setClientInput] = useState('');
  const [selectedClient, setSelectedClient] = useState<string | null>(null);
  const [recommendLoading, setRecommendLoading] = useState(false);
  const [recommendation, setRecommendation] = useState<RecommendResponse | null>(null);

  // Type step state ---------------------------------------------------------
  const [documentTypes, setDocumentTypes] = useState<DocumentType[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(null);

  // Blueprint step state ----------------------------------------------------
  const [blueprints, setBlueprints] = useState<BlueprintSummary[]>([]);
  const [blueprintsLoading, setBlueprintsLoading] = useState(false);
  const [blueprintDefinitions, setBlueprintDefinitions] = useState<
    Record<string, BlueprintDefinition>
  >({});
  const [selectedBlueprintId, setSelectedBlueprintId] = useState<string | null>(null);
  const [selectedBlueprintVersion, setSelectedBlueprintVersion] =
    useState<BlueprintVersionSummary | null>(null);

  // Design step state -------------------------------------------------------
  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(null);
  const [paperId, setPaperId] = useState<string>(DEFAULT_PAPER_ID);

  // Create flow state -------------------------------------------------------
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Recommended ids captured from the recommendation, used to pre-select on
  // each downstream step and to badge the recommended choices.
  const recommendedTypeId = recommendation?.documentType.id ?? null;
  const recommendedBlueprintId = recommendation?.recommendedBlueprints[0]?.blueprintId ?? null;
  const recommendedTheme = recommendation?.recommendedTheme ?? null;

  // ── Load catalog on mount (Type step grid) ───────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setCatalogLoading(true);
    api
      .getCatalog()
      .then((res) => {
        if (!cancelled) setDocumentTypes(res.documentTypes ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load document catalog.');
        }
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Pre-select the recommended type once catalog + recommendation land ────
  useEffect(() => {
    if (!recommendedTypeId) return;
    if (!documentTypes.length) return;
    if (selectedTypeId) return; // don't clobber an explicit user choice
    const exists = documentTypes.some((t) => t.id === recommendedTypeId);
    if (exists) setSelectedTypeId(recommendedTypeId);
  }, [recommendedTypeId, documentTypes, selectedTypeId]);

  // ── Load blueprints when entering the Blueprint step (one fetch) ─────────
  useEffect(() => {
    if (step !== 'blueprint') return;
    if (blueprints.length > 0 || blueprintsLoading) return;
    let cancelled = false;
    setBlueprintsLoading(true);
    api
      .listBlueprints()
      .then((res) => {
        if (!cancelled) setBlueprints(res.blueprints ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load blueprints.');
        }
      })
      .finally(() => {
        if (!cancelled) setBlueprintsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step, blueprints.length, blueprintsLoading]);

  // ── Fetch full definitions for the chosen type's blueprints (for facts) ───
  // The summary list carries versions but not the definition; section count,
  // minimum-sources and the approval requirement all live in the definition.
  // We fetch lazily for the narrowed set (one type's blueprints) so this is N
  // small, not a portfolio-wide N+1.
  const typedBlueprints = useMemo<BlueprintSummary[]>(() => {
    if (!selectedTypeId) return [];
    return blueprints.filter((bp) => bp.documentType === selectedTypeId);
  }, [blueprints, selectedTypeId]);

  useEffect(() => {
    if (step !== 'blueprint') return;
    if (!typedBlueprints.length) return;
    let cancelled = false;
    const missing = typedBlueprints
      .map((bp) => bp.blueprintId)
      .filter((id) => !blueprintDefinitions[id]);
    if (missing.length === 0) return;
    missing.forEach((id) => {
      api
        .getBlueprint(id)
        .then((full) => {
          if (cancelled) return;
          // Pick the latest published version's definition for facts. The
          // summary intersection narrows `versions` to `BlueprintVersionSummary`,
          // so cast back to the full version type that carries `definition`.
          const versions = (full.versions ?? []) as BlueprintVersion[];
          const pubVersion =
            versions
              .filter((v) => v.status === 'published')
              .sort((a, b) => b.version - a.version)[0] ?? null;
          const definition = pubVersion?.definition ?? versions[0]?.definition;
          if (definition) {
            setBlueprintDefinitions((prev) => ({ ...prev, [id]: definition }));
          }
        })
        .catch(() => {
          // Non-fatal: the row still renders, facts just show "—".
        });
    });
    return () => {
      cancelled = true;
    };
  }, [step, typedBlueprints, blueprintDefinitions]);

  // ── Pre-select the recommended blueprint once blueprints land ─────────────
  useEffect(() => {
    if (step !== 'blueprint') return;
    if (!recommendedBlueprintId) return;
    if (selectedBlueprintId) return; // don't clobber an explicit choice
    const match = typedBlueprints.find((bp) => bp.blueprintId === recommendedBlueprintId);
    if (match && isPinnable(match)) {
      selectBlueprint(match);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, recommendedBlueprintId, typedBlueprints, selectedBlueprintId]);

  // ── Pre-select the blueprint's defaultTheme on the Design step ───────────
  const selectedBlueprintDefinition =
    selectedBlueprintId != null ? blueprintDefinitions[selectedBlueprintId] : undefined;

  useEffect(() => {
    if (step !== 'design') return;
    if (selectedThemeId) return; // don't clobber an explicit choice
    const defTheme = selectedBlueprintDefinition?.defaultTheme;
    if (defTheme) {
      setSelectedThemeId(defTheme.id);
    } else if (recommendedTheme) {
      setSelectedThemeId(recommendedTheme.id);
    }
  }, [step, selectedBlueprintDefinition, selectedThemeId, recommendedTheme]);

  // ── Theme options for the Design step ────────────────────────────────────
  const themeOptions = useMemo<ThemeOption[]>(() => {
    const opts: ThemeOption[] = [];
    const defTheme = selectedBlueprintDefinition?.defaultTheme;
    if (defTheme) {
      opts.push({
        id: defTheme.id,
        name: defTheme.name,
        isDefault: true,
        isRecommended:
          recommendedTheme != null && recommendedTheme.id === defTheme.id,
        settings: defTheme.settings as Record<string, unknown> | undefined,
      });
    }
    if (recommendedTheme && (!defTheme || defTheme.id !== recommendedTheme.id)) {
      opts.push({
        id: recommendedTheme.id,
        name: recommendedTheme.name,
        isDefault: false,
        isRecommended: true,
      });
    }
    return opts;
  }, [selectedBlueprintDefinition, recommendedTheme]);

  const selectedTheme = useMemo<ThemeOption | null>(() => {
    if (!selectedThemeId) return null;
    return themeOptions.find((t) => t.id === selectedThemeId) ?? null;
  }, [themeOptions, selectedThemeId]);

  const selectedType = useMemo<DocumentType | null>(
    () => documentTypes.find((t) => t.id === selectedTypeId) ?? null,
    [documentTypes, selectedTypeId],
  );

  const paperColor = useMemo(
    () =>
      PAPER_OPTIONS.find((p) => p.id === paperId)?.color ??
      PAPER_OPTIONS[0]?.color ??
      '#FEFDFA',
    [paperId],
  );

  // ── Actions ──────────────────────────────────────────────────────────────

  const addClientChip = useCallback(() => {
    const name = clientInput.trim();
    if (!name) return;
    setClientChips((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setSelectedClient(name);
    setClientInput('');
  }, [clientInput]);

  const removeClientChip = useCallback((name: string) => {
    setClientChips((prev) => prev.filter((c) => c !== name));
    setSelectedClient((cur) => (cur === name ? null : cur));
  }, []);

  const askMeri = useCallback(async () => {
    if (!goal.trim()) return;
    setRecommendLoading(true);
    setError(null);
    try {
      const res = await api.recommend(goal.trim(), selectedClient ?? undefined);
      setRecommendation(res);
      setSkipped(false);
      setUnlocked(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Meri could not produce a recommendation.');
    } finally {
      setRecommendLoading(false);
    }
  }, [goal, selectedClient]);

  const skipRecommendation = useCallback(() => {
    setSkipped(true);
    setUnlocked(true);
  }, []);

  function selectBlueprint(bp: BlueprintSummary) {
    const version = latestPublishedVersion(bp);
    setSelectedBlueprintId(bp.blueprintId);
    setSelectedBlueprintVersion(version);
  }

  const goToStep = useCallback(
    (id: StepId) => {
      if (id === 'goal') {
        setStep(id);
        return;
      }
      if (!unlocked) return; // steps 2–4 locked until recommend/skip
      setStep(id);
    },
    [unlocked],
  );

  const goNext = useCallback(() => {
    const idx = STEP_ORDER.indexOf(step);
    if (idx < 0 || idx >= STEP_ORDER.length - 1) return;
    const next = STEP_ORDER[idx + 1];
    if (!next) return;
    if (next !== 'goal' && !unlocked) return;
    setStep(next);
  }, [step, unlocked]);

  const goBack = useCallback(() => {
    const idx = STEP_ORDER.indexOf(step);
    if (idx <= 0) return;
    const prev = STEP_ORDER[idx - 1];
    if (!prev) return;
    setStep(prev);
  }, [step]);

  // ── Create document: draft → initialize → navigate (or cleanup) ──────────
  const createDocument = useCallback(async () => {
    if (!selectedType || !selectedBlueprintVersion) return;
    setCreating(true);
    setError(null);
    let draftId: string | null = null;
    try {
      const created = await api.createDraft({});
      draftId = created.id;
      await api.initializeAgent(draftId, {
        documentType: {
          id: selectedType.id,
          label: selectedType.label,
          product: selectedType.product,
        },
        blueprintPin: {
          blueprintId: selectedBlueprintId ?? '',
          versionId: selectedBlueprintVersion.versionId,
          version: selectedBlueprintVersion.version,
          definitionHash: selectedBlueprintVersion.definitionHash ?? '',
        },
        theme: selectedTheme
          ? {
              id: selectedTheme.id,
              name: selectedTheme.name,
              settings: selectedTheme.settings ?? {},
            }
          : undefined,
        goal: goal.trim() || undefined,
      });
      // Success — hand off to the editor.
      navigate(`/workspace/${draftId}`);
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : 'Failed to create document.';
      // Do NOT leave a phantom draft: best-effort cleanup of the orphan.
      if (draftId) {
        try {
          await api.deleteDraft(draftId);
        } catch {
          // Cleanup failed — surface the original error, not the cleanup noise.
        }
      }
      setError(message);
      setCreating(false);
    }
  }, [
    selectedType,
    selectedBlueprintVersion,
    selectedBlueprintId,
    selectedTheme,
    goal,
    navigate,
  ]);

  // ── Per-step Next enablement ──────────────────────────────────────────────
  const canAdvance = useMemo<boolean>(() => {
    switch (step) {
      case 'goal':
        return recommendation != null || skipped;
      case 'type':
        return selectedTypeId != null;
      case 'blueprint':
        return selectedBlueprintVersion != null;
      case 'design':
        return selectedType != null && selectedBlueprintVersion != null;
      default:
        return false;
    }
  }, [step, recommendation, skipped, selectedTypeId, selectedBlueprintVersion, selectedType]);

  const isLastStep = step === 'design';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="ws-vnext-creation">
      {/* Step rail */}
      <div className="ws-vnext-creation__steps" role="tablist" aria-label="Creation steps">
        {STEPS.map((s, i) => {
          const state = step === s.id ? 'current' : STEP_ORDER.indexOf(s.id) < STEP_ORDER.indexOf(step) ? 'done' : 'upcoming';
          const reachable = s.id === 'goal' || unlocked;
          return (
            <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center' }}>
              <button
                type="button"
                role="tab"
                aria-selected={step === s.id}
                aria-disabled={!reachable}
                disabled={!reachable}
                className="ws-vnext-creation-step"
                data-state={state}
                onClick={() => goToStep(s.id)}
                style={{
                  border: 'none',
                  background: 'transparent',
                  padding: 0,
                  cursor: reachable ? 'pointer' : 'not-allowed',
                }}
              >
                <span className="ws-vnext-creation-step__num">{s.n}</span>
                <span>{s.label}</span>
              </button>
              {i < STEPS.length - 1 && (
                <span
                  className="ws-vnext-creation-step-connector"
                  data-active={STEP_ORDER.indexOf(step) > i ? 'true' : 'false'}
                />
              )}
            </span>
          );
        })}
      </div>

      {/* Error banner */}
      {error && (
        <div className="ws-vnext-banner" data-variant="red" style={{ margin: '0 0 16px' }}>
          <span className="ws-vnext-banner__text">{error}</span>
          <button
            type="button"
            className="ws-vnext-banner__action"
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Step bodies */}
      {step === 'goal' && (
        <GoalStep
          goal={goal}
          setGoal={setGoal}
          clientChips={clientChips}
          clientInput={clientInput}
          setClientInput={setClientInput}
          selectedClient={selectedClient}
          setSelectedClient={setSelectedClient}
          addClientChip={addClientChip}
          removeClientChip={removeClientChip}
          recommendLoading={recommendLoading}
          askMeri={askMeri}
          skipRecommendation={skipRecommendation}
          skipped={skipped}
          recommendation={recommendation}
        />
      )}

      {step === 'type' && (
        <TypeStep
          documentTypes={documentTypes}
          loading={catalogLoading}
          selectedTypeId={selectedTypeId}
          onSelect={setSelectedTypeId}
          recommendedTypeId={recommendedTypeId}
          unlocked={unlocked}
        />
      )}

      {step === 'blueprint' && (
        <BlueprintStep
          blueprints={typedBlueprints}
          loading={blueprintsLoading}
          selectedBlueprintId={selectedBlueprintId}
          onSelect={selectBlueprint}
          recommendedBlueprintId={recommendedBlueprintId}
          definitions={blueprintDefinitions}
          unlocked={unlocked}
        />
      )}

      {step === 'design' && (
        <DesignStep
          themeOptions={themeOptions}
          selectedThemeId={selectedThemeId}
          onSelectTheme={setSelectedThemeId}
          paperId={paperId}
          setPaperId={setPaperId}
          paperColor={paperColor}
        />
      )}

      {/* Sticky footer */}
      <div className="ws-vnext-creation__footer">
        <button
          type="button"
          className="ws-vnext-btn ws-vnext-btn--ghost"
          onClick={goBack}
          disabled={step === 'goal' || creating}
        >
          Back
        </button>

        <span
          style={{
            fontSize: 12,
            color: 'var(--ws-muted)',
            fontFamily: 'var(--capiro-type-family-mono)',
            letterSpacing: '0.04em',
          }}
        >
          {unlocked
            ? `Step ${STEPS.find((s) => s.id === step)?.n} of ${STEPS.length}`
            : 'Ask Meri or skip to unlock the remaining steps'}
        </span>

        {isLastStep ? (
          <button
            type="button"
            className="ws-vnext-btn ws-vnext-btn--primary"
            onClick={createDocument}
            disabled={!canAdvance || creating}
          >
            {creating ? 'Creating…' : 'Create document'}
          </button>
        ) : (
          <button
            type="button"
            className="ws-vnext-btn ws-vnext-btn--primary"
            onClick={goNext}
            disabled={!canAdvance || creating}
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 1 — GOAL
// ════════════════════════════════════════════════════════════════════════════

interface GoalStepProps {
  goal: string;
  setGoal: (v: string) => void;
  clientChips: string[];
  clientInput: string;
  setClientInput: (v: string) => void;
  selectedClient: string | null;
  setSelectedClient: (v: string | null) => void;
  addClientChip: () => void;
  removeClientChip: (name: string) => void;
  recommendLoading: boolean;
  askMeri: () => void;
  skipRecommendation: () => void;
  skipped: boolean;
  recommendation: RecommendResponse | null;
}

function GoalStep(props: GoalStepProps) {
  const {
    goal,
    setGoal,
    clientChips,
    clientInput,
    setClientInput,
    selectedClient,
    setSelectedClient,
    addClientChip,
    removeClientChip,
    recommendLoading,
    askMeri,
    skipRecommendation,
    skipped,
    recommendation,
  } = props;

  return (
    <div className="ws-vnext-creation-step-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <label
          htmlFor="ws-creation-goal"
          style={{
            display: 'block',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--ws-ink)',
            marginBottom: 6,
          }}
        >
          What do you want this document to achieve?
        </label>
        <textarea
          id="ws-creation-goal"
          className="ws-vnext-agent-composer__textarea"
          style={{ minHeight: 96, maxHeight: 220 }}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g. A quarterly advocacy report for the healthcare client summarizing Q3 engagement and recommending Q4 priorities."
        />
      </div>

      {/* Client chips */}
      <div>
        <label
          htmlFor="ws-creation-client"
          style={{
            display: 'block',
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--ws-body)',
            marginBottom: 6,
          }}
        >
          Client (optional)
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {clientChips.map((name) => (
            <span
              key={name}
              onClick={() => setSelectedClient(selectedClient === name ? null : name)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 8px 3px 10px',
                borderRadius: 9999,
                fontSize: 12,
                cursor: 'pointer',
                border: '1px solid',
                borderColor: selectedClient === name ? 'var(--ws-navy)' : 'var(--ws-control-ring)',
                background: selectedClient === name ? 'var(--ws-selected)' : 'transparent',
                color: selectedClient === name ? 'var(--ws-navy)' : 'var(--ws-body)',
              }}
            >
              {name}
              <button
                type="button"
                aria-label={`Remove ${name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  removeClientChip(name);
                }}
                style={{
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  color: 'inherit',
                  fontSize: 14,
                  lineHeight: 1,
                  padding: 0,
                  marginLeft: 2,
                }}
              >
                ×
              </button>
            </span>
          ))}
          <input
            id="ws-creation-client"
            type="text"
            value={clientInput}
            onChange={(e) => setClientInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addClientChip();
              }
            }}
            placeholder="Add a client…"
            style={{
              flex: 1,
              minWidth: 140,
              border: '1px solid var(--ws-control-ring)',
              borderRadius: 8,
              padding: '6px 10px',
              fontSize: 13,
              fontFamily: 'var(--capiro-type-family-sans)',
              color: 'var(--ws-ink)',
              background: 'var(--ws-page-bg)',
            }}
          />
        </div>
        {selectedClient && (
          <div style={{ fontSize: 11, color: 'var(--ws-muted)', marginTop: 6 }}>
            “{selectedClient}” will be sent to Meri with the goal.
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button
          type="button"
          className="ws-vnext-btn ws-vnext-btn--primary"
          onClick={askMeri}
          disabled={!goal.trim() || recommendLoading}
        >
          {recommendLoading ? 'Asking Meri…' : 'Ask Meri'}
        </button>
        <button
          type="button"
          className="ws-vnext-btn ws-vnext-btn--ghost"
          onClick={skipRecommendation}
          disabled={recommendLoading}
        >
          Skip — choose manually
        </button>
      </div>

      {/* Recommendation card */}
      {recommendation && <RecommendationCard recommendation={recommendation} />}
      {!recommendation && skipped && (
        <div className="ws-vnext-callout">
          <div className="ws-vnext-callout__label">Skipped</div>
          You skipped Meri’s recommendation. You can pick the type, blueprint, and
          theme yourself in the next steps.
        </div>
      )}
    </div>
  );
}

// ── Recommendation card ─────────────────────────────────────────────────────

function RecommendationCard({ recommendation }: { recommendation: RecommendResponse }) {
  const topBlueprint = recommendation.recommendedBlueprints[0];
  return (
    <div className="ws-vnext-callout" style={{ marginTop: 4 }}>
      <div className="ws-vnext-callout__label">Meri’s recommendation</div>
      <div style={{ fontSize: 13, color: 'var(--ws-body)', lineHeight: 1.5, marginTop: 4 }}>
        {recommendation.rationale}
      </div>

      {/* Three fact cards: type / blueprint / theme */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 10,
          marginTop: 12,
        }}
      >
        <div className="ws-vnext-card">
          <div className="ws-vnext-card__label">Recommended type</div>
          <div className="ws-vnext-card__value">{recommendation.documentType.label}</div>
        </div>
        <div className="ws-vnext-card">
          <div className="ws-vnext-card__label">Recommended blueprint</div>
          <div className="ws-vnext-card__value">{topBlueprint?.name ?? '—'}</div>
        </div>
        <div className="ws-vnext-card">
          <div className="ws-vnext-card__label">Recommended theme</div>
          <div className="ws-vnext-card__value">{recommendation.recommendedTheme.name}</div>
        </div>
      </div>

      {/* Questions */}
      {recommendation.questions.length > 0 && (
        <div className="ws-vnext-questions-block" style={{ marginTop: 12 }}>
          <div className="ws-vnext-questions-block__label">
            Questions Meri will ask
          </div>
          {recommendation.questions.map((q: AgentQuestion) => (
            <div className="ws-vnext-questions-block__q" key={q.id}>
              {q.required && (
                <span
                  className="ws-vnext-status-pill"
                  data-status="needs_input"
                  style={{ marginRight: 8, verticalAlign: 'middle' }}
                >
                  Required
                </span>
              )}
              {q.label}
            </div>
          ))}
          <div
            style={{
              fontSize: 11,
              color: 'var(--ws-muted)',
              marginTop: 8,
              fontStyle: 'italic',
            }}
          >
            These questions are answered in conversation once the document opens —
            not here.
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 2 — TYPE
// ════════════════════════════════════════════════════════════════════════════

interface TypeStepProps {
  documentTypes: DocumentType[];
  loading: boolean;
  selectedTypeId: string | null;
  onSelect: (id: string) => void;
  recommendedTypeId: string | null;
  unlocked: boolean;
}

function TypeStep(props: TypeStepProps) {
  const { documentTypes, loading, selectedTypeId, onSelect, recommendedTypeId, unlocked } = props;

  if (!unlocked) {
    return (
      <div className="ws-vnext-empty">
        <div className="ws-vnext-empty__title">Locked</div>
        <div className="ws-vnext-empty__desc">
          Ask Meri or skip the recommendation on the Goal step to unlock the type
          picker.
        </div>
      </div>
    );
  }

  if (loading && documentTypes.length === 0) {
    return (
      <div>
        <div className="ws-vnext-skeleton-row" />
        <div className="ws-vnext-skeleton-row" />
        <div className="ws-vnext-skeleton-row" />
      </div>
    );
  }

  if (documentTypes.length === 0) {
    return (
      <div className="ws-vnext-empty">
        <div className="ws-vnext-empty__title">No document types available</div>
        <div className="ws-vnext-empty__desc">
          The catalog returned no types. Try again later.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 13, color: 'var(--ws-body)', marginBottom: 12 }}>
        Choose a document type. {recommendedTypeId && 'Meri’s recommendation is badged.'}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 12,
        }}
      >
        {documentTypes.map((t) => {
          const selected = t.id === selectedTypeId;
          const recommended = t.id === recommendedTypeId;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelect(t.id)}
              style={{
                textAlign: 'left',
                cursor: 'pointer',
                border: '1px solid',
                borderColor: selected ? 'var(--ws-navy)' : 'var(--ws-line)',
                borderRadius: 10,
                padding: 14,
                background: selected ? 'var(--ws-selected)' : 'var(--ws-page-bg)',
                transition: 'border-color 120ms',
                fontFamily: 'var(--capiro-type-family-sans)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ws-ink)' }}>
                  {t.label}
                </span>
                {recommended && (
                  <span
                    className="ws-vnext-status-pill"
                    data-status="ready"
                    style={{ flexShrink: 0 }}
                  >
                    Meri recommends
                  </span>
                )}
              </div>
              {t.product && (
                <div
                  style={{
                    fontSize: 10,
                    fontFamily: 'var(--capiro-type-family-mono)',
                    color: 'var(--ws-faint)',
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    marginTop: 6,
                  }}
                >
                  {t.product}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 3 — BLUEPRINT
// ════════════════════════════════════════════════════════════════════════════

interface BlueprintStepProps {
  blueprints: BlueprintSummary[];
  loading: boolean;
  selectedBlueprintId: string | null;
  onSelect: (bp: BlueprintSummary) => void;
  recommendedBlueprintId: string | null;
  definitions: Record<string, BlueprintDefinition>;
  unlocked: boolean;
}

function BlueprintStep(props: BlueprintStepProps) {
  const {
    blueprints,
    loading,
    selectedBlueprintId,
    onSelect,
    recommendedBlueprintId,
    definitions,
    unlocked,
  } = props;

  if (!unlocked) {
    return (
      <div className="ws-vnext-empty">
        <div className="ws-vnext-empty__title">Locked</div>
        <div className="ws-vnext-empty__desc">
          Ask Meri or skip the recommendation on the Goal step to unlock the
          blueprint list.
        </div>
      </div>
    );
  }

  if (loading && blueprints.length === 0) {
    return (
      <div>
        <div className="ws-vnext-skeleton-row" />
        <div className="ws-vnext-skeleton-row" />
        <div className="ws-vnext-skeleton-row" />
      </div>
    );
  }

  if (blueprints.length === 0) {
    return (
      <div className="ws-vnext-empty">
        <div className="ws-vnext-empty__title">No blueprints for this type</div>
        <div className="ws-vnext-empty__desc">
          No blueprints match the selected document type. Pick a different type or
          ask an administrator to publish one.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 13, color: 'var(--ws-body)', marginBottom: 12 }}>
        Pin a blueprint. {recommendedBlueprintId && 'Meri’s recommendation is badged.'} A
        blueprint whose only version is draft is shown but cannot be pinned.
      </div>

      {blueprints.map((bp) => {
        const pinnable = isPinnable(bp);
        const selected = bp.blueprintId === selectedBlueprintId;
        const recommended = bp.blueprintId === recommendedBlueprintId;
        const def = definitions[bp.blueprintId];

        const sectionCount = def?.sections?.length;
        const minSources = def?.evidencePolicy?.minimumSources;
        const approvalRequired = def?.approvalPolicy?.clientFacingApprovalRequired;

        return (
          <div
            key={bp.blueprintId}
            className="ws-vnext-blueprint-card"
            onClick={() => {
              if (pinnable) onSelect(bp);
            }}
            role="button"
            tabIndex={pinnable ? 0 : -1}
            aria-disabled={!pinnable}
            style={{
              borderColor: selected
                ? 'var(--ws-navy)'
                : pinnable
                ? undefined
                : 'var(--ws-line)',
              cursor: pinnable ? 'pointer' : 'not-allowed',
              opacity: pinnable ? 1 : 0.6,
              background: selected ? 'var(--ws-selected)' : undefined,
            }}
          >
            {/* Header: name + badges */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                marginBottom: 6,
              }}
            >
              <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--ws-ink)' }}>
                {bp.name}
              </span>
              <span className="ws-vnext-scope-badge" data-scope={bp.scope}>
                {bp.scope === 'firm' ? 'Firm' : 'Capiro global'}
              </span>
              {recommended && (
                <span className="ws-vnext-status-pill" data-status="ready">
                  Meri recommends
                </span>
              )}
            </div>

            {/* Description */}
            {bp.description && (
              <div style={{ fontSize: 13, color: 'var(--ws-body)', marginBottom: 8 }}>
                {bp.description}
              </div>
            )}

            {/* Facts: section count, minimum sources, approval requirement */}
            <div
              style={{
                display: 'flex',
                gap: 8,
                flexWrap: 'wrap',
                marginBottom: 8,
              }}
            >
              <BlueprintFact
                label="Sections"
                value={sectionCount != null ? String(sectionCount) : '—'}
              />
              <BlueprintFact
                label="Min. sources"
                value={minSources != null ? String(minSources) : '—'}
              />
              <BlueprintFact
                label="Approval"
                value={
                  approvalRequired == null
                    ? '—'
                    : approvalRequired
                    ? 'Required'
                    : 'Not required'
                }
              />
            </div>

            {/* Version info + pinnability reason */}
            <div
              style={{
                fontSize: 11,
                fontFamily: 'var(--capiro-type-family-mono)',
                color: 'var(--ws-faint)',
                letterSpacing: '0.04em',
              }}
            >
              Versions: {versionSummary(bp)}
            </div>

            {!pinnable && (
              <div
                style={{
                  marginTop: 8,
                  fontSize: 12,
                  color: 'var(--ws-amber)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span>⚠</span>
                <span>{unpinnableReason(bp)}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BlueprintFact({ label, value }: { label: string; value: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        fontFamily: 'var(--capiro-type-family-mono)',
        letterSpacing: '0.04em',
        background: 'var(--ws-sunken)',
        color: 'var(--ws-muted)',
        padding: '2px 8px',
        borderRadius: 5,
      }}
    >
      <span style={{ textTransform: 'uppercase', opacity: 0.8 }}>{label}</span>
      <span style={{ color: 'var(--ws-ink)', fontWeight: 600 }}>{value}</span>
    </span>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 4 — DESIGN
// ════════════════════════════════════════════════════════════════════════════

interface DesignStepProps {
  themeOptions: ThemeOption[];
  selectedThemeId: string | null;
  onSelectTheme: (id: string) => void;
  paperId: string;
  setPaperId: (id: string) => void;
  paperColor: string;
}

function DesignStep(props: DesignStepProps) {
  const { themeOptions, selectedThemeId, onSelectTheme, paperId, setPaperId, paperColor } = props;

  return (
    <div>
      <div style={{ fontSize: 13, color: 'var(--ws-body)', marginBottom: 12 }}>
        Pick a theme and preview the paper. The blueprint’s default theme is
        pre-selected and badged.
      </div>

      {/* Theme cards with paper miniatures */}
      {themeOptions.length === 0 ? (
        <div className="ws-vnext-empty">
          <div className="ws-vnext-empty__title">No theme available</div>
          <div className="ws-vnext-empty__desc">
            The selected blueprint has no default theme and Meri made no theme
            recommendation. You can still create the document — the backend will
            apply its default theme.
          </div>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 12,
            marginBottom: 20,
          }}
        >
          {themeOptions.map((t) => {
            const selected = t.id === selectedThemeId;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onSelectTheme(t.id)}
                style={{
                  textAlign: 'left',
                  cursor: 'pointer',
                  border: '1px solid',
                  borderColor: selected ? 'var(--ws-navy)' : 'var(--ws-line)',
                  borderRadius: 10,
                  padding: 12,
                  background: selected ? 'var(--ws-selected)' : 'var(--ws-page-bg)',
                  fontFamily: 'var(--capiro-type-family-sans)',
                }}
              >
                <PaperMiniature paperColor={paperColor} />
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    flexWrap: 'wrap',
                    marginTop: 10,
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ws-ink)' }}>
                    {t.name}
                  </span>
                  {t.isDefault && (
                    <span className="ws-vnext-status-pill" data-status="ready">
                      Blueprint default
                    </span>
                  )}
                  {t.isRecommended && !t.isDefault && (
                    <span className="ws-vnext-status-pill" data-status="needs_input">
                      Meri recommends
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Paper picker — local preview only */}
      <div>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--ws-ink)',
            marginBottom: 8,
          }}
        >
          Paper
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {PAPER_OPTIONS.map((p) => {
            const selected = p.id === paperId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setPaperId(p.id)}
                aria-pressed={selected}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  border: '2px solid',
                  borderColor: selected ? 'var(--ws-navy)' : 'var(--ws-control-ring)',
                  borderRadius: 8,
                  padding: '4px 10px 4px 4px',
                  background: 'transparent',
                  fontFamily: 'var(--capiro-type-family-sans)',
                }}
              >
                <span
                  style={{
                    width: 22,
                    height: 28,
                    borderRadius: 3,
                    background: p.color,
                    border: '1px solid var(--ws-line)',
                    display: 'inline-block',
                  }}
                  aria-hidden
                />
                <span style={{ fontSize: 12, color: 'var(--ws-ink)' }}>{p.label}</span>
              </button>
            );
          })}
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--ws-muted)',
            marginTop: 10,
            fontStyle: 'italic',
          }}
        >
          Paper preview is local only — not persisted (see GAPS.md §1).
        </div>
      </div>
    </div>
  );
}

/** A small paper sheet preview rendered with the chosen paper color. */
function PaperMiniature({ paperColor }: { paperColor: string }) {
  return (
    <div
      style={{
        background: paperColor,
        border: '1px solid var(--ws-line)',
        borderRadius: 4,
        padding: '10px 12px',
        boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
        fontFamily: 'var(--capiro-type-family-serif)',
      }}
      aria-hidden
    >
      <div
        style={{
          height: 10,
          width: '70%',
          background: 'var(--ws-ink)',
          opacity: 0.8,
          borderRadius: 2,
          marginBottom: 8,
        }}
      />
      <div style={lineStyle(90)} />
      <div style={lineStyle(100)} />
      <div style={lineStyle(80)} />
      <div style={lineStyle(95)} />
    </div>
  );
}

function lineStyle(widthPct: number): CSSProperties {
  return {
    height: 4,
    width: `${widthPct}%`,
    background: 'var(--ws-control-ring)',
    borderRadius: 2,
    marginBottom: 5,
  };
}

export default WorkspaceCreationVNext;
