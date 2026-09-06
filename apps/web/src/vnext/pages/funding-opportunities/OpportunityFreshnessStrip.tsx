import {
  formatEnrichment,
  formatFreshness,
  type OpportunitySourceFreshness,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { FovPill } from './fov-ui.js';

/** Catalog health remains visible; detailed counts do not crowd the workflow. */
export function OpportunityFreshnessStrip({
  freshness,
}: {
  freshness: OpportunitySourceFreshness[] | undefined;
}) {
  if (!freshness?.length) return null;
  return (
    <div
      className="fov-page__freshness fov-freshness"
      data-testid="fo-freshness"
      aria-label="Catalog source updates"
    >
      {freshness.map((source) => (
        <FovPill
          key={source.verb}
          tone={
            source.neverSynced || source.lastRunStatus === 'error'
              ? 'red'
              : source.lastRunDegraded
                ? 'orange'
                : 'default'
          }
        >
          {formatFreshness(source)}
        </FovPill>
      ))}
      <details className="fo-source-health">
        <summary>Source details</summary>
        <div className="fov-stack fov-stack--8">
          {freshness.map((source) => (
            <p className="fov-micro" key={source.verb}>
              {source.label}:{' '}
              {source.countsUnavailable ||
              source.activeRecordCount == null ||
              source.recordCount == null
                ? 'Record counts unavailable'
                : `${source.activeRecordCount.toLocaleString()} active of ${source.recordCount.toLocaleString()} records`}
              {formatEnrichment(source) ? ` · ${formatEnrichment(source)}` : ''}
            </p>
          ))}
        </div>
      </details>
    </div>
  );
}
