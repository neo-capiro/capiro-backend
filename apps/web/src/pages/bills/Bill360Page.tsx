import { useCallback } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Empty } from 'antd';
import { BILL_360_FEATURE, useIntelFeature } from '../../lib/intel-feature-flags.js';
import { BillDossierBody } from './BillDossierBody.js';
import './bill-360.css';

/**
 * Bill 360 full page (plan §2.2) — the deep-linkable, shareable dossier:
 *
 *   /bills/:billId                    global/public dossier
 *   /bills/:billId?client=<clientId>  the same public facts + that client's context
 *
 * A copied URL opens standalone with no originating page (§2.5), so the route
 * reads its whole state from the URL and holds none of its own.
 *
 * Fails CLOSED on the `bill_360` flag: while the flag is unresolved the page
 * renders nothing (no flash of a surface the tenant may not have), and when it
 * resolves OFF it renders a plain not-available state rather than a blank page
 * (§5 edge case 11). `?scope=` is deliberately NOT handled here — the neutral
 * scope context arrives in R6.
 */
export function Bill360Page() {
  const { billId } = useParams<{ billId: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { enabled, ready } = useIntelFeature(BILL_360_FEATURE);

  const clientId = params.get('client');

  // Back leaves the dossier the way the user arrived: history when there is any,
  // otherwise LegiWatch (a copied link opened in a fresh tab has no history).
  const onBack = useCallback(() => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      navigate(-1);
      return;
    }
    navigate(clientId ? `/clients?clientId=${encodeURIComponent(clientId)}` : '/legiwatch');
  }, [navigate, clientId]);

  if (!ready) return <div className="bill360-route" />;

  if (!enabled) {
    return (
      <div className="bill360-route" style={{ display: 'grid', placeItems: 'center' }}>
        <Empty description="Bill 360 is not enabled for this workspace." />
      </div>
    );
  }

  if (!billId) {
    return (
      <div className="bill360-route" style={{ display: 'grid', placeItems: 'center' }}>
        <Empty description="No bill specified." />
      </div>
    );
  }

  return (
    <div className="bill360-route redesign">
      <BillDossierBody
        billId={billId}
        clientId={clientId}
        mode="page"
        onClose={onBack}
      />
    </div>
  );
}

export default Bill360Page;
