/*
 * §7.10d — Export overlay. Route: /strategies/:strategyId/export (over the editor).
 *
 * CONFIRMED GAP: the strategies API exposes exactly ONE export endpoint —
 * GET /strategy-api/context/strategies/:id/current-plan → { markdown }.
 * The design's generated formats (PDF / DOCX / PPTX / PNG) have no backend;
 * their cards render DISABLED with "Not yet available" and the content
 * toggles are marked as applying to generated formats only. The one working
 * path is the Markdown · current plan card: it refetches on click and saves
 * a real Blob download — nothing is faked, nothing downloads that the server
 * did not produce.
 *
 * Focus trap / Escape / dirty guard / route sync live in StrategiesModalShell.
 */
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CapiroSkeleton } from '../../../components/feedback/index.js';
import { useCurrentPlanExport, useStrategy } from '../strategies-api.js';
import { StrategiesModalShell } from './StrategiesModalShell.js';

/** The design's generated formats — all without an endpoint today. */
const UNAVAILABLE_FORMATS = [
  { id: 'pdf', name: 'PDF document', desc: 'Board-ready layout with cover, contents and phase diagrams.' },
  { id: 'docx', name: 'Word (DOCX)', desc: 'Editable document for redlining and client markup.' },
  { id: 'pptx', name: 'Slides (PPTX)', desc: 'One slide per phase for committee and client briefings.' },
  { id: 'png', name: 'Image (PNG)', desc: 'The timeline as a single shareable graphic.' },
] as const;

function slugify(title: string | undefined | null): string {
  const slug = (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'strategy';
}

export function ExportOverlay() {
  const { strategyId } = useParams<{ strategyId: string }>();
  const strategy = useStrategy(strategyId ?? null);
  const planExport = useCurrentPlanExport(strategyId ?? null, false);

  const [customName, setCustomName] = useState<string | null>(null);
  const [includeInternalNotes, setIncludeInternalNotes] = useState(false);
  const [includeAgentHistory, setIncludeAgentHistory] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const defaultName = useMemo(
    () => `${slugify(strategy.data?.title)}-current-plan.md`,
    [strategy.data?.title],
  );
  const filename = (customName ?? defaultName).trim() || defaultName;

  const downloading = planExport.isFetching;

  const download = async () => {
    if (!strategyId || downloading) return;
    setDownloadError(null);
    const result = await planExport.refetch();
    const markdown = result.data?.markdown;
    if (result.isError || markdown === undefined) {
      setDownloadError(
        (result.error as Error | null)?.message ||
          'The current plan export could not be generated. Please try again.',
      );
      return;
    }
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename.endsWith('.md') ? filename : `${filename}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <StrategiesModalShell
      eyebrow="Export"
      title="Take this plan out of Capiro"
      subtitle={
        strategy.isLoading
          ? 'Loading the strategy…'
          : strategy.data
            ? strategy.data.title
            : 'The strategy title could not be loaded — the export still works.'
      }
      closeTo={`/strategies/${strategyId ?? ''}`}
      size="lg"
      primaryLabel={downloading ? 'Preparing…' : 'Download markdown'}
      onPrimary={download}
      primaryDisabled={!strategyId || downloading}
      primaryBusy={downloading}
      footerNote={
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
          <span style={{ flex: 'none' }}>File name</span>
          <input
            className="capiro-input st-filename st-mono"
            aria-label="Export file name"
            value={customName ?? defaultName}
            onChange={(event) => setCustomName(event.target.value)}
          />
        </label>
      }
    >
      {downloadError ? (
        <p className="st-modal__alert" role="alert">
          {downloadError}
        </p>
      ) : null}

      <div className="st-format-grid">
        {UNAVAILABLE_FORMATS.map((format) => (
          <div
            key={format.id}
            className="st-option-card"
            aria-disabled="true"
            style={{ cursor: 'not-allowed', opacity: 0.72 }}
          >
            <span className="st-option-card__head">
              {format.name}
              <span className="st-pill st-pill--warning">Not yet available</span>
            </span>
            <span className="st-option-card__desc">{format.desc}</span>
            <span className="st-option-card__foot">
              <span className="st-format-card__ext st-mono">.{format.id}</span>
            </span>
          </div>
        ))}
      </div>

      <div className="st-gap" role="note">
        <strong>Generated formats are not yet available.</strong>
        The strategies API currently exports the current plan as Markdown only. PDF, DOCX, slides
        and image generation ship in a later release — the cards above show what is coming.
      </div>

      <div style={{ marginTop: 16 }}>
        <button
          type="button"
          className="st-option-card"
          onClick={download}
          disabled={!strategyId || downloading}
        >
          <span className="st-option-card__head">
            Markdown · current plan
            <span className="st-pill st-pill--success">Available now</span>
          </span>
          <span className="st-option-card__desc">
            {downloading
              ? 'Generating the current plan from the server…'
              : 'Downloads the current plan exactly as the strategies API generates it.'}
          </span>
          <span className="st-option-card__foot">
            <span className="st-format-card__ext st-mono">.md</span>
          </span>
        </button>
      </div>

      <div className="st-cols" style={{ marginTop: 20 }}>
        <div>
          <p className="st-panel__label">Preview</p>
          <div className="st-preview-page" aria-hidden="true">
            <div className="st-preview-block st-preview-block--hero" />
            <div className="st-preview-block" />
            <div className="st-preview-block st-preview-block--wide" />
            <div className="st-preview-row">
              <div className="st-preview-block" />
              <div className="st-preview-block" />
              <div className="st-preview-block" />
            </div>
            <div className="st-preview-block" />
          </div>
          <div className="st-preview-meta">
            <span>Markdown · current plan</span>
            <span className="st-mono">{filename.endsWith('.md') ? filename : `${filename}.md`}</span>
          </div>
        </div>

        <aside>
          <p className="st-panel__label">Contents</p>
          <div className="st-field-stack">
            <div className="st-toggle-row">
              <span>Include internal notes</span>
              <button
                type="button"
                className="st-switch"
                role="switch"
                aria-checked={includeInternalNotes}
                aria-label="Include internal notes"
                onClick={() => setIncludeInternalNotes((v) => !v)}
              />
            </div>
            <div className="st-toggle-row">
              <span>Include agent history</span>
              <button
                type="button"
                className="st-switch"
                role="switch"
                aria-checked={includeAgentHistory}
                aria-label="Include agent history"
                onClick={() => setIncludeAgentHistory((v) => !v)}
              />
            </div>
            <p className="st-ns__note">
              Content options apply to generated formats (PDF, DOCX, slides, image) only — they do
              not change the Markdown export, which is the current plan as the server renders it.
            </p>
            {strategy.isLoading ? (
              <div className="st-skel-stack">
                <CapiroSkeleton height={14} />
                <CapiroSkeleton height={14} width="70%" />
              </div>
            ) : null}
          </div>
        </aside>
      </div>
    </StrategiesModalShell>
  );
}
