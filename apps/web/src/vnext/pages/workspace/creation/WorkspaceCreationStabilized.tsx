import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CapiroButton } from '../../../components/actions/index.js';
import { api } from '../api/client.js';
import type {
  BlueprintDefinition,
  BlueprintSummary,
  BlueprintVersion,
  BlueprintVersionSummary,
  DocumentType,
  RecommendResponse,
} from '../types/agent.js';
import '../styles/workspace.css';
import '../styles/workspace-audit.css';

type CreationStep = 'goal' | 'type' | 'blueprint' | 'design';

const STEPS: ReadonlyArray<{ id: CreationStep; label: string }> = [
  { id: 'goal', label: 'Goal' },
  { id: 'type', label: 'Type' },
  { id: 'blueprint', label: 'Blueprint' },
  { id: 'design', label: 'Design' },
];

const PAPER_OPTIONS = [
  { id: 'ivory', label: 'Ivory', color: '#FEFDFA' },
  { id: 'white', label: 'Bright white', color: '#FFFFFF' },
  { id: 'cream', label: 'Warm cream', color: '#FBF6EC' },
  { id: 'grey', label: 'Cool grey', color: '#F7F8FA' },
] as const;

function isCreationStep(value: string | null): value is CreationStep {
  return STEPS.some((step) => step.id === value);
}

function latestPublishedVersion(
  blueprint: BlueprintSummary,
): BlueprintVersionSummary | null {
  return (blueprint.versions ?? [])
    .filter((version) => version.status === 'published')
    .sort((a, b) => b.version - a.version)[0] ?? null;
}

function titleFor(
  documentType: DocumentType,
  client: string | null,
): string {
  return client
    ? `${documentType.label} — ${client}`
    : documentType.label;
}

function compactHash(value: string | undefined): string {
  return value ? value.slice(0, 6) : '—';
}

function LoadingCards() {
  return (
    <div className="ws-audit-creation-grid" role="status" aria-busy="true">
      {Array.from({ length: 4 }, (_, index) => (
        <div className="ws-audit-choice-card" key={index}>
          <div className="ws-vnext-skeleton-row" style={{ width: '55%' }} />
          <div className="ws-vnext-skeleton-row" style={{ width: '90%' }} />
          <div className="ws-vnext-skeleton-row" style={{ width: '72%' }} />
        </div>
      ))}
    </div>
  );
}

export function WorkspaceCreationStabilized() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedStep = searchParams.get('step');
  const step: CreationStep = isCreationStep(requestedStep)
    ? requestedStep
    : 'goal';

  const [goal, setGoal] = useState('');
  const [client, setClient] = useState('');
  const [recommendation, setRecommendation] =
    useState<RecommendResponse | null>(null);
  const [recommendationSkipped, setRecommendationSkipped] = useState(false);
  const [catalog, setCatalog] = useState<DocumentType[]>([]);
  const [blueprints, setBlueprints] = useState<BlueprintSummary[]>([]);
  const [definitions, setDefinitions] = useState<
    Record<string, BlueprintDefinition>
  >({});
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(null);
  const [selectedBlueprintId, setSelectedBlueprintId] =
    useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] =
    useState<BlueprintVersionSummary | null>(null);
  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(null);
  const [paperId, setPaperId] = useState('ivory');
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [loadingBlueprints, setLoadingBlueprints] = useState(false);
  const [asking, setAsking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlocked = Boolean(recommendation || recommendationSkipped);
  const selectedType = useMemo(
    () => catalog.find((item) => item.id === selectedTypeId) ?? null,
    [catalog, selectedTypeId],
  );
  const selectedBlueprint = useMemo(
    () =>
      blueprints.find((item) => item.blueprintId === selectedBlueprintId) ??
      null,
    [blueprints, selectedBlueprintId],
  );
  const selectedDefinition = selectedBlueprintId
    ? definitions[selectedBlueprintId]
    : undefined;

  const visibleBlueprints = useMemo(() => {
    if (!selectedType) return [];
    return blueprints.filter(
      (blueprint) => blueprint.documentType === selectedType.product,
    );
  }, [blueprints, selectedType]);

  const themeOptions = useMemo(() => {
    const options: Array<{
      id: string;
      name: string;
      settings: Record<string, unknown>;
      source: 'blueprint' | 'recommended';
    }> = [];
    const defaultTheme = selectedDefinition?.defaultTheme;
    if (defaultTheme) {
      options.push({
        id: defaultTheme.id,
        name: defaultTheme.name,
        settings: defaultTheme.settings ?? {},
        source: 'blueprint',
      });
    }
    if (
      recommendation?.recommendedTheme &&
      !options.some(
        (option) => option.id === recommendation.recommendedTheme.id,
      )
    ) {
      options.push({
        id: recommendation.recommendedTheme.id,
        name: recommendation.recommendedTheme.name,
        settings: {},
        source: 'recommended',
      });
    }
    return options;
  }, [recommendation, selectedDefinition]);

  const selectedTheme =
    themeOptions.find((option) => option.id === selectedThemeId) ?? null;
  const selectedPaper =
    PAPER_OPTIONS.find((option) => option.id === paperId) ?? PAPER_OPTIONS[0];

  useEffect(() => {
    let active = true;
    setLoadingCatalog(true);
    api
      .getCatalog()
      .then((response) => {
        if (!active) return;
        setCatalog(response.documentTypes ?? []);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setError(
          caught instanceof Error
            ? caught.message
            : 'Could not load the document catalog.',
        );
      })
      .finally(() => active && setLoadingCatalog(false));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!recommendation || selectedTypeId) return;
    if (
      catalog.some((item) => item.id === recommendation.documentType.id)
    ) {
      setSelectedTypeId(recommendation.documentType.id);
      return;
    }
    const productMatch = catalog.find(
      (item) => item.product === recommendation.documentType.product,
    );
    if (productMatch) setSelectedTypeId(productMatch.id);
  }, [catalog, recommendation, selectedTypeId]);

  useEffect(() => {
    if (step !== 'blueprint' && step !== 'design') return;
    if (blueprints.length || loadingBlueprints) return;
    let active = true;
    setLoadingBlueprints(true);
    api
      .listBlueprints()
      .then((response) => {
        if (!active) return;
        setBlueprints(response.blueprints ?? []);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setError(
          caught instanceof Error
            ? caught.message
            : 'Could not load blueprints.',
        );
      })
      .finally(() => active && setLoadingBlueprints(false));
    return () => {
      active = false;
    };
  }, [blueprints.length, loadingBlueprints, step]);

  useEffect(() => {
    if (!visibleBlueprints.length) return;
    const missing = visibleBlueprints.filter(
      (blueprint) => !definitions[blueprint.blueprintId],
    );
    if (!missing.length) return;
    let active = true;
    for (const blueprint of missing) {
      void api
        .getBlueprint(blueprint.blueprintId)
        .then((full) => {
          if (!active) return;
          const versions = (full.versions ?? []) as BlueprintVersion[];
          const version =
            versions
              .filter((item) => item.status === 'published')
              .sort((a, b) => b.version - a.version)[0] ?? null;
          if (version?.definition) {
            setDefinitions((previous) => ({
              ...previous,
              [blueprint.blueprintId]: version.definition,
            }));
          }
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [definitions, visibleBlueprints]);

  useEffect(() => {
    if (!recommendation || selectedBlueprintId || !visibleBlueprints.length) {
      return;
    }
    const recommendedIds = new Set(
      recommendation.recommendedBlueprints.map((item) => item.blueprintId),
    );
    const blueprint = visibleBlueprints.find(
      (item) =>
        recommendedIds.has(item.blueprintId) &&
        latestPublishedVersion(item),
    );
    if (!blueprint) return;
    setSelectedBlueprintId(blueprint.blueprintId);
    setSelectedVersion(latestPublishedVersion(blueprint));
  }, [recommendation, selectedBlueprintId, visibleBlueprints]);

  useEffect(() => {
    if (selectedThemeId || !themeOptions.length) return;
    setSelectedThemeId(themeOptions[0]?.id ?? null);
  }, [selectedThemeId, themeOptions]);

  const goTo = (next: CreationStep) => {
    if (next !== 'goal' && !unlocked) return;
    setSearchParams({ step: next });
  };

  const currentIndex = STEPS.findIndex((item) => item.id === step);
  const canContinue =
    step === 'goal'
      ? unlocked
      : step === 'type'
        ? Boolean(selectedType)
        : step === 'blueprint'
          ? Boolean(selectedVersion)
          : Boolean(selectedType && selectedVersion);

  const askMeri = async () => {
    if (!goal.trim() || asking) return;
    setAsking(true);
    setError(null);
    try {
      const response = await api.recommend(
        goal.trim(),
        client.trim() || undefined,
      );
      setRecommendation(response);
      setRecommendationSkipped(false);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Meri could not recommend a setup.',
      );
    } finally {
      setAsking(false);
    }
  };

  const createDocument = async () => {
    if (!selectedType || !selectedBlueprint || !selectedVersion || creating) {
      return;
    }
    setCreating(true);
    setError(null);
    let draftId: string | null = null;
    try {
      const created = await api.createDraft({
        docTitle: titleFor(selectedType, client.trim() || null),
        product: selectedType.product,
        client: client.trim() || null,
      });
      draftId = created.id;
      await api.initializeAgent(draftId, {
        documentType: selectedType,
        blueprintPin: {
          blueprintId: selectedBlueprint.blueprintId,
          versionId: selectedVersion.versionId,
          version: selectedVersion.version,
          definitionHash: selectedVersion.definitionHash ?? '',
        },
        theme: selectedTheme
          ? {
              id: selectedTheme.id,
              name: selectedTheme.name,
              settings: {
                ...selectedTheme.settings,
                paperColor: selectedPaper.color,
              },
            }
          : undefined,
        goal: goal.trim() || undefined,
      });
      navigate(`/workspace/${draftId}`);
    } catch (caught) {
      if (draftId) {
        try {
          await api.deleteDraft(draftId);
        } catch {
          // The primary failure remains the actionable message.
        }
      }
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not create this document.',
      );
      setCreating(false);
    }
  };

  return (
    <div className="ws-vnext-creation ws-audit-creation">
      <header className="ws-audit-creation__header">
        <div>
          <div className="ws-audit-eyebrow">CREATE DOCUMENT</div>
          <h1>What do you need to accomplish?</h1>
          <p>
            Start with the goal. Meri will recommend the document type,
            blueprint, and design for you to confirm.
          </p>
        </div>
        <CapiroButton
          variant="quiet"
          size="compact"
          onClick={() => navigate('/workspace')}
        >
          Cancel
        </CapiroButton>
      </header>

      <nav className="ws-audit-creation__steps" aria-label="Creation steps">
        {STEPS.map((item, index) => {
          const current = item.id === step;
          const complete = index < currentIndex;
          const enabled = item.id === 'goal' || unlocked;
          return (
            <button
              key={item.id}
              type="button"
              disabled={!enabled}
              data-current={current}
              data-complete={complete}
              onClick={() => goTo(item.id)}
            >
              <span>{complete ? '✓' : index + 1}</span>
              {item.label}
            </button>
          );
        })}
      </nav>

      {error ? (
        <div className="ws-vnext-banner" data-variant="red" role="alert">
          <span className="ws-vnext-banner__text">{error}</span>
          <button
            className="ws-vnext-banner__action"
            type="button"
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <main className="ws-audit-creation__body">
        {step === 'goal' ? (
          <section className="ws-audit-creation-panel">
            <label htmlFor="workspace-goal">
              What should this document achieve?
            </label>
            <textarea
              id="workspace-goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="Describe the audience, requested action, and the result you need."
            />
            <label htmlFor="workspace-client">Client (optional)</label>
            <input
              id="workspace-client"
              value={client}
              onChange={(event) => setClient(event.target.value)}
              placeholder="Client or organization"
            />
            <div className="ws-audit-actions">
              <CapiroButton
                variant="primary"
                loading={asking}
                disabled={!goal.trim()}
                onClick={() => void askMeri()}
              >
                Ask Meri
              </CapiroButton>
              <CapiroButton
                variant="quiet"
                disabled={asking}
                onClick={() => {
                  setRecommendationSkipped(true);
                  setRecommendation(null);
                }}
              >
                Skip — choose manually
              </CapiroButton>
            </div>

            {recommendation ? (
              <div className="ws-audit-recommendation">
                <div className="ws-audit-eyebrow">MERI’S RECOMMENDATION</div>
                <p>{recommendation.rationale}</p>
                <div className="ws-audit-recommendation__facts">
                  <div><span>Type</span><strong>{recommendation.documentType.label}</strong></div>
                  <div><span>Blueprint</span><strong>{recommendation.recommendedBlueprints[0]?.name ?? '—'}</strong></div>
                  <div><span>Theme</span><strong>{recommendation.recommendedTheme.name}</strong></div>
                </div>
                {recommendation.questions.length ? (
                  <div className="ws-audit-questions">
                    <div className="ws-audit-eyebrow">QUESTIONS MERI WILL ASK IN THE DOCUMENT</div>
                    {recommendation.questions.map((question) => (
                      <div key={question.id}>{question.required ? <span>Required</span> : null}{question.label}</div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : recommendationSkipped ? (
              <div className="ws-vnext-callout">You can choose the type, blueprint, and design yourself.</div>
            ) : null}
          </section>
        ) : null}

        {step === 'type' ? (
          <section>
            <div className="ws-audit-section-heading"><div><div className="ws-audit-eyebrow">DOCUMENT TYPE</div><h2>Choose the work product</h2></div></div>
            {loadingCatalog ? <LoadingCards /> : (
              <div className="ws-audit-creation-grid">
                {catalog.map((item) => (
                  <button type="button" key={item.id} className="ws-audit-choice-card" data-selected={item.id === selectedTypeId} onClick={() => { setSelectedTypeId(item.id); setSelectedBlueprintId(null); setSelectedVersion(null); setSelectedThemeId(null); }}>
                    <div className="ws-audit-eyebrow">{item.product}</div><strong>{item.label}</strong>
                    {recommendation?.documentType.product === item.product ? <span className="ws-vnext-status-pill" data-status="ready"><span className="ws-vnext-status-pill__dot" />Meri recommends</span> : null}
                  </button>
                ))}
              </div>
            )}
          </section>
        ) : null}

        {step === 'blueprint' ? (
          <section>
            <div className="ws-audit-section-heading"><div><div className="ws-audit-eyebrow">BLUEPRINT</div><h2>Choose the document structure</h2></div></div>
            {loadingBlueprints ? <LoadingCards /> : visibleBlueprints.length ? (
              <div className="ws-audit-blueprint-list">
                {visibleBlueprints.map((blueprint) => {
                  const version = latestPublishedVersion(blueprint);
                  const definition = definitions[blueprint.blueprintId];
                  const recommended = recommendation?.recommendedBlueprints.some((item) => item.blueprintId === blueprint.blueprintId);
                  return (
                    <button type="button" key={blueprint.blueprintId} className="ws-audit-blueprint-row" data-selected={blueprint.blueprintId === selectedBlueprintId} disabled={!version} onClick={() => { setSelectedBlueprintId(blueprint.blueprintId); setSelectedVersion(version); setSelectedThemeId(null); }}>
                      <div>
                        <div className="ws-audit-blueprint-row__title">{blueprint.name}<span className="ws-vnext-scope-badge" data-scope={blueprint.scope}>{blueprint.scope === 'firm' ? 'Firm' : 'Capiro global'}</span>{recommended ? <span className="ws-vnext-status-pill" data-status="ready"><span className="ws-vnext-status-pill__dot" />Meri recommends</span> : null}</div>
                        <p>{blueprint.description || 'No description.'}</p>
                        <div className="ws-audit-blueprint-row__facts"><span>{definition?.sections?.length ?? '—'} sections</span><span>{definition?.evidencePolicy?.minimumSources ?? '—'} minimum sources</span><span>{definition?.approvalPolicy?.clientFacingApprovalRequired ? 'Approval required' : 'No approval requirement'}</span></div>
                      </div>
                      <div className="ws-audit-blueprint-row__version">{version ? `v${version.version} · ${compactHash(version.definitionHash)}` : 'Draft only · cannot be pinned'}</div>
                    </button>
                  );
                })}
              </div>
            ) : <div className="ws-vnext-empty"><div className="ws-vnext-empty__title">No published blueprints for this type</div><div className="ws-vnext-empty__desc">Choose a different type or ask a firm administrator to publish a blueprint.</div></div>}
          </section>
        ) : null}

        {step === 'design' ? (
          <section>
            <div className="ws-audit-section-heading"><div><div className="ws-audit-eyebrow">DESIGN</div><h2>Confirm the presentation</h2></div></div>
            <div className="ws-audit-design-grid">
              <div>
                <div className="ws-audit-theme-list">
                  {themeOptions.length ? themeOptions.map((theme) => (
                    <button type="button" key={theme.id} className="ws-audit-choice-card" data-selected={theme.id === selectedThemeId} onClick={() => setSelectedThemeId(theme.id)}>
                      <div className="ws-audit-paper-miniature"><span /><strong>Executive ask</strong><i /><i /><i /></div><strong>{theme.name}</strong><span className="ws-audit-choice-card__meta">{theme.source === 'blueprint' ? 'Blueprint default' : 'Meri recommendation'}</span>
                    </button>
                  )) : <div className="ws-vnext-callout">The backend will apply its default theme.</div>}
                </div>
                <div className="ws-audit-paper-picker"><div className="ws-audit-eyebrow">PAPER</div>{PAPER_OPTIONS.map((paper) => <button type="button" key={paper.id} data-selected={paper.id === paperId} onClick={() => setPaperId(paper.id)}><span style={{ background: paper.color }} />{paper.label}</button>)}</div>
              </div>
              <div className="ws-audit-design-preview" style={{ background: selectedPaper.color }}>
                <div className="ws-audit-eyebrow">{selectedType?.label ?? 'DOCUMENT'}</div>
                <h2>{titleFor(selectedType ?? { id: '', label: 'Untitled document', product: '' }, client.trim() || null)}</h2>
                <div className="ws-audit-design-preview__ask"><span>EXECUTIVE ASK</span><p>The requested action will appear here.</p></div>
                <h3>Mission need</h3><p>The approved outline and evidence plan will shape this section.</p>
                <h3>Requested action</h3><p>The generated document will use this theme and paper setting.</p>
              </div>
            </div>
          </section>
        ) : null}
      </main>

      <footer className="ws-audit-creation__footer">
        <CapiroButton variant="quiet" disabled={currentIndex === 0 || creating} onClick={() => { const previous = STEPS[currentIndex - 1]; if (previous) goTo(previous.id); }}>Back</CapiroButton>
        <span>Step {currentIndex + 1} of {STEPS.length}</span>
        {step === 'design' ? <CapiroButton variant="primary" loading={creating} disabled={!canContinue} onClick={() => void createDocument()}>Create document</CapiroButton> : <CapiroButton variant="primary" disabled={!canContinue} onClick={() => { const next = STEPS[currentIndex + 1]; if (next) goTo(next.id); }}>Continue</CapiroButton>}
      </footer>
    </div>
  );
}

export default WorkspaceCreationStabilized;
