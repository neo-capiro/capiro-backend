import { useEffect, useRef } from 'react';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroDrawer } from '../../components/overlays/index.js';
import {
  errorText,
  useClientFillWithMeri,
  type FillFinding,
} from '../../adapters/legacy/useClientFillWithMeri.js';

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
}: {
  clientId: string;
  clientName: string;
  open: boolean;
  onClose: () => void;
}) {
  const fill = useClientFillWithMeri(clientId, open);

  // Opening the drawer resumes an in-flight run automatically (see the hook);
  // once that check settles into 'idle' — nothing to resume — start a real
  // run right away instead of waiting on a redundant manual click.
  const startedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      startedRef.current = false;
      return;
    }
    if (fill.phase === 'idle' && !startedRef.current) {
      startedRef.current = true;
      fill.start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fill.phase]);

  return (
    <CapiroDrawer open={open} title={`Fill with Meri — ${clientName}`} onClose={onClose}>
      <div className="capiro-crm-fill">
        <p className="capiro-crm__foot">
          Meri reviews connected client sources and reliable public records, then proposes
          field-level changes. Nothing is written until you apply it.
        </p>

        <FillBody fill={fill} onClose={onClose} />
      </div>
    </CapiroDrawer>
  );
}

type Fill = ReturnType<typeof useClientFillWithMeri>;

function FillBody({ fill, onClose }: { fill: Fill; onClose: () => void }) {
  switch (fill.phase) {
    case 'idle':
      return (
        <div className="capiro-crm-fill__state">
          <p className="capiro-crm__foot">Ready to look for missing and outdated profile data.</p>
          <CapiroButton variant="primary" size="compact" onClick={() => fill.start()}>
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
          detail="Reading connected sources and public records. This can take a minute."
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
          <CapiroButton variant="secondary" size="compact" onClick={() => fill.start()}>
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
          <CapiroButton variant="secondary" size="compact" onClick={() => fill.start()}>
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
      return <FillProposals fill={fill} />;
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

function FillProposals({ fill }: { fill: Fill }) {
  const { proposals, selected } = fill;
  const allSelected = proposals.length > 0 && selected.size === proposals.length;

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

      <ul className="capiro-crm-fill__list">
        {proposals.map((finding) => (
          <FindingRow
            key={finding.id}
            finding={finding}
            checked={selected.has(finding.id)}
            onToggle={() => fill.toggle(finding.id)}
          />
        ))}
      </ul>

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

/* ─────────────────────────────── formatting ──────────────────────────────── */

const SOURCE_LABELS: Record<string, string> = {
  public_web: 'Public web',
  website: 'Client website',
  synced_email: 'Synced email',
  sam_gov: 'SAM.gov',
  lda: 'LDA filings',
  program_elements: 'Program elements',
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
