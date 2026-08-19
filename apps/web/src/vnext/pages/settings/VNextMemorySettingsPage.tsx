/**
 * vNext re-skin of pages/settings/MemorySettingsPage.tsx (plus its
 * MemoryGovernanceCenterHost wrapper) — identical query keys, role gating,
 * scope segmented control and copy. Review work first, then active/personal
 * memory files.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useMe } from '../../../lib/me.js';
import { useApi } from '../../../lib/use-api.js';
import { CapiroSkeleton } from '../../components/feedback/index.js';
import { SvCallout, SvCard, SvSegmented } from './settings-ui.js';
import { VNextMemoryFileEditor } from './VNextMemoryFileEditor.js';
import { VNextMemoryGovernanceCenter } from './VNextMemoryGovernanceCenter.js';
import { VNextMemoryReviewInbox } from './VNextMemoryReviewInbox.js';

interface CenterAvailability {
  enabled: boolean;
}

/**
 * Phase 3 host for the plain-English Review Inbox (canonical:
 * MemoryGovernanceCenterHost). Every authenticated user gets the same
 * canonical review workflow. Admins may additionally receive the Governance
 * Center after its existing server-side rollout gate is armed.
 */
function VNextMemoryGovernanceCenterHost({ isAdmin }: { isAdmin: boolean }) {
  const api = useApi();
  const availability = useQuery<CenterAvailability>({
    queryKey: ['memory-governance-availability'],
    queryFn: async () => (await api.get<CenterAvailability>('/api/memory/governance')).data,
    enabled: isAdmin,
    retry: 1,
    staleTime: 10_000,
  });

  if (!isAdmin) return <VNextMemoryReviewInbox isAdmin={false} />;

  return (
    <div className="stv-stack">
      <VNextMemoryReviewInbox isAdmin />

      {availability.isLoading && (
        <SvCard aria-label="Loading memory governance">
          <div className="stv-stack">
            <CapiroSkeleton height={16} />
            <CapiroSkeleton height={16} width="70%" />
          </div>
        </SvCard>
      )}
      {availability.isError && (
        <SvCallout
          kind="warning"
          title="Governance Center is temporarily unavailable"
          description="The Review Inbox remains available. Refresh before taking a governance action."
        />
      )}
      {availability.data?.enabled && <VNextMemoryGovernanceCenter isAdmin />}
    </div>
  );
}

/** Settings → Memory: review work first, then active/personal memory files. */
export function VNextMemorySettingsPage() {
  const me = useMe();
  const isAdmin = me.data?.role === 'user_admin' || me.data?.role === 'capiro_admin';

  const [scope, setScope] = useState<'firm' | 'user'>('firm');
  const slug = scope === 'firm' ? 'firm' : 'me';
  const canEdit = scope === 'user' || isAdmin;

  return (
    <div className="stv-stack">
      <VNextMemoryGovernanceCenterHost isAdmin={isAdmin} />

      <SvCard
        title="Memory Files"
        description="Firm knowledge and your personal profile ground Meri and the knowledge graph. Shared edits enter the Review Inbox before they become active. Per-client memory lives on each client’s profile."
      >
        <div className="stv-stack">
          <div className="stv-row">
            <SvSegmented
              aria-label="Memory scope"
              value={scope}
              onChange={(value) => setScope(value)}
              options={[
                { label: 'Firm', value: 'firm' },
                { label: 'My files', value: 'user' },
              ]}
            />
          </div>

          {!canEdit && (
            <SvCallout
              kind="info"
              title="You can view firm files. Editing firm memory requires an admin role."
            />
          )}
          {scope === 'user' && (
            <SvCallout
              kind="info"
              title={
                'These files are private to you and help Meri work in your voice. ' +
                'Paste real samples under My Writing Style for the best results.'
              }
            />
          )}

          <VNextMemoryFileEditor scope={scope} slug={slug} ready canEdit={canEdit} />
        </div>
      </SvCard>
    </div>
  );
}
