import { Pill } from './EvidenceBadge.js';

/** A source label, linked when a URL is present (opens in a new tab), else plain text. */
export function SourceLink({ label, url }: { label: string; url?: string | null }) {
  if (url) {
    return (
      <a href={url} target="_blank" rel="noreferrer">
        {label}
      </a>
    );
  }
  return <span>{label}</span>;
}

/** Current/Stale freshness pill (success/notable), keyed off a boolean. */
export function FreshnessPill({ fresh }: { fresh: boolean }) {
  return <Pill sev={fresh ? 'success' : 'notable'}>{fresh ? 'Current' : 'Stale'}</Pill>;
}
