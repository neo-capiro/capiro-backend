import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import { useApiScope } from '../../lib/use-api-scope.js';
import { useIntelFeatureEnabled } from '../../lib/intel-feature-flags.js';
import { HearingPublicationsPanel } from './HearingPublicationsPanelCore.js';

export function PublicHearingReviewPanel(props: {
  hearingId: string;
  clientId?: string;
  playEvidence: (ms: number) => void;
  canPlayEvidence?: (ms: number) => boolean;
}) {
  const scope = useApiScope();
  return <ScopedReview key={`${scope}:${props.hearingId}`} {...props} />;
}
function ScopedReview({
  hearingId,
  clientId,
  playEvidence,
  canPlayEvidence,
}: {
  hearingId: string;
  clientId?: string;
  playEvidence: (ms: number) => void;
  canPlayEvidence?: (ms: number) => boolean;
}) {
  const api = useApi(),
    scope = useApiScope();
  const updates = useIntelFeatureEnabled('legiwatch_hearing_updates_v1'),
    recaps = useIntelFeatureEnabled('legiwatch_hearing_recaps_v1');
  const sms = useIntelFeatureEnabled('legiwatch_hearing_sms_v1');
  const [opened, setOpened] = useState(
    Boolean(new URLSearchParams(window.location.search).get('publication')),
  );
  const [recapRequested, setRecapRequested] = useState(false);
  const context = useQuery({
    queryKey: ['public-hearing-review', scope, hearingId],
    enabled: opened && (updates || recaps),
    retry: false,
    queryFn: async () =>
      (
        await api.post<{ sessionId: string; title: string }>(
          `/intel-api/public-hearings/${encodeURIComponent(hearingId)}/review-context`,
          { kind: updates ? 'live_update' : 'hearing_recap' },
        )
      ).data,
  });
  const clients = useQuery({
    queryKey: ['public-hearing-review-clients', scope],
    enabled: opened && (updates || recaps),
    retry: false,
    queryFn: async () => (await api.get<Array<{ id: string; name: string }>>('/api/clients')).data,
  });
  useEffect(() => {
    if (window.location.hash === '#reviewed-recap') {
      setOpened(true);
      setRecapRequested(true);
    }
  }, []);
  if (!updates && !recaps) return null;
  return (
    <section className="lw-card" style={{ padding: 18 }} aria-label="Reviewed hearing publications">
      {!opened ? (
        <>
          <h2 className="lw-card__title">Reviewed updates and recaps</h2>
          <p>
            Create a client-specific version from final transcript evidence. Review and approve it
            before choosing a delivery audience.
          </p>
          <button className="lw-btn" onClick={() => setOpened(true)}>
            Open review workspace
          </button>
        </>
      ) : null}
      {opened && context.isPending ? (
        <p role="status">Opening the canonical transcript for review…</p>
      ) : null}
      {context.isError ? (
        <p role="alert">
          Review is unavailable. A canonical capture and current source permission for analysis are
          required.
        </p>
      ) : null}
      {context.data ? (
        <HearingPublicationsPanel
          sessionId={context.data.sessionId}
          eventId={hearingId}
          title={context.data.title}
          defaultClientId={clientId}
          clients={clients.data ?? []}
          updatesEnabled={updates}
          recapsEnabled={recaps}
          smsEnabled={sms}
          recapRequested={recapRequested}
          onRecapOpened={() => setRecapRequested(false)}
          playEvidence={playEvidence}
          canPlayEvidence={canPlayEvidence}
        />
      ) : null}
    </section>
  );
}
