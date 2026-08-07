import { Space, Tag } from 'antd';
import {
  formatEnrichment,
  formatFreshness,
  type OpportunitySourceFreshness,
} from './funding-opportunities-api.js';

/**
 * Per-rail source health, as tags.
 *
 * EXTRACTED IN P11, not written fresh. The inbox is now the DEFAULT experience,
 * and a default experience that cannot tell you a source rail died last night is
 * worse than the catalog it replaced — so both views render this, byte-identically,
 * from one component rather than two drifting copies.
 *
 * The colour rule is the honest one: an outright FAILED last run is red even when
 * older data exists, because the rail is broken NOW and that is the fact a reader
 * needs before trusting anything below it.
 */
export function OpportunityFreshnessStrip({
  freshness,
}: {
  freshness: OpportunitySourceFreshness[] | undefined;
}) {
  if (!freshness?.length) return null;
  return (
    <div className="fo-page__freshness" data-testid="fo-freshness">
      <Space size={8} wrap>
        {freshness.map((f) => {
          const enrichment = formatEnrichment(f);
          return (
            <span key={f.verb}>
              <Tag
                color={
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
              </Tag>
              {enrichment ? (
                <Tag color={f.enrichment?.degraded ? 'orange' : 'default'}>{enrichment}</Tag>
              ) : null}
            </span>
          );
        })}
      </Space>
    </div>
  );
}
