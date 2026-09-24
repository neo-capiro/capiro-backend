/**
 * District Nexus R5 - District Alerts panel.
 * Lists recent district alerts for the selected client.
 * Hidden when district_nexus_r5_alerts flag is off.
 */

import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useIntelFeatureEnabled } from '../../../../lib/intel-feature-flags.js';
import { CapiroErrorState, CapiroSkeleton } from '../../../../components/feedback/index.js';
import { DnxWarningIcon } from '../icons.js';
import {
  getDistrictNexusAlerts,
  DISTRICT_NEXUS_R5_ALERTS_FEATURE,
  type DistrictAlertPayload,
} from './r5-api.js';

function severityBadgeClass(severity: string): string {
  switch (severity) {
    case 'material':
      return 'dnx-badge--material';
    case 'notable':
      return 'dnx-badge--notable';
    default:
      return 'dnx-badge--info';
  }
}

function formatIsoDate(iso: string | null): string {
  if (!iso) return 'Unknown';
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

interface Props {
  clientId: string;
  state: string;
  districtNo: string;
}

export function DistrictAlertsPanelVNext({ clientId, state, districtNo }: Props) {
  const api = useApi();
  const alertsEnabled = useIntelFeatureEnabled(DISTRICT_NEXUS_R5_ALERTS_FEATURE);

  const alerts = useQuery<DistrictAlertPayload[]>({
    queryKey: ['district-nexus', 'r5', 'alerts', clientId, state, districtNo],
    queryFn: () => getDistrictNexusAlerts(api, clientId, state, districtNo),
    enabled: alertsEnabled && Boolean(clientId),
    retry: false,
  });

  if (!alertsEnabled) return null;

  return (
    <div className="dnx-panel">
      <div className="dnx-section-header">
        <h3 className="dnx-section-title">District Alerts</h3>
      </div>
      <div className="dnx-section-body">
        {alerts.isPending ? (
          <div className="dnx-skel-rows" aria-busy="true">
            <CapiroSkeleton height={14} />
            <CapiroSkeleton height={14} width="80%" />
            <CapiroSkeleton height={14} width="60%" />
          </div>
        ) : alerts.isError ? (
          <CapiroErrorState
            title="Alerts could not load"
            description="District alerts are temporarily unavailable."
          />
        ) : alerts.data?.length ? (
          <div className="dnx-alerts-list">
            {alerts.data.map((a) => (
              <div key={a.changeId} className="dnx-alert-card">
                <div className="dnx-alert-header">
                  <span className={'dnx-badge ' + severityBadgeClass(a.severity)}>
                    {a.severity}
                  </span>
                  <span className="dnx-alert-source">{a.sourceLabel}</span>
                  <span className="dnx-alert-district">{a.districtLabel}</span>
                </div>
                <div className="dnx-alert-title">{a.title}</div>
                <div className="dnx-alert-meta">
                  <span>Event: {formatIsoDate(a.eventTime)}</span>
                  <span> - Detected: {formatIsoDate(a.detectedTime)}</span>
                  <span> - Freshness: {a.freshness}</span>
                </div>
                {a.caveats.length > 0 && (
                  <div className="dnx-alert-caveats">
                    {a.caveats.map((c, i) => (
                      <span key={i} className="dnx-caveat">
                        <DnxWarningIcon /> {c}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12.5 }} className="dnx-muted">
            No recent district alerts for this client.
          </div>
        )}
      </div>
    </div>
  );
}