import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { compareDefenseBudget, type DefenseCompareFilters } from './defense-research-api.js';
import { loadSavedDefenseComparison } from './defense-research-api.js';
import { DefenseCompareSavePanel } from './DefenseCompareSavePanel.js';
import { DefenseSavedComparisonActions } from './DefenseSavedComparisonActions.js';
import { useAuth } from '@clerk/clerk-react';
import { useImpersonation } from '../../../state/impersonation.js';
import './defense-research.css';

const SUBJECT_TYPES = [
  'program_element',
  'program',
  'project',
  'budget_line',
  'context_document',
] as const;
type SubjectType = (typeof SUBJECT_TYPES)[number];

function parseSubject(subject: string): { type: SubjectType; id: string } | null {
  const separator = subject.indexOf(':');
  if (separator < 1 || separator === subject.length - 1) return null;
  const type = subject.slice(0, separator);
  const id = subject.slice(separator + 1);
  if (!SUBJECT_TYPES.includes(type as SubjectType) || !id.trim()) return null;
  return { type: type as SubjectType, id: id.trim() };
}

function SubjectInput({
  value,
  onChange,
  placeholder = 'program_element:PE123456',
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const parsed = parseSubject(value);
  const isValid = value === '' || parsed !== null;

  return (
    <div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`dr-input ${!isValid ? 'is-invalid' : ''}`}
        aria-label="Subject identifier"
        disabled={disabled}
      />
      {!isValid && value ? (
        <small className="dr-input-hint">
          Format: type:id (e.g., program_element:PE123456, program:P123, project:PROJ-1,
          budget_line:BL-2025)
        </small>
      ) : null}
    </div>
  );
}

function PeCompareAuthorityView({
  authority,
}: {
  authority: readonly [string | null, string | null, string | null];
}) {
  const api = useApi();
  const [params, setParams] = useSearchParams();

  const [pendingCapture, setPendingSave] = useState(() => {
    try {
      return !!localStorage.getItem(
        'capiro:defense-compare-pending:v1:' + JSON.stringify(authority),
      );
    } catch {
      return true;
    }
  });
  const [pendingAction, setPendingAction] = useState(() => {
    try {
      return !!localStorage.getItem(
        'capiro:defense-compare-action-pending:v1:' + JSON.stringify(authority),
      );
    } catch {
      return true;
    }
  });
  const pendingSave = pendingCapture || pendingAction;
  const savedId = params.get('saved');
  const savedVersion = params.get('savedVersion') ?? undefined;
  const saved = useQuery({
    queryKey: ['defense-saved-comparison', ...authority, savedId, savedVersion],
    queryFn: () => loadSavedDefenseComparison(api, savedId!, savedVersion),
    enabled: !!savedId && !!authority[0],
  });
  const rawSubjects = params.get('subjects')?.split(',').filter(Boolean) ?? [];
  const subjects =
    savedId && saved.data
      ? saved.data.currentVersion.subjects.map((subject) => subject.type + ':' + subject.id)
      : rawSubjects.map((s) => s.trim());

  const updateSubjects = (newSubjects: string[]) => {
    if (pendingSave) return;
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('saved');
      next.delete('savedVersion');
      if (newSubjects.length) {
        next.set('subjects', newSubjects.join(','));
      } else {
        next.delete('subjects');
      }
      return next;
    });
  };

  const addSubject = (subject: string) => {
    if (subject && !subjects.includes(subject)) {
      updateSubjects([...subjects, subject]);
    }
  };

  const removeSubject = (index: number) => {
    updateSubjects(subjects.filter((_, i) => i !== index));
  };

  const compareEnabled =
    subjects.length >= 2 && subjects.length <= 5 && subjects.every((s) => parseSubject(s) !== null);

  const comparison = useQuery({
    queryKey: ['defense-compare', ...authority, subjects],
    queryFn: () =>
      compareDefenseBudget(api, {
        subjects,
      }),
    enabled: compareEnabled && !savedId && !!authority[0],
  });

  const displayComparison = savedId
    ? saved.data?.currentVersion.capturedProjection
    : comparison.data;
  const loadSaved = (id: string) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set('saved', id);
      next.delete('savedVersion');
      return next;
    });
  const editSaved = () =>
    updateSubjects(
      saved.data?.currentVersion.subjects.map((subject) => subject.type + ':' + subject.id) ??
        subjects,
    );

  const [newSubject, setNewSubject] = useState('');

  return (
    <main className="dr-page" data-screen-label="Defense comparison">
      <header className="dr-head">
        <div>
          <p className="dr-eyebrow">Intelligence · Compare</p>
          <h1>Cross-subject defense comparison</h1>
          <p>
            Compare program elements, programs, projects, and budget lines across availability,
            metrics, and alignment states. Missing/unavailable cells are distinct from zero.
          </p>
        </div>
        <a href="/program-elements">Back to Intelligence</a>
      </header>

      <section className="dr-section">
        <h2>Subjects to compare (2–5)</h2>
        <p>
          Add typed identifiers (context documents support exact-revision passage alignment):{' '}
          <code>program_element:PE123456</code>, <code>program:P123</code>,{' '}
          <code>project:PROJ-1</code>, <code>budget_line:BL-2025</code>,{' '}
          <code>context_document:&lt;uuid&gt;</code>
        </p>

        <div className="dr-compare-subjects">
          {subjects.map((subject, idx) => {
            const parsed = parseSubject(subject);
            return (
              <div key={idx} className="dr-subject-chip">
                <span className={parsed ? '' : 'is-invalid'}>{subject}</span>
                <button
                  type="button"
                  className="dr-chip-remove"
                  disabled={pendingSave}
                  onClick={() => removeSubject(idx)}
                  aria-label={`Remove ${subject}`}
                >
                  ×
                </button>
              </div>
            );
          })}
          {subjects.length < 5 ? (
            <form
              className="dr-add-subject"
              onSubmit={(e) => {
                e.preventDefault();
                if (newSubject.trim()) {
                  addSubject(newSubject.trim());
                  setNewSubject('');
                }
              }}
            >
              <SubjectInput value={newSubject} onChange={setNewSubject} disabled={pendingSave} />
              <button type="submit" disabled={pendingSave || !parseSubject(newSubject)}>
                Add
              </button>
            </form>
          ) : null}
        </div>

        {subjects.length > 0 && subjects.some((s) => parseSubject(s) === null) && (
          <p className="dr-warning" role="alert">
            Some identifiers are malformed and will be ignored.
          </p>
        )}
      </section>

      <DefenseCompareSavePanel
        key={JSON.stringify(authority)}
        authority={authority}
        comparison={displayComparison}
        saved={savedId ? saved.data : undefined}
        onLoad={loadSaved}
        onEdit={editSaved}
        onPendingChange={setPendingSave}
        externalLocked={pendingAction}
      />
      <DefenseSavedComparisonActions
        key={'actions:' + JSON.stringify(authority)}
        authority={authority}
        saved={savedId ? saved.data : undefined}
        onLoad={loadSaved}
        onPendingChange={setPendingAction}
        disabled={pendingCapture}
      />
      {savedId && saved.isError ? (
        <p role="alert">The saved comparison could not be opened.</p>
      ) : null}
      {compareEnabled || savedId ? (
        <section className="dr-section">
          <h2>Comparison</h2>
          {(savedId ? saved.isPending : comparison.isPending) ? (
            <p role="status">Loading comparison…</p>
          ) : (savedId ? saved.isError : comparison.isError) ? (
            <p role="alert">The comparison could not be loaded.</p>
          ) : displayComparison ? (
            <>
              <div className="dr-comparison-meta">
                <span>Projection version: {displayComparison.projectionVersion}</span>
                {displayComparison.limitations.length > 0 && (
                  <details className="dr-limitations">
                    <summary>Limitations ({displayComparison.limitations.length})</summary>
                    <ul>
                      {displayComparison.limitations.map((limitation, idx) => (
                        <li key={idx}>{limitation}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>

              <div className="dr-subjects-header">
                {displayComparison.subjects.map((subject) => (
                  <div key={subject.key} className="dr-subject-header">
                    <h3>{subject.label}</h3>
                    <span className={`dr-availability-${subject.availability}`}>
                      {subject.availability}
                    </span>
                  </div>
                ))}
              </div>

              <div className="dr-comparison-table">
                <div className="dr-metrics-header">
                  <div>Metric</div>
                  <div>Period</div>
                  <div>Unit</div>
                  {displayComparison.subjects.map((subject) => (
                    <div key={subject.key}>{subject.type}</div>
                  ))}
                </div>

                {displayComparison.metrics.map((metric) => (
                  <div key={metric.key} className="dr-metric-row">
                    <div className="dr-metric-label">{metric.label}</div>
                    <div className="dr-metric-period">{metric.period ?? '—'}</div>
                    <div className="dr-metric-unit">{metric.unit ?? '—'}</div>
                    {metric.cells.map((cell) => (
                      <div
                        key={`${metric.key}-${cell.subjectKey}`}
                        className={`dr-cell dr-disposition-${cell.disposition}`}
                        title={cell.reason ?? undefined}
                      >
                        {cell.disposition === 'observed'
                          ? (cell.value ?? '—')
                          : cell.disposition.toUpperCase()}
                        {cell.evidence.length > 0 ? (
                          <small className="dr-evidence-count">
                            {cell.evidence.map((evidence, evidenceIndex) =>
                              evidence.sourceUrl ? (
                                <a
                                  key={evidence.evidenceRefId}
                                  href={evidence.sourceUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Source {evidenceIndex + 1}
                                </a>
                              ) : (
                                <span key={evidence.evidenceRefId}>Locator unavailable</span>
                              ),
                            )}
                          </small>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {displayComparison.alignments.length > 0 && (
                <div className="dr-alignments">
                  <h3>Alignments</h3>
                  {displayComparison.alignments.map((alignment, idx) => (
                    <div key={idx} className={`dr-alignment dr-state-${alignment.state}`}>
                      <span className="dr-alignment-kind">{alignment.kind}</span>
                      <span className="dr-alignment-state">{alignment.state}</span>
                      {alignment.reason && <p>{alignment.reason}</p>}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : null}
        </section>
      ) : subjects.length > 0 ? (
        <section className="dr-section">
          <p className="dr-notice">
            {subjects.length < 2
              ? 'Add at least 2 subjects to compare.'
              : 'Some subject identifiers are malformed.'}
          </p>
        </section>
      ) : null}

      <nav className="dr-page-nav">
        <a href="/program-elements/research">Research</a>
        <a href="/program-elements/coverage">Coverage</a>
      </nav>
    </main>
  );
}

export function PeCompareView() {
  const { userId, orgId } = useAuth();
  const { actAsTenantSlug } = useImpersonation();
  const authority = [userId ?? null, orgId ?? null, actAsTenantSlug ?? null] as const;
  return <PeCompareAuthorityView key={JSON.stringify(authority)} authority={authority} />;
}
