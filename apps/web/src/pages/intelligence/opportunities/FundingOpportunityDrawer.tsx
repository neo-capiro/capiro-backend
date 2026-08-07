import { Button, Drawer, Grid, Space } from 'antd';
import { useNavigate } from 'react-router-dom';
import { FundingOpportunityDetail } from './FundingOpportunityDetail.js';
import { ForecastOpportunityDetail } from './ForecastOpportunityDetail.js';
import {
  FORECAST_SOURCE,
  asCatalogRef,
  opportunityDetailPath,
  type OpportunityRef,
} from './funding-opportunities-api.js';

/**
 * The inbox's detail frame.
 *
 * ── One body, two frames ─────────────────────────────────────────────────────
 *
 * This renders {@link FundingOpportunityDetail} unmodified — the SAME component
 * the full page renders. There is deliberately no drawer-specific variant, no
 * "compact mode" prop and no subset of sections: two renderings of one record
 * that can disagree is how a reader ends up making a decision from the shorter
 * one.
 *
 * ── Why it is driven by the URL ──────────────────────────────────────────────
 *
 * `open` comes from a search parameter, not from component state, which buys
 * three things at once. Browser Back closes the drawer instead of leaving the
 * page. A colleague can be sent the exact row that was open. And a refresh
 * reopens it rather than dumping the reader back at the top of the queue.
 *
 * ── Escape and focus ─────────────────────────────────────────────────────────
 *
 * AntD's Drawer already traps focus and closes on Escape; both route through
 * `onClose`, so the URL is cleared by the same path a click on the mask takes and
 * the two can never disagree about whether the drawer is open.
 */
export function FundingOpportunityDrawer({
  refValue,
  onClose,
}: {
  /** Null closes the drawer. Decoded from the URL by the caller. */
  refValue: OpportunityRef | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const screens = Grid.useBreakpoint();
  /**
   * Null for a forecast ref, which is the dispatch below. Computed once so the
   * title and the body cannot disagree about which record type is open.
   */
  const catalogRef = refValue ? asCatalogRef(refValue) : null;
  /**
   * Full width below the `md` breakpoint. A 720px drawer on a phone renders as a
   * sliver of content under a mask, which is worse than no drawer at all.
   */
  const width = screens.md ? 720 : '100%';

  return (
    <Drawer
      open={refValue != null}
      onClose={onClose}
      width={width}
      destroyOnClose
      title={refValue?.source === FORECAST_SOURCE ? 'Agency forecast detail' : 'Opportunity detail'}
      rootClassName="fo-detail__drawer"
      data-testid="fo-detail-drawer"
      extra={
        refValue ? (
          <Space>
            {/*
              The same body at its own URL. Offered because a drawer is a poor
              place to read eight sections, and because the full page is the link
              worth pasting into a ticket.
            */}
            <Button size="small" onClick={() => navigate(opportunityDetailPath(refValue))}>
              Open full page
            </Button>
          </Space>
        ) : null
      }
    >
      {/*
        ONE body per RECORD TYPE, and the choice is made here rather than inside
        a body. A forecast is a different shape from a `FundingOpportunity` — no
        response deadline, no eligibility, no money — so rendering it through the
        opportunity body would mean either inventing those three or showing
        "Unknown" against questions that do not apply to it. Both bodies are
        rendered UNMODIFIED, exactly as the full page renders them.
      */}
      {refValue == null ? null : catalogRef == null ? (
        <ForecastOpportunityDetail
          forecastId={refValue.sourceRecordId}
          clientId={refValue.clientId}
        />
      ) : (
        <FundingOpportunityDetail refValue={catalogRef} />
      )}
    </Drawer>
  );
}
