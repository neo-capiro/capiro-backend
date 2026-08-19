import {
  formatEnrichment,
  formatFreshness,
  type OpportunitySourceFreshness,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { FovPill } from './fov-ui.js';

/**
 * Per-rail source health, as pills. vNext port of the canonical
 * OpportunityFreshnessStrip — same freshness input, same colour rule: an
 * outright FAILED last run is red even when older data exists, because the
 * rail is broken NOW and that is the fact a reader needs before trusting
 * anything below it.
 */
export function OpportunityFreshnessStrip({
  freshness,
}: {
  freshness: OpportunitySourceFreshness[] | undefined;
}) {
  if (!freshness?.length) return null;
  return (
    <div className="fov-page__freshness fov-freshness" data-testid="fo-freshness">
      {freshness.map((f) => {
        const enrichment = formatEnrichment(f);
        return (
          <span key={f.verb} className="fov-row">
            <FovPill
              tone={
                f.neverSynced || f.lastRunStatus === 'error'
                  ? 'red'
                  : f.lastRunDegraded === true
                    ? 'orange'
                    : 'default'
              }
            >
              {formatFreshness(f)} ·{' '}
              {f.countsUnavailable || f.activeRecordCount == null || f.recordCount == null
                ? 'counts unavailable'
                : `${f.activeRecordCount.toLocaleString()} active of ${f.recordCount.toLocaleString()}`}
            </FovPill>
            {enrichment ? (
              <FovPill tone={f.enrichment?.degraded ? 'orange' : 'default'}>{enrichment}</FovPill>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
