import { Alert, Button, Drawer, Grid, Space } from 'antd';
import { useNavigate } from 'react-router-dom';
import { FundingOpportunityDetail } from './FundingOpportunityDetail.js';
import { ForecastOpportunityDetail } from './ForecastOpportunityDetail.js';
import {
  DIBBS_NO_DETAIL_DESCRIPTION,
  DIBBS_NO_DETAIL_MESSAGE,
  DIBBS_SOURCE,
  FORECAST_SOURCE,
  SBIR_NO_DETAIL_DESCRIPTION,
  SBIR_NO_DETAIL_MESSAGE,
  SBIR_SOURCE,
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
   * Null for anything that is not a catalog record. Computed once so the title
   * and the body cannot disagree about which record type is open.
   *
   * NOT the dispatch. Until P41 null here meant "forecast" and the body branched
   * on it; `dibbs` is now also null, so the body switches on `refValue.source`
   * instead. See {@link asCatalogRef}.
   */
  const catalogRef = refValue ? asCatalogRef(refValue) : null;
  const isDibbs = refValue?.source === DIBBS_SOURCE;
  /**
   * Rails with no detail body. Both render an honest sentence rather than
   * borrowing another record type's body — see the dispatch comment below.
   */
  const hasNoDetailBody = isDibbs || refValue?.source === SBIR_SOURCE;
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
      title={drawerTitle(refValue)}
      rootClassName="fo-detail__drawer"
      data-testid="fo-detail-drawer"
      extra={
        refValue && !hasNoDetailBody ? (
          <Space>
            {/*
              The same body at its own URL. Offered because a drawer is a poor
              place to read eight sections, and because the full page is the link
              worth pasting into a ticket.

              WITHHELD for a bid-board ref: the full page has no body for one
              either, so the control would lead from "there is no detail here" to
              a second page saying the same thing. An action that cannot do
              anything is worse than an absent one — it reads as a route that is
              broken rather than a surface that does not exist yet.
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
        "Unknown" against questions that do not apply to it. Each real body is
        rendered UNMODIFIED, exactly as the full page renders it.

        EVERY BRANCH IS POSITIVE, and the last one is not a body. This dispatch
        used to end in "…otherwise it is a forecast", which was true only for as
        long as forecasts were the sole non-catalog rail — P41 added a second and
        that default silently became "render a DLA bid-board item as an agency
        forecast". A rail now has to be NAMED to get a body, and an unnamed one
        gets a sentence saying there is no view for it. That is wrong in a way a
        reader can see, rather than wrong in a way that looks like data.
      */}
      {refValue == null ? null : catalogRef != null ? (
        <FundingOpportunityDetail refValue={catalogRef} />
      ) : refValue.source === FORECAST_SOURCE ? (
        <ForecastOpportunityDetail
          forecastId={refValue.sourceRecordId}
          clientId={refValue.clientId}
        />
      ) : isDibbs ? (
        <Alert
          type="info"
          showIcon
          data-testid="fo-drawer-dibbs-no-detail"
          message={DIBBS_NO_DETAIL_MESSAGE}
          description={DIBBS_NO_DETAIL_DESCRIPTION}
        />
      ) : refValue.source === SBIR_SOURCE ? (
        <Alert
          type="info"
          showIcon
          data-testid="fo-drawer-sbir-no-detail"
          message={SBIR_NO_DETAIL_MESSAGE}
          description={SBIR_NO_DETAIL_DESCRIPTION}
        />
      ) : (
        <Alert
          type="info"
          showIcon
          data-testid="fo-drawer-no-detail"
          message="There is no detail view for this rail yet"
          description={`Capiro holds “${refValue.source}” rows but has no detail surface for them. This says nothing about whether the record exists.`}
        />
      )}
    </Drawer>
  );
}

/**
 * The frame's own title, per record type.
 *
 * A function rather than a nested ternary in the JSX because it must stay in
 * step with the body dispatch below, and two nested ternaries in two places is
 * how a drawer ends up titled "Opportunity detail" over a forecast.
 */
function drawerTitle(refValue: OpportunityRef | null): string {
  if (refValue?.source === FORECAST_SOURCE) return 'Agency forecast detail';
  if (refValue?.source === DIBBS_SOURCE) return 'Bid-board item';
  if (refValue?.source === SBIR_SOURCE) return 'SBIR/STTR topic';
  return 'Opportunity detail';
}
