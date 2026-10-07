import { useAuth } from '@clerk/clerk-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlannerBellFeed, PlannerBellItem } from '@capiro/strategy-verifier';
import { useApi } from '../../../lib/use-api.js';
import { useImpersonation } from '../../../state/impersonation.js';
import { usePlannerKey } from './planner-api.js';

export function usePlannerNotificationsEnabled() {
  const { orgId, userId } = useAuth();
  const { actAsTenantSlug } = useImpersonation();
  return Boolean(orgId && userId && !actAsTenantSlug);
}
export function usePlannerNotifications() {
  const api = useApi();
  const key = usePlannerKey();
  const enabled = usePlannerNotificationsEnabled();
  return useQuery({
    queryKey: [...key, 'notifications'],
    enabled,
    queryFn: async () =>
      (await api.get<PlannerBellFeed>('/strategy-api/planner/notifications')).data,
    refetchInterval: 20_000,
  });
}
export function usePlannerNotificationRead() {
  const api = useApi();
  const client = useQueryClient();
  const key = usePlannerKey();
  return useMutation({
    mutationFn: async (id: string) =>
      api.patch(`/strategy-api/planner/inbox/${id}`, { read: true }),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
}
export function usePlannerNotificationsReadAll() {
  const api = useApi();
  const client = useQueryClient();
  const key = usePlannerKey();
  return useMutation({
    mutationFn: async () => api.post('/strategy-api/planner/notifications/read-all', {}),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
}
/** Build routes from typed target identities, never follow an arbitrary URL. */
export function plannerNotificationTarget(item: PlannerBellItem): string {
  if (item.event.budgetThreshold)
    return `/planner?scope=budget&project=${encodeURIComponent(item.event.budgetThreshold.projectId)}`;
  if (item.event.timesheet)
    return `/planner?scope=timesheets&week=${encodeURIComponent(item.event.timesheet.weekOn)}&user=${encodeURIComponent(item.event.timesheet.userId)}`;
  return item.event.resourceId
    ? `/planner?scope=goals&goal=${encodeURIComponent(item.event.resourceId)}`
    : item.event.taskId
      ? `/planner?scope=mine&task=${encodeURIComponent(item.event.taskId)}`
      : item.event.projectId
        ? `/planner?scope=project&project=${encodeURIComponent(item.event.projectId)}`
        : '/planner?scope=inbox';
}
