/**
 * Phase 5 — top-bar bell integration for Business Development alerts.
 *
 * Small web-only contract/helper for the EXISTING shell notification bell.
 * It displays alerts the backend's watch pipeline already stored; this layer
 * performs NO provider call, ingestion, polling loop or background job —
 * only the feature-gated read + mark-read/read-all endpoints, using the
 * repo's React Query conventions.
 *
 * Kept beside bizdev-api.ts so the prospect drawer and the bell share one
 * error-message helper; the item type re-declares the tenant-wide alert
 * shape (adds prospectId, which the prospect-scoped endpoint omits).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { bizdevErrorMessage, type BizDevProspectAlert } from './bizdev-api.js';

/** Tenant-wide unread alert row (GET /api/business-development/alerts). */
export type BizDevBellAlert = Pick<
  BizDevProspectAlert,
  | 'title'
  | 'summary'
  | 'materiality'
  | 'materialityLevel'
  | 'company'
  | 'sourceFamily'
  | 'category'
  | 'eventAt'
  | 'effectiveAt'
  | 'publishedAt'
  | 'firstObservedAt'
  | 'sourceLocator'
  | 'implication'
  | 'readAt'
  | 'dismissedAt'
> & {
  id: string;
  /** Present only on the tenant-wide listing; the bell needs it to route. */
  prospectId: string;
};

export interface BizDevBellAlertsResponse {
  items: BizDevBellAlert[];
  nextCursor?: string | null;
  unreadCount: number;
}

const BD_ALERTS_PATH = '/api/business-development/alerts';
const bdAlertsKey = (tenantId: string) =>
  ['business-development', tenantId, 'bell', 'alerts'] as const;

/**
 * Unread Business Development alerts for the bell. Disabled (zero requests)
 * unless the caller passes the exact feature flag true. Query key includes
 * tenantId so React Query invalidates/refetches on tenant switch.
 */
export function useBizDevBellAlerts(tenantId: string | undefined, enabled: boolean) {
  const api = useApi();
  return useQuery<BizDevBellAlertsResponse>({
    queryKey: bdAlertsKey(tenantId ?? ''),
    queryFn: async () =>
      (
        await api.get<BizDevBellAlertsResponse>(BD_ALERTS_PATH, {
          params: { limit: 25, unreadOnly: true },
        })
      ).data,
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

/** POST /prospects/:prospectId/alerts/:alertId/read — the bell's row action. */
export function useBizDevBellMarkAlertRead() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { prospectId: string; alertId: string }) =>
      (
        await api.post(
          `/api/business-development/prospects/${encodeURIComponent(input.prospectId)}/alerts/${encodeURIComponent(input.alertId)}/read`,
          {},
        )
      ).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['business-development'] });
    },
  });
}

/** POST /alerts/read-all — folded into the bell's Mark all read. */
export function useBizDevBellMarkAllRead() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post(`${BD_ALERTS_PATH}/read-all`, {})).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['business-development'] });
    },
  });
}

/** Human error text (Nest message arrays joined, never raw internal ids). */
export function bizDevBellError(error: unknown): string {
  return bizdevErrorMessage(error) || 'Could not mark this alert read.';
}

/** Safe deep link: absolute http(s) only, always opened in a new tab. */
export function isSafeBizDevSourceUrl(url: string | null): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Exact (not relative) date line for an alert, preferring event → published → observed. */
export function bizDevBellDateLine(alert: BizDevBellAlert): string | null {
  const iso = alert.eventAt ?? alert.effectiveAt ?? alert.publishedAt ?? alert.firstObservedAt;
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
