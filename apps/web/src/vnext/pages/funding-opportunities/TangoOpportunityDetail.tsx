import { useQuery } from '@tanstack/react-query';
import { CapiroButton } from '../../components/actions/index.js';
import { useApi } from '../../../lib/use-api.js';
import {
  formatSourceDate,
  INBOX_SOURCE_LABELS,
  type InboxDibbsFacts,
  type InboxSbirFacts,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { fundingFeedPath, type FundingFeedRecord } from './opportunity-feeds-api.js';
import { OpportunityClientActions, OpportunityOwnerLabel } from './OpportunityClientActions.js';
import { sourceWebUrl } from './opportunity-query-cache.js';
import { FovAlert, FovCard, FovFact, FovPill, FovSkeletonRows } from './fov-ui.js';

/** DIBBS/SBIR source detail; both drawer and full-page routes use this body. */
export function TangoOpportunityDetail({
  source,
  sourceRecordId,
  clientId,
}: {
  source: 'dibbs' | 'sbir_sttr';
  sourceRecordId: string;
  clientId: string | null;
}) {
  const api = useApi();
  const query = useQuery<FundingFeedRecord>({
    queryKey: ['funding-opportunity-feed-detail', source, sourceRecordId, clientId],
    queryFn: async () =>
      (
        await api.get<FundingFeedRecord>(
          `${fundingFeedPath(source, sourceRecordId)}${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ''}`,
        )
      ).data,
    retry: false,
  });
  if (query.isPending) return <FovSkeletonRows rows={6} />;
  if (query.isError) {
    const absent = (query.error as { response?: { status?: number } }).response?.status === 404;
    return (
      <FovAlert
        tone={absent ? 'info' : 'error'}
        message={absent ? 'This opportunity is unavailable' : 'The opportunity could not be loaded'}
        description={
          absent
            ? 'The record or client may be unavailable, or this feed may not be enabled for your workspace.'
            : 'Try again to load the source record.'
        }
        action={
          !absent ? <CapiroButton onClick={() => void query.refetch()}>Retry</CapiroButton> : null
        }
      />
    );
  }
  const record = query.data;
  const dibbs = source === 'dibbs' ? (record.facts as InboxDibbsFacts) : null;
  const sbir = source === 'sbir_sttr' ? (record.facts as InboxSbirFacts) : null;
  const sourceUrl = sourceWebUrl(record.sourceUrl);
  return (
    <div className="fov fov-detail" data-testid={`fo-${source}-detail`}>
      <header className="fov-detail__head">
        <FovPill>{INBOX_SOURCE_LABELS[source]}</FovPill>
        <h2>{record.title}</h2>
        <p className="fov-muted">{record.agency ?? 'Agency not provided'}</p>
      </header>
      <FovCard title="Opportunity at a glance">
        <div className="fov-card__facts">
          <FovFact
            label="Response deadline"
            value={formatSourceDate(record.responseDeadline?.slice(0, 10) ?? null, 'Not provided')}
          />
          <FovFact
            label="Source status"
            value={record.status ?? (record.isActive === false ? 'Closed' : 'Not provided')}
          />
          <FovFact
            label="Last observed by Capiro"
            value={new Date(record.lastSyncedAt).toLocaleString()}
          />
        </div>
        {record.description ? (
          <p style={{ whiteSpace: 'pre-wrap' }}>{record.description}</p>
        ) : (
          <p className="fov-muted">The source did not provide a description.</p>
        )}
        {sourceUrl ? (
          <a href={sourceUrl} target="_blank" rel="noreferrer">
            Open the source record ↗
          </a>
        ) : (
          <span className="fov-muted">
            The provider did not supply a source link for this record.
          </span>
        )}
      </FovCard>
      <OpportunityClientActions
        source={source}
        sourceRecordId={sourceRecordId}
        clientId={record.clientId}
        title={record.title}
        isActive={record.isActive !== false}
        canPursue={record.isActive === true}
        workflowStatus={record.workflow?.status}
        notes={record.workflow?.notes}
        ownerUserId={record.workflow ? record.workflow.ownerUserId : null}
        nextAction={
          record.workflow?.nextAction !== undefined
            ? record.workflow.nextAction
            : record.decision?.nextAction
        }
        nextActionDueAt={
          record.workflow?.nextActionDueAt !== undefined
            ? record.workflow.nextActionDueAt
            : record.decision?.nextActionDueAt
        }
      />
      {record.isActive == null ? (
        <FovAlert
          message="Verify availability before proceeding"
          description="The available source fields do not establish whether this opportunity is currently open. You can save it or create a review task."
        />
      ) : null}
      <FovCard title="Team plan">
        <div className="fov-card__facts">
          <FovFact label="Decision" value={record.decision?.decision ?? 'Not decided'} />
          <FovFact
            label="Owner"
            value={
              <OpportunityOwnerLabel
                ownerUserId={record.workflow ? record.workflow.ownerUserId : null}
              />
            }
          />
          <FovFact
            label="Next action"
            value={record.workflow?.nextAction ?? record.decision?.nextAction ?? 'None recorded'}
          />
          <FovFact
            label="Follow-up date"
            value={formatSourceDate(
              (record.workflow?.nextActionDueAt ?? record.decision?.nextActionDueAt)?.slice(
                0,
                10,
              ) ?? null,
              'No date',
            )}
          />
        </div>
        {record.workflow?.notes ? (
          <p style={{ whiteSpace: 'pre-wrap' }}>{record.workflow.notes}</p>
        ) : null}
      </FovCard>
      <details>
        <summary>Source details</summary>
        <FovCard>
          <div className="fov-card__facts">
            <FovFact label="Record reference" value={record.sourceRecordId} />
            {dibbs ? (
              <>
                <FovFact label="Document" value={dibbs.documentType.toUpperCase()} />
                <FovFact
                  label="Solicitation"
                  value={dibbs.solicitationFormatted ?? dibbs.solicitation}
                />
                <FovFact label="National stock number" value={dibbs.nsn ?? 'Not provided'} />
                <FovFact label="Part number" value={dibbs.partNumber ?? 'Not provided'} />
                <FovFact
                  label="Quantity"
                  value={
                    dibbs.quantity && dibbs.unitOfIssue
                      ? `${dibbs.quantity} ${dibbs.unitOfIssue}`
                      : 'Not provided'
                  }
                />
                <FovFact label="Set-aside" value={dibbs.setAside ?? 'Not provided'} />
              </>
            ) : null}
            {sbir ? (
              <>
                <FovFact label="Topic" value={sbir.topicNumber ?? 'Not provided'} />
                <FovFact label="Solicitation" value={sbir.solicitationNumber ?? 'Not provided'} />
                <FovFact label="Opens" value={formatSourceDate(sbir.openDate, 'Not provided')} />
                <FovFact label="Program year" value={sbir.year ?? 'Not provided'} />
              </>
            ) : null}
          </div>
          {source === 'sbir_sttr' ? (
            <p className="fov-micro">
              Check the official solicitation for the funding instrument and eligibility
              requirements.
            </p>
          ) : null}
        </FovCard>
      </details>
    </div>
  );
}
