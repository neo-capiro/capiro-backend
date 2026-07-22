import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, Spin, Typography } from 'antd';
import { useApi } from '../../lib/use-api.js';
import { getStaffDetail } from './directory-api.js';
import { StaffProfileView } from './StaffProfileView.js';
import { ProfileBackLink } from './ProfileBackLink.js';

const { Paragraph } = Typography;

export default function StaffDirectoryProfilePage() {
  const { staffId } = useParams<{ staffId: string }>();
  const api = useApi();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['directory-staff-detail', staffId],
    queryFn: () => getStaffDetail(api, staffId!),
    enabled: Boolean(staffId),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
      <Paragraph>
        <ProfileBackLink navigate={navigate} />
      </Paragraph>
      {query.isLoading ? (
        <Spin />
      ) : query.isError || !query.data ? (
        <Alert
          type="error"
          showIcon
          message="Staff profile unavailable"
          description="This staffer could not be found in the current directory snapshot."
        />
      ) : (
        <StaffProfileView staff={query.data} />
      )}
    </div>
  );
}
