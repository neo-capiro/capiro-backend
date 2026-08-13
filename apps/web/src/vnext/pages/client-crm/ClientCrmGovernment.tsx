import { TargetsTab } from '../../../pages/clients/TargetsTab.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

/**
 * Relationships / Government — the vNext host for the canonical target domain.
 *
 * Targets, recommendation refresh, directory search, tiers, and deletion all
 * already have one mature owner in TargetsTab and the /api/clients/:id/targets
 * contract. Mount it here rather than creating a second, reduced relationship
 * store that drifts from Portfolio > Client Profile.
 */
export function ClientCrmGovernment({
  client,
  canManage,
}: {
  client: Client;
  canManage: boolean;
}) {
  return (
    <div className="capiro-crm__body">
      <div className="capiro-crm__page-head">
        <div>
          <h2 className="capiro-crm__page-title">Government relationships</h2>
          <p className="capiro-crm__page-sub">
            Manage target offices and review Meri recommendations from the client&apos;s bills,
            issues, and facility footprint.
          </p>
        </div>
      </div>

      <TargetsTab clientId={client.id} canManage={canManage} />
    </div>
  );
}
