/*
 * Executive report export — /strategies/:strategyId/export.
 *
 * DOCX and PPTX are rendered synchronously by api-strategy from the same
 * server snapshot used by the readiness check. Markdown remains the exact,
 * separate current-plan export for technical hand-off. Client logos are
 * stored on the linked Client through the canonical core API lifecycle.
 */
import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useParams } from 'react-router-dom';
import { CapiroSkeleton } from '../../../components/feedback/index.js';
import { CapiroFileTextIcon } from '../../../components/icons/index.js';
import {
  type StrategyExportAudience,
  type StrategyExportFormat,
  type StrategyExportOptions,
  useClientsLite,
  useCurrentPlanExport,
  useGenerateStrategyExport,
  useStrategy,
  useStrategyExportPreflight,
  useUploadClientLogo,
} from '../strategies-api.js';
import { StrategiesModalShell } from './StrategiesModalShell.js';

type ExportChoice = StrategyExportFormat | 'markdown';

const LOGO_WARNING_CODES = new Set([
  'CLIENT_LOGO_UNAVAILABLE',
  'CLIENT_LOGO_UNSUPPORTED',
]);

const SECTION_STATE_LABELS = {
  ready: 'Ready',
  thin: 'Thin',
  empty: 'Empty',
  excluded: 'Excluded',
} as const;

const REPORT_FORMATS: Array<{
  id: StrategyExportFormat;
  name: string;
  description: string;
  extension: string;
}> = [
  {
    id: 'docx',
    name: 'Word document',
    description:
      'Polished, editable executive report for review, redlining and delivery.',
    extension: '.docx',
  },
  {
    id: 'pptx',
    name: 'PowerPoint deck',
    description:
      'Concise 16:9 briefing deck for leadership and client presentations.',
    extension: '.pptx',
  },
];

function slugify(value: string | undefined | null): string {
  const slug = (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'strategy';
}

function safeFilenameStem(value: string): string {
  return value
    .replace(/\.(docx|pptx|md)$/i, '')
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[.\s-]+$/g, '')
    .trim()
    .slice(0, 120);
}

function displayDate(value: string | null | undefined): string {
  if (!value) return 'Current snapshot';
  const date = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value,
  );
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function humanizeStatus(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function messageFromPayload(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (!value || typeof value !== 'object') return null;
  const message = (value as { message?: unknown }).message;
  if (typeof message === 'string' && message.trim()) return message;
  if (Array.isArray(message)) {
    const parts = message.filter(
      (part): part is string => typeof part === 'string',
    );
    return parts.length ? parts.join(' ') : null;
  }
  return null;
}

function codeFromPayload(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() ? code : null;
}

async function errorCodeFromResponse(error: unknown): Promise<string | null> {
  if (!error || typeof error !== 'object') return null;
  const responseData = (error as { response?: { data?: unknown } }).response
    ?.data;
  if (responseData instanceof Blob) {
    try {
      return codeFromPayload(JSON.parse(await responseData.text()) as unknown);
    } catch {
      return null;
    }
  }
  return codeFromPayload(responseData);
}

async function readableError(
  error: unknown,
  fallback: string,
): Promise<string> {
  if (error && typeof error === 'object') {
    const responseData = (error as { response?: { data?: unknown } }).response
      ?.data;
    if (responseData instanceof Blob) {
      try {
        const text = await responseData.text();
        const parsed = JSON.parse(text) as unknown;
        const message = messageFromPayload(parsed);
        if (message) return message;
      } catch {
        // A non-JSON error blob falls through to the ordinary error message.
      }
    } else {
      const responseMessage = messageFromPayload(responseData);
      if (responseMessage) return responseMessage;
    }
    const message = messageFromPayload(error);
    if (message) return message;
  }
  return fallback;
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next task so Safari has time to begin consuming the Blob.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ToggleRow({
  id,
  title,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const descriptionId = `${id}-description`;
  return (
    <div
      className={`st-toggle-row${disabled ? ' st-toggle-row--disabled' : ''}`}
    >
      <span className="st-export-toggle__copy">
        <strong id={id}>{title}</strong>
        <span id={descriptionId}>{description}</span>
      </span>
      <button
        type="button"
        className="st-switch"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        aria-describedby={descriptionId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

export function ExportOverlay() {
  const { strategyId } = useParams<{ strategyId: string }>();
  const strategy = useStrategy(strategyId ?? null);
  const clients = useClientsLite();

  const [choice, setChoice] = useState<ExportChoice>('docx');
  const [audience, setAudience] = useState<StrategyExportAudience>('client');
  const [useClientLogo, setUseClientLogo] = useState(true);
  const [includeRoadmap, setIncludeRoadmap] = useState(true);
  const [includeEvidenceAppendix, setIncludeEvidenceAppendix] = useState(true);
  const [includeChangeLog, setIncludeChangeLog] = useState(false);
  const [includeInternalNotes, setIncludeInternalNotes] = useState(false);
  const [includeAgentHistory, setIncludeAgentHistory] = useState(false);
  const [includeNarrative, setIncludeNarrative] = useState(true);
  const [includeMemberProfiles, setIncludeMemberProfiles] = useState(true);
  const [customName, setCustomName] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const logoInput = useRef<HTMLInputElement>(null);
  const refreshedLogoVersions = useRef(new Set<string>());

  const isReport = choice !== 'markdown';
  const reportFormat: StrategyExportFormat =
    choice === 'pptx' ? 'pptx' : 'docx';
  const reportOptions = useMemo<StrategyExportOptions>(
    () => ({
      format: reportFormat,
      audience,
      useClientLogo,
      includeRoadmap,
      includeEvidenceAppendix,
      includeChangeLog: audience === 'internal' && includeChangeLog,
      includeInternalNotes: audience === 'internal' && includeInternalNotes,
      includeAgentHistory: audience === 'internal' && includeAgentHistory,
      includeNarrative,
      includeMemberProfiles,
    }),
    [
      audience,
      includeAgentHistory,
      includeChangeLog,
      includeEvidenceAppendix,
      includeInternalNotes,
      includeMemberProfiles,
      includeNarrative,
      includeRoadmap,
      reportFormat,
      useClientLogo,
    ],
  );
  const preflight = useStrategyExportPreflight(
    strategyId ?? null,
    reportOptions,
    isReport,
  );
  const reportExport = useGenerateStrategyExport(strategyId ?? null);
  const planExport = useCurrentPlanExport(strategyId ?? null, false);

  const linkedClient = useMemo(
    () =>
      clients.data?.find((client) => client.id === strategy.data?.clientId) ??
      null,
    [clients.data, strategy.data?.clientId],
  );
  const logoUpload = useUploadClientLogo(strategy.data?.clientId ?? null);

  const clientDisplayName =
    preflight.data?.client.name ?? linkedClient?.name ?? 'Client';
  const reportTitle =
    preflight.data?.report.title ?? strategy.data?.title ?? 'Strategy';
  const reportAsOf =
    preflight.data?.report.asOf ?? new Date().toISOString().slice(0, 10);
  const clientLogoUrl =
    preflight.data?.logo.url ?? linkedClient?.logoUrl ?? null;
  const savedLogoVersion = linkedClient
    ? `${linkedClient.id}:${linkedClient.logoUploadedAt ?? 'legacy'}`
    : null;
  const savedLogoContentType =
    preflight.data?.logo.contentType ?? linkedClient?.logoContentType;
  const savedLogoPortable =
    !savedLogoContentType ||
    ['image/png', 'image/jpeg'].includes(savedLogoContentType);
  const logoSupported = preflight.data?.logo.supported ?? savedLogoPortable;
  const logoAvailable =
    preflight.data?.logo.available ?? Boolean(clientLogoUrl);
  const effectiveUseClientLogo = useClientLogo && logoSupported;
  const logoPreviewFailed = Boolean(
    clientLogoUrl && failedLogoUrl === clientLogoUrl,
  );
  const showClientLogo =
    effectiveUseClientLogo && Boolean(clientLogoUrl) && !logoPreviewFailed;
  const visiblePreflightWarnings = (preflight.data?.warnings ?? []).filter(
    (warning) => useClientLogo || !LOGO_WARNING_CODES.has(warning.code),
  );
  const audienceLabel =
    audience === 'client' ? 'Client-ready' : 'Internal working copy';
  const audienceFilenameLabel =
    audience === 'client' ? 'client' : 'internal-working';
  const evidenceSection = preflight.data?.sections.find(
    (section) => section.id === 'evidence',
  );
  const evidenceUnavailable = evidenceSection?.state === 'empty';
  const effectiveIncludeEvidenceAppendix =
    includeEvidenceAppendix && !evidenceUnavailable;
  // Until preflight answers, assume the server can narrate so the toggle is
  // not flashed disabled; the server ignores the flag when it cannot.
  const narrativeAvailable = preflight.data?.narrative.available ?? true;
  const memberOffices = preflight.data?.memberOffices ?? null;

  const defaultStem = useMemo(() => {
    if (choice === 'markdown') return `${slugify(reportTitle)}-current-plan`;
    const deliverable =
      choice === 'pptx' ? 'executive-briefing' : 'executive-report';
    return `${slugify(clientDisplayName)}-${slugify(reportTitle)}-${deliverable}-${audienceFilenameLabel}-${reportAsOf}`;
  }, [
    choice,
    clientDisplayName,
    reportAsOf,
    reportTitle,
    audienceFilenameLabel,
  ]);

  const filenameStem =
    safeFilenameStem(customName ?? defaultStem) || defaultStem;
  const extension = choice === 'markdown' ? '.md' : `.${choice}`;
  const filename = `${filenameStem}${extension}`;

  const formatSupported =
    !preflight.data || preflight.data.report.formats.includes(reportFormat);
  const reportReady = Boolean(
    preflight.data?.report.ready &&
    preflight.data.errors.length === 0 &&
    formatSupported,
  );
  const readiness =
    !formatSupported || preflight.data?.errors.length
      ? 'blocked'
      : preflight.data?.report.readiness === 'review' &&
          visiblePreflightWarnings.length === 0
        ? 'ready'
        : (preflight.data?.report.readiness ?? 'blocked');
  const readinessClass =
    readiness === 'ready'
      ? 'is-ready'
      : readiness === 'review'
        ? 'is-neutral'
        : 'is-blocked';
  const readinessLabel =
    readiness === 'ready'
      ? 'Ready to generate'
      : readiness === 'review'
        ? 'Ready with review notes'
        : 'Action required';
  const omittedStatusEntries = Object.entries(
    preflight.data?.inclusion.omittedByStatus ?? {},
  ).filter(([, count]) => count > 0);
  const displayedSections = (preflight.data?.sections ?? []).map((section) => {
    if (section.id === 'roadmap' && !includeRoadmap) {
      return {
        ...section,
        state: 'excluded' as const,
        message: 'Excluded by the current report settings.',
      };
    }
    if (
      section.id === 'evidence' &&
      !effectiveIncludeEvidenceAppendix &&
      section.state !== 'empty'
    ) {
      return {
        ...section,
        state: 'excluded' as const,
        message: 'Excluded by the current report settings.',
      };
    }
    return section;
  });
  const downloading = isReport ? reportExport.isPending : planExport.isFetching;
  const checkingReadiness = isReport && preflight.isFetching;
  const primaryDisabled =
    !strategyId ||
    downloading ||
    logoUpload.isPending ||
    (isReport &&
      (preflight.isFetching ||
        preflight.isError ||
        !preflight.data ||
        !reportReady));

  const clearResult = () => {
    setDownloadError(null);
    setLiveStatus(null);
  };

  const selectChoice = (next: ExportChoice) => {
    setChoice(next);
    clearResult();
  };

  const selectAudience = (next: StrategyExportAudience) => {
    setAudience(next);
    clearResult();
  };

  const download = async () => {
    if (!strategyId || primaryDisabled) return;
    setDownloadError(null);
    setLiveStatus(null);

    if (choice === 'markdown') {
      const result = await planExport.refetch();
      const markdown = result.data?.markdown;
      if (result.isError || markdown === undefined) {
        setDownloadError(
          (result.error as Error | null)?.message ||
            'The current plan could not be generated. Please try again.',
        );
        return;
      }
      saveBlob(
        new Blob([markdown], { type: 'text/markdown;charset=utf-8' }),
        filename,
      );
      setLiveStatus(`Downloaded ${filename}.`);
      return;
    }

    try {
      const result = await reportExport.mutateAsync({
        ...reportOptions,
        expectedSnapshotHash: preflight.data?.report.snapshotHash,
      });
      const downloadFilename = customName === null ? result.filename : filename;
      saveBlob(result.blob, downloadFilename);
      const snapshot = result.snapshotHash
        ? ` Snapshot ${result.snapshotHash.slice(0, 10)}.`
        : '';
      const brandingFallback =
        effectiveUseClientLogo && !result.logoIncluded
          ? ' The saved logo could not be embedded, so client-name branding was used.'
          : '';
      const narrativeNote =
        result.narrativeStatus === 'generated'
          ? ' Grounded narrative included.'
          : result.narrativeStatus === 'fallback'
            ? ' Narrative was unavailable, so sections render as fact listings.'
            : '';
      const memberNote =
        result.memberOffices && result.memberOffices.referenced > 0
          ? ` Member offices: ${result.memberOffices.resolved} of ${result.memberOffices.referenced} resolved from the directory.`
          : '';
      setLiveStatus(
        `Downloaded ${downloadFilename}.${snapshot}${brandingFallback}${narrativeNote}${memberNote}`,
      );
    } catch (error) {
      if ((await errorCodeFromResponse(error)) === 'REPORT_SNAPSHOT_CHANGED') {
        const refreshed = await preflight.refetch();
        setDownloadError(
          refreshed.isSuccess
            ? 'The strategy changed after readiness was checked. Readiness was refreshed; review the updated content before downloading again.'
            : 'The strategy changed after readiness was checked. Refresh readiness and review the updated content before downloading again.',
        );
        return;
      }
      setDownloadError(
        await readableError(
          error,
          'The executive report could not be generated. Review readiness and try again.',
        ),
      );
    }
  };

  const chooseLogo = () => logoInput.current?.click();

  const handleLogoPreviewError = () => {
    setFailedLogoUrl(clientLogoUrl);
    // A signed URL can expire, so refresh it once for this saved logo version.
    // If the refreshed URL also fails, keep the wordmark fallback instead of
    // creating an onError -> refetch -> new URL loop across the two previews.
    if (
      savedLogoVersion &&
      !refreshedLogoVersions.current.has(savedLogoVersion)
    ) {
      refreshedLogoVersions.current.add(savedLogoVersion);
      void clients.refetch();
    }
  };

  const uploadLogo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setLogoError(null);
    setLiveStatus(null);
    try {
      await logoUpload.mutateAsync(file);
      refreshedLogoVersions.current.clear();
      setFailedLogoUrl(null);
      setUseClientLogo(true);
      setLiveStatus(
        `${clientDisplayName}'s logo was saved for this and future reports.`,
      );
    } catch (error) {
      setLogoError(
        await readableError(error, 'The client logo could not be uploaded.'),
      );
    }
  };

  const primaryLabel = checkingReadiness
    ? 'Checking readiness…'
    : downloading
      ? 'Preparing download…'
      : choice === 'docx'
        ? 'Download Word report'
        : choice === 'pptx'
          ? 'Download PowerPoint'
          : 'Download Markdown';

  return (
    <StrategiesModalShell
      eyebrow="Executive report"
      title={
        audience === 'client'
          ? 'Create a client-ready strategy report'
          : 'Create an internal strategy report'
      }
      subtitle={
        strategy.isLoading
          ? 'Loading strategy details…'
          : `${clientDisplayName} · ${reportTitle}`
      }
      closeTo={`/strategies/${strategyId ?? ''}`}
      maxWidth={1080}
      primaryLabel={primaryLabel}
      onPrimary={download}
      primaryDisabled={primaryDisabled}
      primaryBusy={downloading || checkingReadiness}
      footerNote={
        <label className="st-export-filename">
          <span>File name</span>
          <span className="st-export-filename__control">
            <input
              className="capiro-input st-filename st-mono"
              aria-label="Export file name without extension"
              value={customName ?? defaultStem}
              onChange={(event) => setCustomName(event.target.value)}
              spellCheck={false}
            />
            <span
              className="st-export-filename__extension st-mono"
              aria-hidden="true"
            >
              {extension}
            </span>
          </span>
        </label>
      }
    >
      {downloadError ? (
        <p className="st-modal__alert" role="alert">
          {downloadError}
        </p>
      ) : null}
      {liveStatus ? (
        <p className="st-export-status" role="status" aria-live="polite">
          {liveStatus}
        </p>
      ) : null}

      <section
        className="st-export-section"
        aria-labelledby="export-format-heading"
      >
        <div className="st-export-section__heading">
          <div>
            <p className="st-panel__label" id="export-format-heading">
              Format
            </p>
            <p className="st-export-section__intro">
              Choose the final deliverable.
            </p>
          </div>
        </div>
        <div className="st-format-grid">
          {REPORT_FORMATS.map((format) => {
            const selected = choice === format.id;
            const supported =
              !preflight.data ||
              preflight.data.report.formats.includes(format.id);
            return (
              <button
                key={format.id}
                type="button"
                className="st-option-card st-export-format-card"
                aria-pressed={selected}
                disabled={!supported}
                onClick={() => selectChoice(format.id)}
              >
                <span className="st-format-card__icon" aria-hidden="true">
                  <CapiroFileTextIcon style={{ width: 16, height: 16 }} />
                </span>
                <span className="st-option-card__head">
                  {format.name}
                  {!supported ? (
                    <span className="st-pill st-pill--warning">
                      Unavailable
                    </span>
                  ) : format.id === 'docx' ? (
                    <span className="st-pill st-pill--accent">Recommended</span>
                  ) : null}
                </span>
                <span className="st-option-card__desc">
                  {format.description}
                </span>
                <span className="st-option-card__foot">
                  <span className="st-format-card__ext st-mono">
                    {format.extension}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {isReport ? (
        <div className="st-cols st-export-layout">
          <div className="st-export-config">
            <section
              className="st-export-section"
              aria-labelledby="export-audience-heading"
            >
              <p className="st-panel__label" id="export-audience-heading">
                Audience
              </p>
              <div
                className="st-export-audience"
                role="radiogroup"
                aria-labelledby="export-audience-heading"
              >
                <label
                  className={`st-option-card st-export-radio${
                    audience === 'client' ? ' is-selected' : ''
                  }`}
                >
                  <input
                    className="st-export-radio__input"
                    type="radio"
                    name="report-audience"
                    value="client"
                    checked={audience === 'client'}
                    onChange={() => selectAudience('client')}
                  />
                  <span className="st-option-card__head">Client-ready</span>
                  <span className="st-option-card__desc">
                    External language and presentation. Internal material is
                    always excluded.
                  </span>
                </label>
                <label
                  className={`st-option-card st-export-radio${
                    audience === 'internal' ? ' is-selected' : ''
                  }`}
                >
                  <input
                    className="st-export-radio__input"
                    type="radio"
                    name="report-audience"
                    value="internal"
                    checked={audience === 'internal'}
                    onChange={() => selectAudience('internal')}
                  />
                  <span className="st-option-card__head">
                    Internal working copy
                  </span>
                  <span className="st-option-card__desc">
                    Adds optional delivery detail for the Capiro team.
                  </span>
                </label>
              </div>
            </section>

            <section
              className="st-panel st-export-branding"
              aria-labelledby="export-branding-heading"
            >
              <p className="st-panel__label" id="export-branding-heading">
                Client branding
              </p>
              <div className="st-export-branding__grid">
                <div className="st-export-logo-tile">
                  {clientLogoUrl && !logoPreviewFailed ? (
                    <img
                      src={clientLogoUrl}
                      alt={`${clientDisplayName} logo`}
                      onError={handleLogoPreviewError}
                    />
                  ) : (
                    <span className="st-export-wordmark">
                      {clientDisplayName}
                    </span>
                  )}
                </div>
                <div className="st-export-branding__copy">
                  <strong>
                    {logoAvailable ? 'Client logo saved' : 'Add a client logo'}
                  </strong>
                  <p>
                    The logo is stored on {clientDisplayName}'s client profile
                    and reused in future reports.
                  </p>
                  <input
                    ref={logoInput}
                    className="st-export-file-input"
                    type="file"
                    accept="image/png,image/jpeg"
                    onChange={uploadLogo}
                    tabIndex={-1}
                    aria-hidden="true"
                  />
                  <button
                    type="button"
                    className="st-export-small-button"
                    onClick={chooseLogo}
                    disabled={!strategy.data?.clientId || logoUpload.isPending}
                  >
                    {logoUpload.isPending
                      ? 'Uploading…'
                      : logoAvailable
                        ? 'Replace logo'
                        : 'Upload logo'}
                  </button>
                  <span className="st-export-branding__hint">
                    PNG or JPG · 2 MB and 1 megapixel maximum. A transparent,
                    non-interlaced PNG works best.
                  </span>
                </div>
              </div>
              {logoError ? (
                <p className="st-export-field-error" role="alert">
                  {logoError}
                </p>
              ) : null}
              {!logoSupported ? (
                <p className="st-export-field-error" role="note">
                  This saved logo type cannot be embedded in Word or PowerPoint.
                  Replace it with a PNG or JPG to use client branding.
                </p>
              ) : null}
              <div className="st-export-logo-toggle">
                <ToggleRow
                  id="use-client-logo"
                  title="Use client logo"
                  description={
                    logoAvailable
                      ? 'Place the saved mark on the cover and section pages.'
                      : 'Upload a mark now, or export with client-name typography.'
                  }
                  checked={effectiveUseClientLogo}
                  disabled={!logoSupported}
                  onChange={setUseClientLogo}
                />
              </div>
            </section>

            <section
              className="st-export-section"
              aria-labelledby="export-contents-heading"
            >
              <p className="st-panel__label" id="export-contents-heading">
                Contents
              </p>
              <div className="st-field-stack">
                <ToggleRow
                  id="include-narrative"
                  title="Grounded executive narrative"
                  description={
                    narrativeAvailable
                      ? 'Meri writes the brief and context sections as flowing prose, citing only facts in this snapshot. Anything it cannot ground is dropped and the fact listing is used instead.'
                      : preflight.data?.narrative.reason ||
                        'Narrative generation is not available here; sections render as fact listings.'
                  }
                  checked={includeNarrative && narrativeAvailable}
                  disabled={!narrativeAvailable}
                  onChange={setIncludeNarrative}
                />
                <ToggleRow
                  id="include-member-profiles"
                  title="Member office profiles"
                  description={
                    memberOffices && memberOffices.referenced > 0
                      ? `${pluralize(memberOffices.referenced, 'congressional office')} targeted by included steps · portrait and Washington office from the public directory (${memberOffices.resolved} resolved).`
                      : 'Portrait and Washington office cards appear when included steps target a congressional office.'
                  }
                  checked={includeMemberProfiles}
                  onChange={setIncludeMemberProfiles}
                />
                <ToggleRow
                  id="include-roadmap"
                  title="Roadmap & visual timeline"
                  description="Show the delivery timeline chart, phased plan, dates, owners and milestone callouts."
                  checked={includeRoadmap}
                  onChange={setIncludeRoadmap}
                />
                <ToggleRow
                  id="include-evidence"
                  title="Evidence appendix"
                  description={
                    evidenceUnavailable
                      ? evidenceSection?.message ||
                        'No grounded sources or artifacts are available yet.'
                      : 'Add the artifacts and sources that ground plan decisions.'
                  }
                  checked={effectiveIncludeEvidenceAppendix}
                  disabled={evidenceUnavailable}
                  onChange={setIncludeEvidenceAppendix}
                />
                <ToggleRow
                  id="include-change-log"
                  title="Change log"
                  description="Summarize material plan revisions since the prior version."
                  checked={audience === 'internal' && includeChangeLog}
                  disabled={audience === 'client'}
                  onChange={setIncludeChangeLog}
                />
                <ToggleRow
                  id="include-internal-notes"
                  title="Internal notes"
                  description="Include working commentary that is not intended for clients."
                  checked={audience === 'internal' && includeInternalNotes}
                  disabled={audience === 'client'}
                  onChange={setIncludeInternalNotes}
                />
                <ToggleRow
                  id="include-agent-history"
                  title="Agent activity"
                  description="Append an audit summary of agent-assisted plan work."
                  checked={audience === 'internal' && includeAgentHistory}
                  disabled={audience === 'client'}
                  onChange={setIncludeAgentHistory}
                />
              </div>
              {audience === 'client' ? (
                <p className="st-export-policy-note">
                  Client-ready exports always suppress the change log, internal
                  notes and agent activity, even if they were selected in an
                  earlier internal export.
                </p>
              ) : null}
            </section>
          </div>

          <aside className="st-export-aside">
            <div className="st-dark-panel st-export-preview-panel">
              <p className="st-dark-panel__label">Cover preview</p>
              <div
                className={`st-export-cover st-export-cover--${reportFormat}`}
                aria-label={`${reportFormat === 'docx' ? 'Word report' : 'PowerPoint'} cover preview`}
              >
                <div className="st-export-cover__brand">
                  {showClientLogo ? (
                    <img
                      src={clientLogoUrl ?? ''}
                      alt=""
                      onError={handleLogoPreviewError}
                    />
                  ) : (
                    <span>
                      {effectiveUseClientLogo
                        ? clientDisplayName
                        : 'Executive strategy'}
                    </span>
                  )}
                </div>
                <div className="st-export-cover__rule" />
                <p className="st-export-cover__eyebrow">
                  {reportFormat === 'docx'
                    ? 'Executive strategy report'
                    : 'Executive briefing'}
                </p>
                <h3>{reportTitle}</h3>
                {strategy.data?.goal ? (
                  <p className="st-export-cover__goal">{strategy.data.goal}</p>
                ) : null}
                <span
                  className={`st-export-cover__audience st-export-cover__audience--${audience}`}
                >
                  {audienceLabel}
                </span>
                <div className="st-export-cover__footer">
                  <span>{clientDisplayName}</span>
                  <span>{displayDate(reportAsOf)}</span>
                </div>
              </div>
              <div className="st-preview-meta">
                <span>
                  {reportFormat === 'docx' ? 'Word report' : 'PowerPoint deck'}
                </span>
                <span className="st-mono">{filename}</span>
              </div>
            </div>

            <section
              className="st-panel st-export-preflight"
              aria-labelledby="export-readiness-heading"
            >
              <div className="st-export-preflight__head">
                <p className="st-panel__label" id="export-readiness-heading">
                  Report readiness
                </p>
                <div className="st-export-preflight__meta">
                  <span
                    className={`st-export-audience-badge st-export-audience-badge--${audience}`}
                  >
                    {audienceLabel}
                  </span>
                  {preflight.isFetching && preflight.data ? (
                    <span className="st-export-refreshing">Refreshing…</span>
                  ) : null}
                </div>
              </div>
              {!preflight.data && !preflight.isError ? (
                <div
                  className="st-skel-stack"
                  aria-label="Checking report readiness"
                >
                  <CapiroSkeleton height={14} />
                  <CapiroSkeleton height={14} width="72%" />
                  <CapiroSkeleton height={14} width="84%" />
                </div>
              ) : preflight.isError ? (
                <div className="st-export-preflight__error" role="alert">
                  <strong>Readiness check unavailable</strong>
                  <span>The server could not validate this report.</span>
                  <button
                    type="button"
                    className="st-export-small-button"
                    onClick={() => void preflight.refetch()}
                  >
                    Try again
                  </button>
                </div>
              ) : preflight.data ? (
                <>
                  <div className="st-export-checks">
                    <div className={`st-export-check ${readinessClass}`}>
                      <span aria-hidden="true">
                        {readiness === 'ready' ? '✓' : '!'}
                      </span>
                      <div>
                        <strong>{readinessLabel}</strong>
                        <small>
                          {preflight.data.inclusion.includedNodes} of{' '}
                          {preflight.data.inclusion.liveNodes} live plan item
                          {preflight.data.inclusion.liveNodes === 1
                            ? ''
                            : 's'}{' '}
                          included
                        </small>
                      </div>
                    </div>
                    <div className="st-export-check is-neutral">
                      <span aria-hidden="true">
                        {preflight.data.health.score}
                      </span>
                      <div>
                        <strong>
                          Included-content health ·{' '}
                          {preflight.data.health.label}
                        </strong>
                        <small>
                          {preflight.data.health.coveragePct}% owner coverage ·{' '}
                          {preflight.data.health.groundingPct}% grounded
                        </small>
                        {preflight.data.allLiveHealth.totalNodes !==
                          preflight.data.health.totalNodes ||
                        preflight.data.allLiveHealth.score !==
                          preflight.data.health.score ? (
                          <small>
                            All live plan: {preflight.data.allLiveHealth.score}
                            /100 · {preflight.data.allLiveHealth.label}
                          </small>
                        ) : null}
                      </div>
                    </div>
                    <div
                      className={`st-export-check${
                        !effectiveUseClientLogo || logoAvailable
                          ? ' is-ready'
                          : ' is-neutral'
                      }`}
                    >
                      <span aria-hidden="true">
                        {!effectiveUseClientLogo || logoAvailable ? '✓' : '—'}
                      </span>
                      <div>
                        <strong>
                          {!effectiveUseClientLogo
                            ? 'Client-name branding'
                            : logoAvailable
                              ? 'Client logo ready'
                              : 'Logo not yet added'}
                        </strong>
                        <small>
                          {!effectiveUseClientLogo || logoAvailable
                            ? 'Branding can be rendered.'
                            : 'The report can still be generated without a mark.'}
                        </small>
                      </div>
                    </div>
                  </div>
                  {preflight.data.inclusion.omittedNodes > 0 ? (
                    <div className="st-export-inclusion-note" role="note">
                      <strong>
                        {pluralize(
                          preflight.data.inclusion.omittedNodes,
                          'plan item',
                        )}{' '}
                        omitted for this audience
                      </strong>
                      {omittedStatusEntries.length ? (
                        <span>
                          {omittedStatusEntries
                            .map(
                              ([status, count]) =>
                                `${humanizeStatus(status)}: ${count}`,
                            )
                            .join(' · ')}
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <p className="st-export-inclusion-all">
                      All live plan items are included for this audience.
                    </p>
                  )}

                  <div className="st-export-section-readiness">
                    <p className="st-export-section-readiness__title">
                      Report sections
                    </p>
                    <ul>
                      {displayedSections.map((section) => (
                        <li key={section.id}>
                          <span
                            className={`st-export-section-state st-export-section-state--${section.state}`}
                          >
                            {SECTION_STATE_LABELS[section.state]}
                          </span>
                          <span className="st-export-section-readiness__copy">
                            <strong>{section.label}</strong>
                            <small>
                              {section.message}
                              {section.availableCount > 0
                                ? ` · ${pluralize(section.availableCount, 'item')}`
                                : ''}
                            </small>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  {!formatSupported ? (
                    <div
                      className="st-export-issues st-export-issues--error"
                      role="alert"
                    >
                      <strong>This format is not enabled.</strong>
                      <span>
                        Choose one of the formats returned by the report
                        service.
                      </span>
                    </div>
                  ) : null}
                  {preflight.data.errors.length ? (
                    <div
                      className="st-export-issues st-export-issues--error"
                      role="alert"
                    >
                      {preflight.data.errors.map((issue) => (
                        <span key={issue.code}>{issue.message}</span>
                      ))}
                    </div>
                  ) : null}
                  {visiblePreflightWarnings.length ? (
                    <div className="st-export-issues" role="note">
                      {visiblePreflightWarnings.map((issue) => (
                        <span key={issue.code}>{issue.message}</span>
                      ))}
                    </div>
                  ) : null}
                  <p className="st-export-snapshot">
                    Snapshot as of {displayDate(preflight.data.report.asOf)}
                    {preflight.data.version.createdAt
                      ? ` · Version saved ${displayDate(preflight.data.version.createdAt)}`
                      : ''}
                    {preflight.data.report.snapshotHash
                      ? ` · ${preflight.data.report.snapshotHash.slice(0, 10)}`
                      : ''}
                  </p>
                </>
              ) : null}
            </section>
          </aside>
        </div>
      ) : (
        <div className="st-export-markdown">
          <div className="st-panel">
            <p className="st-panel__label">Technical export</p>
            <h3>Markdown · current plan</h3>
            <p>
              Downloads the current plan exactly as the Strategies API renders
              it. Branding, audience and report-content options do not alter
              this file.
            </p>
            {strategy.isLoading ? (
              <div className="st-skel-stack">
                <CapiroSkeleton height={14} />
                <CapiroSkeleton height={14} width="70%" />
              </div>
            ) : null}
          </div>
          <div className="st-dark-panel st-export-markdown__meta">
            <p className="st-dark-panel__label">Export details</p>
            <dl>
              <div>
                <dt>Strategy</dt>
                <dd>{reportTitle}</dd>
              </div>
              <div>
                <dt>Client</dt>
                <dd>{clientDisplayName}</dd>
              </div>
              <div>
                <dt>File</dt>
                <dd className="st-mono">{filename}</dd>
              </div>
            </dl>
          </div>
        </div>
      )}

      <section
        className="st-export-advanced"
        aria-labelledby="export-advanced-heading"
      >
        <div>
          <p className="st-panel__label" id="export-advanced-heading">
            Advanced export
          </p>
          <p>
            Use the server's raw current-plan Markdown for technical workflows.
          </p>
        </div>
        <button
          type="button"
          className="st-option-card st-export-advanced__card"
          aria-pressed={choice === 'markdown'}
          onClick={() => selectChoice('markdown')}
        >
          <span className="st-format-card__icon" aria-hidden="true">
            <CapiroFileTextIcon style={{ width: 16, height: 16 }} />
          </span>
          <span>
            <strong>Markdown · current plan</strong>
            <small>.md</small>
          </span>
        </button>
      </section>
    </StrategiesModalShell>
  );
}
