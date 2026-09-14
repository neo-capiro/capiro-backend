import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { useIntelFeatureEnabled } from '../../../../lib/intel-feature-flags.js';
import { CapiroButton } from '../../../components/actions/index.js';
export function FolderResearchButton({
  folderId,
  clientId,
  jurisdiction,
  sessionKey,
  onOpen,
}: {
  folderId: string;
  clientId?: string | null;
  jurisdiction: string;
  sessionKey: string;
  onOpen: () => void;
}) {
  const api = useApi(),
    identity = useApiScope(),
    enabled = useIntelFeatureEnabled('legiwatch_research_v1');
  const scope = { folderId, clientId: clientId ?? '', jurisdiction, sessionKey };
  const memberships = useQuery({
    queryKey: ['research-membership-count', identity, scope],
    enabled,
    retry: false,
    queryFn: async () =>
      (
        await api.get<unknown[]>(
          '/intel-api/legiwatch/research/memberships?' + new URLSearchParams(scope),
        )
      ).data,
  });
  return (
    <CapiroButton size="compact" onClick={onOpen}>
      Tracked statutes
      {memberships.data ? ' (' + memberships.data.length + ')' : enabled ? '' : ' · setup'}
    </CapiroButton>
  );
}
