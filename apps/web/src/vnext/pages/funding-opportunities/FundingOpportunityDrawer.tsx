import { useNavigate } from 'react-router-dom';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroDrawer } from '../../components/overlays/index.js';
import {
  DIBBS_SOURCE,
  FORECAST_SOURCE,
  SBIR_SOURCE,
  asCatalogRef,
  opportunityDetailPath,
  type OpportunityRef,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { ForecastOpportunityDetail } from './ForecastOpportunityDetail.js';
import { FundingOpportunityDetail } from './FundingOpportunityDetail.js';
import { TangoOpportunityDetail } from './TangoOpportunityDetail.js';
import { FovAlert } from './fov-ui.js';

/**
 * The inbox's detail frame — vNext port of the canonical
 * FundingOpportunityDrawer.
 *
 * One body, two frames: this renders {@link FundingOpportunityDetail}
 * unmodified — the SAME component the full page renders. `open` still comes
 * from a search parameter, so browser Back closes the drawer, a colleague can
 * be sent the exact row that was open, and a refresh reopens it.
 *
 * CapiroDrawer traps focus and closes on Escape/mask-click, all routed through
 * `onClose`, so the URL is cleared by the same path every close takes.
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
  /**
   * Null for anything that is not a catalog record. NOT the dispatch — the
   * body switches on `refValue.source`; see {@link asCatalogRef}.
   */
  const catalogRef = refValue ? asCatalogRef(refValue) : null;

  return (
    <div className="fov-drawerhost" data-testid="fo-detail-drawer">
      <CapiroDrawer open={refValue != null} onClose={onClose} title={drawerTitle(refValue)}>
        <div className="fov">
          {refValue ? (
            <div className="fov-row" style={{ justifyContent: 'flex-end' }}>
              {/* Every supported feed shares its detail body with the full page. */}
              <CapiroButton
                size="compact"
                onClick={() => navigate(opportunityDetailPath(refValue))}
              >
                Open full page
              </CapiroButton>
            </div>
          ) : null}

          {/*
            ONE body per RECORD TYPE, chosen here. EVERY BRANCH IS POSITIVE,
            and the last one is not a body: a rail has to be NAMED to get a
            body, and an unnamed one gets a sentence saying there is no view
            for it — wrong in a way a reader can see, rather than wrong in a
            way that looks like data.
          */}
          {refValue == null ? null : catalogRef != null ? (
            <FundingOpportunityDetail refValue={catalogRef} />
          ) : refValue.source === FORECAST_SOURCE ? (
            <ForecastOpportunityDetail
              forecastId={refValue.sourceRecordId}
              clientId={refValue.clientId}
            />
          ) : refValue.source === DIBBS_SOURCE || refValue.source === SBIR_SOURCE ? (
            <TangoOpportunityDetail
              source={refValue.source}
              sourceRecordId={refValue.sourceRecordId}
              clientId={refValue.clientId}
            />
          ) : (
            <FovAlert
              tone="info"
              testId="fo-drawer-no-detail"
              message="There is no detail view for this rail yet"
              description={`Capiro holds “${refValue.source}” rows but has no detail surface for them. This says nothing about whether the record exists.`}
            />
          )}
        </div>
      </CapiroDrawer>
    </div>
  );
}

/**
 * The frame's own title, per record type. A function so it stays in step with
 * the body dispatch — two nested ternaries in two places is how a drawer ends
 * up titled "Opportunity detail" over a forecast.
 */
function drawerTitle(refValue: OpportunityRef | null): string {
  if (refValue?.source === FORECAST_SOURCE) return 'Agency forecast detail';
  if (refValue?.source === DIBBS_SOURCE) return 'Bid-board item';
  if (refValue?.source === SBIR_SOURCE) return 'SBIR/STTR topic';
  return 'Opportunity detail';
}
