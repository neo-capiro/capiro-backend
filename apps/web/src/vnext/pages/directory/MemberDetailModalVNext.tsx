import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { getMemberDetail } from '../../../pages/directory/directory-api.js';
import { CapiroEmptyState, CapiroSkeleton } from '../../components/feedback/index.js';
import { CapiroModal } from '../../components/overlays/index.js';
import { MemberProfileViewVNext } from './MemberProfileVNext.js';

/**
 * Member DETAIL modal — the member-profile-page equivalent of
 * `StaffProfileModalVNext`. Fetches the same `/api/directory/members/:id`
 * resource under the same `['directory-member-detail', id]` query key that
 * `MemberProfileVNext`'s own route uses, and renders the same
 * `MemberProfileViewVNext` body, just inside `CapiroModal`.
 *
 * This is deliberately NOT `MemberProfileModalVNext` (the 7-tab re-skin of the
 * canonical antd modal): that component needs a `DirectoryEntry` — the
 * Congressional Staff LIST row's own snapshot — which a caller with only a
 * member id (e.g. a committee's `chair`/`rankingMember` reference, which
 * carries nothing but an id and a name) does not have. Anywhere only an id is
 * available, this is the modal to reach for, exactly the same tradeoff
 * `StaffProfileModalVNext` already made for staffers.
 */
export function MemberDetailModalVNext({
  memberId,
  open,
  onClose,
}: {
  memberId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const api = useApi();
  const query = useQuery({
    queryKey: ['directory-member-detail', memberId],
    queryFn: () => getMemberDetail(api, memberId as string),
    enabled: Boolean(memberId) && open,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  if (!memberId) return null;

  const displayName = query.data
    ? [query.data.identity.preferredFirstName ?? query.data.identity.firstName, query.data.identity.lastName]
        .filter(Boolean)
        .join(' ')
        .trim()
    : '';

  return (
    <div className="capiro-dirprofile capiro-dirprofile--node">
      <CapiroModal open={open} title={displayName || 'Member profile'} onClose={onClose}>
        <div key={memberId} className="capiro-dirprofile__body">
          {query.isLoading ? (
            <CapiroSkeleton height={180} />
          ) : query.isError || !query.data ? (
            <CapiroEmptyState
              title="Member profile unavailable"
              description="This member could not be found in the current directory snapshot."
            />
          ) : (
            <MemberProfileViewVNext member={query.data} />
          )}
        </div>
      </CapiroModal>
    </div>
  );
}
