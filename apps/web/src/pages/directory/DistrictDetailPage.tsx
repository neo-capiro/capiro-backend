import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, Empty, Segmented, Spin, Typography } from 'antd';
import { useApi } from '../../lib/use-api.js';
import { getDistrict } from './directory-api.js';
import { DistrictDetailView } from './DistrictDetailView.js';
import { ProfileBackLink } from './ProfileBackLink.js';

const { Paragraph } = Typography;

export default function DistrictDetailPage() {
  const { state, districtNo } = useParams<{ state: string; districtNo: string }>();
  const [status, setStatus] = useState<'C' | 'F'>('C');
  const api = useApi();
  const navigate = useNavigate();

  const query = useQuery({
    queryKey: ['district-detail', state, districtNo, status],
    queryFn: () => getDistrict(api, state!, districtNo!, status),
    enabled: Boolean(state && districtNo),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  // A district doesn't necessarily have BOTH a current and a future/enacted
  // row at any given time — only during a live redistricting cycle. A 404
  // on the 'F' side just means "no pending map," not an error.
  const noFutureMap = status === 'F' && query.isError;

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
      <Paragraph>
        <ProfileBackLink navigate={navigate} />
      </Paragraph>
      <Paragraph>
        <Segmented
          value={status}
          onChange={(v) => setStatus(v as 'C' | 'F')}
          options={[
            { label: 'Current map', value: 'C' },
            { label: 'Enacted (future) map', value: 'F' },
          ]}
        />
      </Paragraph>
      {query.isLoading ? (
        <Spin />
      ) : noFutureMap ? (
        <Empty description="No pending redistricting map on record for this district" />
      ) : query.isError || !query.data ? (
        <Alert
          type="error"
          showIcon
          message="District not found"
          description="This district could not be found."
        />
      ) : (
        <DistrictDetailView district={query.data} api={api} />
      )}
    </div>
  );
}
