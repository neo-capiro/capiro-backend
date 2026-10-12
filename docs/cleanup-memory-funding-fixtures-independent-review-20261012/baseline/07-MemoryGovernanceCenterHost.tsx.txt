import { Alert, Card, Space } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../lib/use-api.js';
import { MemoryGovernanceCenter } from './MemoryGovernanceCenter.js';
import { MemoryReviewInbox } from './MemoryReviewInbox.js';

interface CenterAvailability {
  enabled: boolean;
}

/**
 * Phase 3 host for the plain-English Review Inbox.
 *
 * Every authenticated user gets the same canonical review workflow. Admins may
 * additionally receive the Governance Center after its existing server-side
 * rollout gate is armed. The legacy body-bearing proposal/reviewer queues are
 * deliberately not mounted here; proposal content now loads only from the
 * protected inbox detail endpoint.
 */
export function MemoryGovernanceCenterHost({ isAdmin }: { isAdmin: boolean }) {
  const api = useApi();
  const availability = useQuery<CenterAvailability>({
    queryKey: ['memory-governance-availability'],
    queryFn: async () =>
      (await api.get<CenterAvailability>('/api/memory/governance')).data,
    enabled: isAdmin,
    retry: 1,
    staleTime: 10_000,
  });

  if (!isAdmin) return <MemoryReviewInbox isAdmin={false} />;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <MemoryReviewInbox isAdmin />

      {availability.isLoading && (
        <Card loading aria-label="Loading memory governance" />
      )}
      {availability.isError && (
        <Alert
          type="warning"
          showIcon
          message="Governance Center is temporarily unavailable"
          description="The Review Inbox remains available. Refresh before taking a governance action."
        />
      )}
      {availability.data?.enabled && <MemoryGovernanceCenter isAdmin />}
    </Space>
  );
}
