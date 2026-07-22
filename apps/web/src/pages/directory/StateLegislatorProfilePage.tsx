import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, Spin, Typography } from 'antd';
import { useApi } from '../../lib/use-api.js';
import { getStateLegislatorDetail } from './directory-api.js';
import { StateLegislatorProfileView } from './StateLegislatorProfileView.js';
import { ProfileBackLink } from './ProfileBackLink.js';

const { Paragraph } = Typography;

export default function StateLegislatorProfilePage() {
  // useParams decodes the segment, so `id` is the raw OpenStates id ("ocd-person/…").
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['state-legislator-detail-page', id],
    queryFn: () => getStateLegislatorDetail(api, id!),
    enabled: Boolean(id),
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
          message="State legislator profile unavailable"
          description="This legislator could not be found."
        />
      ) : (
        <StateLegislatorProfileView legislator={query.data} />
      )}
    </div>
  );
}
