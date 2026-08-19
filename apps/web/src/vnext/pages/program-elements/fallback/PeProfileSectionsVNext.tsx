/**
 * Profile sections dispatcher — native vNext port of
 * `pages/program-element/ProgramElementProfileFinalSections.tsx` (re-skin:
 * identical vm consumption, panel wiring, section layout).
 */
import {
  toProgramElementHistoryRows,
  type ProgramElementProfileFinalVm,
} from '../../../../pages/program-element/useProgramElementProfileFinalCore.js';
import { PeFyHistoryChartVNext } from './PeFyHistoryChartVNext.js';
import { PeFundingNarrativePanelVNext } from './PeFundingNarrativePanelVNext.js';
import { PeBillsTouchingPePanelVNext } from './PeBillsTouchingPePanelVNext.js';
import { PeContractorsPanelVNext } from './PeContractorsPanelVNext.js';
import { PeProgramTeamPanelVNext } from './PeProgramTeamPanelVNext.js';
import { PeProvisionsPanelVNext } from './PeProvisionsPanelVNext.js';
import { PeSecondaryDistributionPanelVNext } from './PeSecondaryDistributionPanelVNext.js';
import {
  PeAppropriabilityPanelVNext,
  PeBudgetActionsFeedVNext,
  PeIncumbentMapPanelVNext,
  PeMaturityLadderPanelVNext,
  PeRelationshipGraphPanelVNext,
} from './pe-fallback-budget-line-panels.js';
import {
  PeClientRelevancePanelVNext,
  PePdocDetailPanelVNext,
  PeProcurementActivityPanelVNext,
  PeProgramsPanelVNext,
  PeProjectsPanelVNext,
  PeProofPackPanelVNext,
  PeRelatedPesPanelVNext,
  PeWhatChangedPanelVNext,
} from './pe-fallback-panels-misc.js';

export function PeProfileSectionsVNext({
  vm,
}: {
  vm: ProgramElementProfileFinalVm;
}) {
  const {
    code,
    navigate,
    section,
    detail,
    billsWithActions,
    billsQuery,
    billActionsQuery,
    budgetActionsQuery,
    deltasQuery,
    narrativeQuery,
    projectsQuery,
    procurementQuery,
    relatedQuery,
    programsQuery,
    relationshipsQuery,
    provisionsQuery,
    opportunitiesQuery,
    contractorsQuery,
    incumbentsQuery,
    peopleQuery,
    intelligenceQuery,
    clientsQuery,
    sourcesQuery,
    people,
    pdoc,
    setLinkTarget,
  } = vm;
  if (!detail) return null;

  if (section === 'funding') {
    return (
      <div className="pe-fb-stack">
        <Panel>
          <PeFyHistoryChartVNext
            rows={toProgramElementHistoryRows(detail.years ?? [])}
            loading={false}
          />
        </Panel>
        <Panel>
          <PeWhatChangedPanelVNext
            deltas={deltasQuery.isError ? undefined : deltasQuery.data?.data}
            loading={deltasQuery.isLoading}
            errored={deltasQuery.isError}
            onRetry={() => void deltasQuery.refetch()}
          />
        </Panel>
        <Panel>
          <PeFundingNarrativePanelVNext
            peCode={code}
            data={narrativeQuery.isError ? undefined : narrativeQuery.data}
            loading={narrativeQuery.isLoading}
            errored={narrativeQuery.isError}
            onRetry={() => void narrativeQuery.refetch()}
          />
        </Panel>
      </div>
    );
  }

  if (section === 'legislative') {
    return (
      <div className="pe-fb-stack">
        <Panel>
          <PeBillsTouchingPePanelVNext
            bills={billsWithActions}
            loading={billsQuery.isLoading || billActionsQuery.isLoading}
            errored={billsQuery.isError}
            onRetry={() => void billsQuery.refetch()}
            billActionsErrored={billActionsQuery.isError}
            onRetryBillActions={() => void billActionsQuery.refetch()}
          />
        </Panel>
        <Panel title="Budget actions" sub="normalized committee events">
          <PeBudgetActionsFeedVNext
            actions={budgetActionsQuery.isError ? undefined : budgetActionsQuery.data}
            loading={budgetActionsQuery.isLoading}
            errored={budgetActionsQuery.isError}
            onRetry={() => void budgetActionsQuery.refetch()}
          />
        </Panel>
        <Panel>
          <PeProvisionsPanelVNext
            provisions={provisionsQuery.isError ? undefined : provisionsQuery.data}
            loading={provisionsQuery.isLoading}
            errored={provisionsQuery.isError}
            onRetry={() => void provisionsQuery.refetch()}
          />
        </Panel>
        <Panel>
          <PeProcurementActivityPanelVNext
            opportunities={
              opportunitiesQuery.isError ? undefined : opportunitiesQuery.data
            }
            loading={opportunitiesQuery.isLoading}
            errored={opportunitiesQuery.isError}
            onRetry={() => void opportunitiesQuery.refetch()}
          />
        </Panel>
      </div>
    );
  }

  if (section === 'structure') {
    return (
      <div className="pe-fb-section-grid">
        <Panel wide>
          <PeProjectsPanelVNext
            projects={projectsQuery.isError ? undefined : projectsQuery.data}
            loading={projectsQuery.isLoading}
            errored={projectsQuery.isError}
            onRetry={() => void projectsQuery.refetch()}
          />
        </Panel>
        <Panel wide>
          <PeSecondaryDistributionPanelVNext
            data={procurementQuery.isError ? undefined : procurementQuery.data}
            loading={procurementQuery.isLoading}
            errored={procurementQuery.isError}
            onRetry={() => void procurementQuery.refetch()}
          />
        </Panel>
        {pdoc ? (
          <Panel wide>
            <PePdocDetailPanelVNext
              detail={pdoc}
              onOpenPe={(target) => navigate(`/program-elements/${target}`)}
            />
          </Panel>
        ) : null}
        <Panel>
          <PeProgramsPanelVNext
            programs={programsQuery.isError ? undefined : programsQuery.data}
            loading={programsQuery.isLoading}
            errored={programsQuery.isError}
            onRetry={() => void programsQuery.refetch()}
          />
        </Panel>
        <Panel>
          <PeRelatedPesPanelVNext
            related={relatedQuery.isError ? undefined : relatedQuery.data}
            loading={relatedQuery.isLoading}
            errored={relatedQuery.isError}
            onRetry={() => void relatedQuery.refetch()}
          />
        </Panel>
        <Panel
          wide
          title="Relationship graph"
          sub="accepted and candidate evidence"
        >
          <PeRelationshipGraphPanelVNext
            peCode={code}
            relationships={
              relationshipsQuery.isError ? undefined : relationshipsQuery.data
            }
            loading={relationshipsQuery.isLoading}
            errored={relationshipsQuery.isError}
            onRetry={() => void relationshipsQuery.refetch()}
            onOpen={(target) => navigate(`/program-elements/${target}`)}
          />
        </Panel>
        <Panel wide title="Transition maturity" sub="research → acquisition">
          <PeMaturityLadderPanelVNext
            ladder={
              intelligenceQuery.isError
                ? undefined
                : intelligenceQuery.data?.maturityLadder
            }
            errored={intelligenceQuery.isError}
            onRetry={() => void intelligenceQuery.refetch()}
          />
        </Panel>
      </div>
    );
  }

  if (section === 'ecosystem') {
    return (
      <div className="pe-fb-section-grid">
        <Panel wide>
          <PeContractorsPanelVNext
            contractors={
              contractorsQuery.isError ? undefined : contractorsQuery.data
            }
            loading={contractorsQuery.isLoading}
            errored={contractorsQuery.isError}
            onRetry={() => void contractorsQuery.refetch()}
          />
        </Panel>
        <Panel
          wide
          title="Incumbents"
          sub="performer → award → budget evidence"
        >
          <PeIncumbentMapPanelVNext
            incumbents={
              incumbentsQuery.isError ? undefined : incumbentsQuery.data
            }
            loading={incumbentsQuery.isLoading}
            errored={incumbentsQuery.isError}
            onRetry={() => void incumbentsQuery.refetch()}
          />
        </Panel>
        <Panel wide>
          <PeProgramTeamPanelVNext
            personnel={peopleQuery.isError ? [] : people}
            loading={peopleQuery.isLoading}
            errored={peopleQuery.isError}
            onRetry={() => void peopleQuery.refetch()}
            onViewAllSources={() => navigate('/directory')}
            onLinkCrmContact={(personId) => {
              const person = people.find((candidate) => candidate.id === personId);
              setLinkTarget({
                id: personId,
                name: person?.fullName ?? 'this person',
              });
            }}
          />
        </Panel>
        <Panel wide>
          <PeAppropriabilityPanelVNext
            approp={
              intelligenceQuery.isError
                ? undefined
                : intelligenceQuery.data?.appropriability
            }
            errored={intelligenceQuery.isError}
            onRetry={() => void intelligenceQuery.refetch()}
          />
        </Panel>
      </div>
    );
  }

  if (section === 'sources') {
    return (
      <div className="pe-fb-stack">
        <Panel>
          <PeClientRelevancePanelVNext
            clients={clientsQuery.isError ? undefined : clientsQuery.data}
            loading={clientsQuery.isLoading}
            errored={clientsQuery.isError}
            onRetry={() => void clientsQuery.refetch()}
          />
        </Panel>
        <Panel>
          <PeProofPackPanelVNext
            sources={sourcesQuery.isError ? undefined : sourcesQuery.data}
            loading={sourcesQuery.isLoading}
            errored={sourcesQuery.isError}
            onRetry={() => void sourcesQuery.refetch()}
          />
        </Panel>
        <Panel>
          <PeWhatChangedPanelVNext
            deltas={deltasQuery.isError ? undefined : deltasQuery.data?.data}
            loading={deltasQuery.isLoading}
            errored={deltasQuery.isError}
            onRetry={() => void deltasQuery.refetch()}
          />
        </Panel>
      </div>
    );
  }

  return null;
}

function Panel({
  title,
  sub,
  wide,
  children,
}: {
  title?: string;
  sub?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`pe-fb-panel${wide ? ' wide' : ''}`}>
      {title ? (
        <div className="pe-fb-panel-head">
          <h3>{title}</h3>
          {sub ? <small>{sub}</small> : null}
        </div>
      ) : null}
      <div className={title ? 'pe-fb-panel-body' : ''}>{children}</div>
    </section>
  );
}
