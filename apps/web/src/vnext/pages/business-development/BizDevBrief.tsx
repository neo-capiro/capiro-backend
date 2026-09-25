import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AxiosInstance } from 'axios';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroEmptyState, CapiroErrorState } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import {
  BIZDEV_BRIEF_SECTION_KEYS,
  acceptBizDevBriefRefresh,
  bizdevErrorMessage,
  bizdevKeys,
  createBizDevBrief,
  getBizDevBriefRefreshProposal,
  getBizDevBriefVersion,
  getBizDevCurrentBrief,
  listBizDevBriefVersions,
  newBizDevIdempotencyKey,
  resolveBizDevBriefCitation,
  saveBizDevBrief,
  type BizDevBriefCitation,
  type BizDevBriefSections,
  type BizDevBriefSectionKey,
  type BizDevBriefVersionDetail,
  type BizDevEvidenceItem,
  type BizDevProspect,
} from './bizdev-api.js';

const SECTION_LABELS: Record<BizDevBriefSectionKey, string> = {
  companyAndFirmImplication: 'Company and firm implication',
  verifiedEvidence: 'Verified evidence',
  judgment: 'Judgment',
  practicalAction: 'Practical action',
  missingInformation: 'Missing information',
};

function dateTime(value: string | null | undefined): string {
  if (!value) return 'Not supplied';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function editableSections(version: BizDevBriefVersionDetail): BizDevBriefSections {
  return Object.fromEntries(
    BIZDEV_BRIEF_SECTION_KEYS.map((key) => [key, { ...version.sections[key] }]),
  ) as BizDevBriefSections;
}

function conflictPayload(error: unknown): { message: string; latestVersionNumber: number } | null {
  if (!error || typeof error !== 'object' || !('response' in error)) return null;
  const data = (error as {
    response?: { data?: { code?: unknown; message?: unknown; latestVersion?: { versionNumber?: unknown } } };
  }).response?.data;
  if (data?.code !== 'BIZDEV_BRIEF_VERSION_CONFLICT') return null;
  return {
    message:
      typeof data.message === 'string'
        ? data.message
        : 'A newer version was saved. Your unsaved edits are still here for reconciliation.',
    latestVersionNumber:
      typeof data.latestVersion?.versionNumber === 'number'
        ? data.latestVersion.versionNumber
        : 0,
  };
}

function findSnapshotEvidence(
  version: BizDevBriefVersionDetail,
  citation: BizDevBriefCitation,
): BizDevEvidenceItem | null {
  return (
    version.sourceSnapshot.evidence.find(
      (item) =>
        item.sourceFamily === citation.sourceFamily &&
        (item.recordId ?? item.originalSourceId ?? '(no record id)') === citation.recordId,
    ) ?? null
  );
}

function CitationInspector({
  citation,
  evidence,
  limitation,
}: {
  citation: BizDevBriefCitation | null;
  evidence: BizDevEvidenceItem | null;
  limitation?: string | null;
}) {
  if (!citation) {
    return (
      <div className="capiro-bizdev__brief-inspector" role="status">
        <strong>Source unavailable</strong>
        <p>{limitation ?? 'This citation could not be resolved.'}</p>
      </div>
    );
  }
  return (
    <aside className="capiro-bizdev__brief-inspector" aria-label={`Source: ${citation.title}`}>
      <div className="capiro-bizdev__brief-inspector-head">
        <div>
          <span className="capiro-bizdev__meta">Source inspector</span>
          <h4>{citation.title}</h4>
        </div>
        <span className="capiro-bizdev__flag capiro-bizdev__flag--direct">
          {citation.relationshipStrength}
        </span>
      </div>
      {limitation ? <p className="capiro-bizdev__brief-limitation">{limitation}</p> : null}
      <dl className="capiro-bizdev__source-list">
        <div><dt>Provider</dt><dd>{citation.originalSourceName ?? citation.sourceFamily}</dd></div>
        <div><dt>Record</dt><dd>{citation.originalSourceId ?? citation.recordId}</dd></div>
        <div><dt>Event date</dt><dd>{dateTime(citation.eventDate)}</dd></div>
        <div><dt>Publication / source update</dt><dd>{dateTime(citation.sourceUpdatedAt)}</dd></div>
        <div><dt>Retrieved</dt><dd>{dateTime(citation.retrievedAt)}</dd></div>
        <div><dt>Stage</dt><dd>{citation.stage ?? 'Not supplied'}</dd></div>
        <div><dt>Source status</dt><dd>{evidence?.status ?? 'Saved snapshot only'}</dd></div>
        <div>
          <dt>Record link</dt>
          <dd>
            {citation.locator ? (
              <a href={citation.locator} target="_blank" rel="noreferrer">
                Open precise source record
              </a>
            ) : (
              'Not supplied'
            )}
          </dd>
        </div>
      </dl>
    </aside>
  );
}

export function BizDevBrief({
  api,
  tenantId,
  prospect,
  meriEnabled,
  onDraftWithMeri,
}: {
  api: AxiosInstance;
  tenantId: string;
  prospect: BizDevProspect;
  meriEnabled: boolean;
  onDraftWithMeri: () => void;
}) {
  const toast = useCapiroToast();
  const queryClient = useQueryClient();
  const current = useQuery({
    queryKey: bizdevKeys.brief(tenantId, prospect.id),
    queryFn: () => getBizDevCurrentBrief(api, prospect.id),
    networkMode: 'always',
  });
  const versions = useQuery({
    queryKey: bizdevKeys.briefVersions(tenantId, prospect.id),
    queryFn: () => listBizDevBriefVersions(api, prospect.id),
    enabled: Boolean(current.data?.brief),
  });

  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const historical = useQuery({
    queryKey: [...bizdevKeys.briefVersions(tenantId, prospect.id), viewVersion],
    queryFn: () => getBizDevBriefVersion(api, prospect.id, viewVersion!),
    enabled:
      viewVersion != null && viewVersion !== current.data?.currentVersion?.versionNumber,
  });
  const displayedVersion =
    viewVersion != null && viewVersion !== current.data?.currentVersion?.versionNumber
      ? (historical.data ?? null)
      : (current.data?.currentVersion ?? null);
  const isHistorical = Boolean(
    displayedVersion && displayedVersion.versionNumber !== current.data?.currentVersion?.versionNumber,
  );

  const [title, setTitle] = useState('');
  const [sections, setSections] = useState<BizDevBriefSections | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [selectedCitationIndex, setSelectedCitationIndex] = useState<number | null>(null);
  const [refreshOpen, setRefreshOpen] = useState(false);

  useEffect(() => {
    const version = current.data?.currentVersion;
    if (!version || isHistorical) return;
    setTitle(current.data?.brief?.title ?? '');
    setSections(editableSections(version));
    setConflict(null);
    setSelectedCitationIndex(null);
  }, [current.data, isHistorical]);

  const createKey = useRef<string | null>(null);
  const saveKey = useRef<string | null>(null);
  const acceptKey = useRef<string | null>(null);
  const updateCaches = (result: Awaited<ReturnType<typeof createBizDevBrief>>) => {
    queryClient.setQueryData(bizdevKeys.brief(tenantId, prospect.id), {
      brief: result.brief,
      currentVersion: result.version,
    });
    void queryClient.invalidateQueries({ queryKey: bizdevKeys.briefVersions(tenantId, prospect.id) });
    setViewVersion(null);
    setRefreshOpen(false);
  };

  const create = useMutation({
    mutationFn: () => {
      createKey.current ??= newBizDevIdempotencyKey('create');
      return createBizDevBrief(api, prospect.id, { idempotencyKey: createKey.current });
    },
    onSuccess: (result) => {
      createKey.current = null;
      updateCaches(result);
      toast.success('Prospect brief created from the authorized dossier snapshot.');
    },
    onError: (error) => toast.error(bizdevErrorMessage(error)),
  });

  const save = useMutation({
    mutationFn: () => {
      if (!sections || !current.data?.currentVersion) throw new Error('No current brief to save.');
      saveKey.current ??= newBizDevIdempotencyKey('edit');
      const base = current.data.currentVersion.sections;
      const edited = Object.fromEntries(
        BIZDEV_BRIEF_SECTION_KEYS.map((key) => [
          key,
          {
            ...sections[key],
            provenance: sections[key].text === base[key].text ? base[key].provenance : 'edited',
          },
        ]),
      ) as BizDevBriefSections;
      return saveBizDevBrief(api, prospect.id, {
        idempotencyKey: saveKey.current,
        expectedVersionNumber: current.data.currentVersion.versionNumber,
        sections: edited,
        title: title.trim() || undefined,
      });
    },
    onSuccess: (result) => {
      saveKey.current = null;
      updateCaches(result);
      toast.success(result.created ? `Brief version ${result.version.versionNumber} saved.` : 'Save confirmed.');
    },
    onError: (error) => {
      const versionConflict = conflictPayload(error);
      if (versionConflict) {
        setConflict(
          `${versionConflict.message}${
            versionConflict.latestVersionNumber
              ? ` The latest saved version is ${versionConflict.latestVersionNumber}.`
              : ''
          }`,
        );
        void queryClient.invalidateQueries({ queryKey: bizdevKeys.brief(tenantId, prospect.id) });
        return;
      }
      toast.error(bizdevErrorMessage(error));
    },
  });

  const refresh = useMutation({
    mutationFn: () => getBizDevBriefRefreshProposal(api, prospect.id),
    onSuccess: () => setRefreshOpen(true),
    onError: (error) => toast.error(bizdevErrorMessage(error)),
  });
  const acceptRefresh = useMutation({
    mutationFn: (keepUserEdits: boolean) => {
      if (!refresh.data) throw new Error('Refresh proposal is unavailable.');
      acceptKey.current ??= newBizDevIdempotencyKey(
        keepUserEdits ? 'refresh-keep-edits' : 'refresh-replace',
      );
      return acceptBizDevBriefRefresh(api, prospect.id, {
        idempotencyKey: acceptKey.current,
        expectedVersionNumber: refresh.data.baseVersionNumber,
        keepUserEdits,
      });
    },
    onSuccess: (result) => {
      acceptKey.current = null;
      updateCaches(result);
      toast.success(`Refreshed brief saved as version ${result.version.versionNumber}.`);
    },
    onError: (error) => {
      const versionConflict = conflictPayload(error);
      if (versionConflict) setConflict(versionConflict.message);
      else toast.error(bizdevErrorMessage(error));
    },
  });

  const citationResolution = useQuery({
    queryKey: [
      ...bizdevKeys.brief(tenantId, prospect.id),
      'citation',
      selectedCitationIndex,
    ],
    queryFn: () => resolveBizDevBriefCitation(api, prospect.id, selectedCitationIndex!),
    enabled: selectedCitationIndex != null && Boolean(displayedVersion) && !isHistorical,
  });

  const hasBlankSection = useMemo(
    () => Boolean(sections && BIZDEV_BRIEF_SECTION_KEYS.some((key) => !sections[key].text.trim())),
    [sections],
  );
  const dirty = useMemo(() => {
    if (!sections || !current.data?.currentVersion) return false;
    return (
      title.trim() !== (current.data.brief?.title ?? '') ||
      BIZDEV_BRIEF_SECTION_KEYS.some(
        (key) => sections[key].text !== current.data!.currentVersion!.sections[key].text,
      )
    );
  }, [current.data, sections, title]);

  if (current.isPending) {
    return <div className="capiro-portfolio__skeleton capiro-portfolio__skeleton--tall" aria-busy="true" />;
  }
  if (current.isError) {
    return (
      <CapiroErrorState
        title="The prospect brief could not be loaded"
        description={bizdevErrorMessage(current.error)}
        onRetry={() => void current.refetch()}
        retryLabel="Retry"
      />
    );
  }
  if (!current.data?.brief || !current.data.currentVersion) {
    return (
      <CapiroEmptyState
        variant="first-use"
        title="No brief yet"
        description="Create a five-part draft from the current authorized dossier. This does not contact anyone."
        action={
          <div className="capiro-bizdev__actions">
            <CapiroButton variant="primary" size="compact" loading={create.isPending} onClick={() => create.mutate()}>
              Create grounded brief
            </CapiroButton>
            {meriEnabled ? (
              <CapiroButton size="compact" onClick={onDraftWithMeri}>Draft with Meri</CapiroButton>
            ) : null}
          </div>
        }
      />
    );
  }

  if (!displayedVersion || (isHistorical && historical.isPending)) {
    return <div className="capiro-portfolio__skeleton capiro-portfolio__skeleton--tall" aria-busy="true" />;
  }
  if (isHistorical && historical.isError) {
    return (
      <CapiroErrorState
        title="That saved version could not be loaded"
        description={bizdevErrorMessage(historical.error)}
        onRetry={() => void historical.refetch()}
        retryLabel="Retry"
      />
    );
  }

  const editorSections = isHistorical ? displayedVersion.sections : sections ?? displayedVersion.sections;
  const citation =
    selectedCitationIndex == null ? null : displayedVersion.citations[selectedCitationIndex] ?? null;
  const resolved = !isHistorical ? citationResolution.data : null;
  const inspectorCitation = resolved ? resolved.citation : citation;
  const inspectorEvidence = resolved?.resolvable
    ? resolved.currentDossierEvidence ?? resolved.sourceSnapshotEvidence
    : citation
      ? findSnapshotEvidence(displayedVersion, citation)
      : null;
  const limitation = resolved && !resolved.resolvable ? resolved.message : null;

  return (
    <div className="capiro-bizdev__brief">
      <div className="capiro-bizdev__brief-toolbar">
        <div>
          <span className="capiro-bizdev__meta">Version {displayedVersion.versionNumber}</span>
          <p className="capiro-bizdev__meta">
            Saved {dateTime(displayedVersion.createdAt)} · evidence captured{' '}
            {dateTime(displayedVersion.sourceSnapshot.generatedAt)}
          </p>
        </div>
        <div className="capiro-bizdev__actions">
          {meriEnabled ? <CapiroButton size="compact" onClick={onDraftWithMeri}>Draft with Meri</CapiroButton> : null}
          {!isHistorical ? (
            <CapiroButton size="compact" loading={refresh.isPending} onClick={() => refresh.mutate()}>
              Preview refresh
            </CapiroButton>
          ) : (
            <CapiroButton size="compact" onClick={() => setViewVersion(null)}>Return to current</CapiroButton>
          )}
        </div>
      </div>

      {!isHistorical ? (
        <label className="capiro-bizdev__field">
          <span className="capiro-bizdev__label">Brief title</span>
          <input className="capiro-bizdev__input" value={title} maxLength={300} onChange={(event) => setTitle(event.target.value)} />
        </label>
      ) : (
        <h3>{current.data.brief.title}</h3>
      )}

      {conflict ? (
        <div className="capiro-bizdev__brief-conflict" role="alert">
          <strong>Newer saved version detected</strong>
          <p>{conflict}</p>
          <p>Your text remains in this editor. Copy it before reloading, or reconcile it with the current version.</p>
        </div>
      ) : null}

      {BIZDEV_BRIEF_SECTION_KEYS.map((key) => {
        const section = editorSections[key];
        return (
          <section className="capiro-bizdev__brief-section" key={key} aria-labelledby={`brief-${key}`}>
            <div className="capiro-bizdev__brief-section-head">
              <h3 id={`brief-${key}`}>{SECTION_LABELS[key]}</h3>
              <span className="capiro-bizdev__meta">
                {section.provenance === 'edited' ? 'Edited by a user' : 'Generated from evidence'}
              </span>
            </div>
            {isHistorical ? (
              <p className="capiro-bizdev__brief-text">{section.text}</p>
            ) : (
              <textarea
                className="capiro-bizdev__textarea capiro-bizdev__brief-editor"
                aria-label={SECTION_LABELS[key]}
                value={section.text}
                maxLength={4000}
                onChange={(event) =>
                  setSections((value) =>
                    value
                      ? {
                          ...value,
                          [key]: { ...value[key], text: event.target.value, provenance: 'edited' },
                        }
                      : value,
                  )
                }
              />
            )}
            {section.citationIndexes.length ? (
              <div className="capiro-bizdev__brief-citations" aria-label={`${SECTION_LABELS[key]} sources`}>
                {section.citationIndexes.map((index) => {
                  const source = displayedVersion.citations[index];
                  return (
                    <button
                      type="button"
                      key={index}
                      className="capiro-bizdev__brief-citation"
                      aria-pressed={selectedCitationIndex === index}
                      onClick={() => setSelectedCitationIndex(index)}
                    >
                      [{index + 1}] {source?.title ?? 'Unavailable source'}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="capiro-bizdev__meta">No source citation is attached to this section.</p>
            )}
          </section>
        );
      })}

      {selectedCitationIndex != null ? (
        citationResolution.isPending && !isHistorical ? (
          <p role="status">Resolving source…</p>
        ) : (
          <CitationInspector citation={inspectorCitation} evidence={inspectorEvidence} limitation={limitation} />
        )
      ) : null}

      {!isHistorical ? (
        <div className="capiro-bizdev__brief-savebar">
          <p className="capiro-bizdev__meta">
            Saving creates a new immutable version. It never sends outreach or overwrites an earlier version.
          </p>
          <CapiroButton
            variant="primary"
            size="compact"
            loading={save.isPending}
            disabled={!dirty || hasBlankSection}
            onClick={() => save.mutate()}
          >
            Save new version
          </CapiroButton>
        </div>
      ) : null}

      {versions.data?.versions.length ? (
        <details className="capiro-bizdev__brief-history">
          <summary>Version history ({versions.data.versions.length})</summary>
          <ol>
            {versions.data.versions.map((version) => (
              <li key={version.id}>
                <button type="button" onClick={() => setViewVersion(version.versionNumber)}>
                  Version {version.versionNumber} · {dateTime(version.createdAt)} · {version.citationCount}{' '}
                  source{version.citationCount === 1 ? '' : 's'}
                </button>
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {refreshOpen && refresh.data ? (
        <div className="capiro-bizdev__brief-refresh" role="dialog" aria-modal="true" aria-labelledby="brief-refresh-title">
          <div className="capiro-bizdev__brief-refresh-card">
            <h3 id="brief-refresh-title">Review refreshed evidence proposal</h3>
            <p>
              Nothing has been saved yet. Compare the new dossier generation below, then choose how to create a new version.
            </p>
            <div className="capiro-bizdev__brief-diffs">
              {refresh.data.diff.map((entry) => (
                <section key={entry.section}>
                  <h4>{SECTION_LABELS[entry.section]}</h4>
                  {entry.changed ? (
                    <div className="capiro-bizdev__brief-diff-grid">
                      <div><strong>Saved</strong><p>{entry.baseText}</p></div>
                      <div><strong>Fresh proposal</strong><p>{entry.proposedText}</p></div>
                    </div>
                  ) : (
                    <p className="capiro-bizdev__meta">No evidence-backed text change.</p>
                  )}
                </section>
              ))}
            </div>
            <div className="capiro-bizdev__actions capiro-bizdev__brief-refresh-actions">
              <CapiroButton size="compact" onClick={() => setRefreshOpen(false)}>Cancel</CapiroButton>
              <CapiroButton size="compact" loading={acceptRefresh.isPending} onClick={() => acceptRefresh.mutate(false)}>
                Replace with fresh proposal
              </CapiroButton>
              <CapiroButton variant="primary" size="compact" loading={acceptRefresh.isPending} onClick={() => acceptRefresh.mutate(true)}>
                Keep my edits and refresh the rest
              </CapiroButton>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
