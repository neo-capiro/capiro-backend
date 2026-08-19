import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { getStaffDetail } from '../../../pages/directory/directory-api.js';
import { CapiroEmptyState, CapiroSkeleton } from '../../components/feedback/index.js';
import { CapiroModal } from '../../components/overlays/index.js';
import { StaffProfileViewVNext } from './StaffProfileVNext.js';

/**
 * Staff profile modal — same `getStaffDetail`/`['directory-staff-detail', id]`
 * query and the same `StaffProfileViewVNext` body `StaffProfileVNext.tsx`'s
 * own route renders, just inside `CapiroModal` instead of a full-page
 * navigation. Lets a click on a hierarchy/roster node see the profile
 * without losing your place in the diagram — `MemberProfileModalVNext` is
 * this same idea for members, this is the staffer equivalent Directory
 * didn't have yet.
 */
export function StaffProfileModalVNext({
  staffId,
  open,
  onClose,
}: {
  staffId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const api = useApi();
  const query = useQuery({
    queryKey: ['directory-staff-detail', staffId],
    queryFn: () => getStaffDetail(api, staffId as string),
    enabled: Boolean(staffId) && open,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  if (!staffId) return null;

  return (
    <div className="capiro-dirprofile">
      <CapiroModal open={open} title={query.data ? staffDisplayName(query.data) : 'Staff profile'} onClose={onClose}>
        <div key={staffId} className="capiro-dirprofile__body">
          {query.isLoading ? (
            <CapiroSkeleton height={180} />
          ) : query.isError || !query.data ? (
            <CapiroEmptyState
              title="Staff profile unavailable"
              description="This staffer could not be found in the current directory snapshot."
            />
          ) : (
            <StaffProfileViewVNext staff={query.data} />
          )}
        </div>
      </CapiroModal>
    </div>
  );
}

function staffDisplayName(staff: Parameters<typeof StaffProfileViewVNext>[0]['staff']): string {
  return (
    [staff.identity.preferredFirstName ?? staff.identity.firstName, staff.identity.lastName]
      .filter(Boolean)
      .join(' ')
      .trim() || 'Staff profile'
  );
}
