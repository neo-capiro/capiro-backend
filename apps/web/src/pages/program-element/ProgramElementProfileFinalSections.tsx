import { FyHistoryChart } from './FyHistoryChart.js';
import { FundingNarrativePanel } from './FundingNarrativePanel.js';
import { BillsTouchingPePanel } from './BillsTouchingPePanel.js';
import { ContractorsPanel } from './ContractorsPanel.js';
import { ProofPackPanel } from './ProofPackPanel.js';
import { WhatChangedPanel } from './WhatChangedPanel.js';
import { ProgramsPanel } from './ProgramsPanel.js';
import { ClientRelevancePanel } from './ClientRelevancePanel.js';
import { ProgramTeamPanel } from './ProgramTeamPanel.js';
import { ProjectsPanel } from './ProjectsPanel.js';
import { ProvisionsPanel } from './ProvisionsPanel.js';
import { ProcurementActivityPanel } from './ProcurementActivityPanel.js';
import { RelatedPesPanel } from './RelatedPesPanel.js';
import { SecondaryDistributionPanel } from './SecondaryDistributionPanel.js';
import { PdocDetailPanel } from './PdocDetailPanel.js';
import {
  AppropriabilityPanel,
  BudgetActionsFeed,
  IncumbentMapPanel,
  MaturityLadderPanel,
  RelationshipGraphPanel,
} from './BudgetLinePanels.js';
import {
  toProgramElementHistoryRows,
  type ProgramElementProfileFinalVm,
} from './useProgramElementProfileFinal.js';

export function ProgramElementProfileFinalSections({
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
      <div className="pe-final-stack">
        <Panel>
          <FyHistoryChart
            rows={toProgramElementHistoryRows(detail.years ?? [])}
            loading={false}
          />
        </Panel>
        <Panel>
          <WhatChangedPanel
            deltas={deltasQuery.isError ? undefined : deltasQuery.data?.data}
            loading={deltasQuery.isLoading}
            errored={deltasQuery.isError}
            onRetry={() => void deltasQuery.refetch()}
          />
        </Panel>
        <Panel>
          <FundingNarrativePanel
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
      <div className="pe-final-stack">
        <Panel>
          <BillsTouchingPePanel
            bills={billsWithActions}
            loading={billsQuery.isLoading || billActionsQuery.isLoading}
            errored={billsQuery.isError}
            onRetry={() => void billsQuery.refetch()}
            billActionsErrored={billActionsQuery.isError}
            onRetryBillActions={() => void billActionsQuery.refetch()}
          />
        </Panel>
        <Panel title="Budget actions" sub="normalized committee events">
          <BudgetActionsFeed
            actions={budgetActionsQuery.isError ? undefined : budgetActionsQuery.data}
            loading={budgetActionsQuery.isLoading}
            errored={budgetActionsQuery.isError}
            onRetry={() => void budgetActionsQuery.refetch()}
          />
        </Panel>
        <Panel>
          <ProvisionsPanel
            provisions={provisionsQuery.isError ? undefined : provisionsQuery.data}
            loading={provisionsQuery.isLoading}
            errored={provisionsQuery.isError}
            onRetry={() => void provisionsQuery.refetch()}
          />
        </Panel>
        <Panel>
          <ProcurementActivityPanel
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
      <div className="pe-final-section-grid">
        <Panel wide>
          <ProjectsPanel
            projects={projectsQuery.isError ? undefined : projectsQuery.data}
            loading={projectsQuery.isLoading}
            errored={projectsQuery.isError}
            onRetry={() => void projectsQuery.refetch()}
          />
        </Panel>
        <Panel wide>
          <SecondaryDistributionPanel
            data={procurementQuery.isError ? undefined : procurementQuery.data}
            loading={procurementQuery.isLoading}
            errored={procurementQuery.isError}
            onRetry={() => void procurementQuery.refetch()}
          />
        </Panel>
        {pdoc ? (
          <Panel wide>
            <PdocDetailPanel
              detail={pdoc}
              onOpenPe={(target) => navigate(`/program-elements/${target}`)}
            />
          </Panel>
        ) : null}
        <Panel>
          <ProgramsPanel
            programs={programsQuery.isError ? undefined : programsQuery.data}
            loading={programsQuery.isLoading}
            errored={programsQuery.isError}
            onRetry={() => void programsQuery.refetch()}
          />
        </Panel>
        <Panel>
          <RelatedPesPanel
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
          <RelationshipGraphPanel
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
          <MaturityLadderPanel
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
      <div className="pe-final-section-grid">
        <Panel wide>
          <ContractorsPanel
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
          <IncumbentMapPanel
            incumbents={
              incumbentsQuery.isError ? undefined : incumbentsQuery.data
            }
            loading={incumbentsQuery.isLoading}
            errored={incumbentsQuery.isError}
            onRetry={() => void incumbentsQuery.refetch()}
          />
        </Panel>
        <Panel wide>
          <ProgramTeamPanel
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
          <AppropriabilityPanel
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
      <div className="pe-final-stack">
        <Panel>
          <ClientRelevancePanel
            clients={clientsQuery.isError ? undefined : clientsQuery.data}
            loading={clientsQuery.isLoading}
            errored={clientsQuery.isError}
            onRetry={() => void clientsQuery.refetch()}
          />
        </Panel>
        <Panel>
          <ProofPackPanel
            sources={sourcesQuery.isError ? undefined : sourcesQuery.data}
            loading={sourcesQuery.isLoading}
            errored={sourcesQuery.isError}
            onRetry={() => void sourcesQuery.refetch()}
          />
        </Panel>
        <Panel>
          <WhatChangedPanel
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
    <section className={`pe-final-panel${wide ? ' wide' : ''}`}>
      {title ? (
        <div className="pe-final-panel-head">
          <h2>{title}</h2>
          {sub ? <small>{sub}</small> : null}
        </div>
      ) : null}
      <div className={title ? 'pe-final-panel-body' : ''}>{children}</div>
    </section>
  );
}
