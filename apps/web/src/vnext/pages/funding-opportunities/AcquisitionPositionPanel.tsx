import type { ReactNode } from 'react';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import {
  ACQUISITION_POSITION_LABELS,
  type AcquisitionPosition,
  type AcquisitionPositionState,
  type AcquisitionVehicleEvidence,
  type FundingOpportunity,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { FovCard, FovDisclosure, FovPill } from './fov-ui.js';

/**
 * Acquisition position (P23) — vNext port of the canonical panel.
 *
 * The one rule every line of copy follows is unchanged: NEVER a word from
 * `ELIGIBILITY_LABELS` and NEVER a probability. `related_entity_access` and
 * `known_teaming_route` are shown with real weight but NEVER with the same
 * colour as `direct_prime_access`, so a reader cannot mistake "your parent can
 * bid" for "you can bid".
 */

const STATE_COLORS: Record<AcquisitionPositionState, string> = {
  direct_prime_access: 'green',
  related_entity_access: 'blue',
  known_teaming_route: 'blue',
  vehicle_not_identified: 'default',
  no_direct_access_evidence: 'default',
  unknown: 'default',
};

const RELATIONSHIP_LABELS: Record<string, string> = {
  self: 'Self (direct)',
  parent: 'Related entity',
  teaming: 'Teaming partner',
};

function money(value: number | null): string {
  if (value == null) return 'Not stated';
  return `$${value.toLocaleString()}`;
}

function EvidenceTable({ evidence }: { evidence: AcquisitionVehicleEvidence[] }) {
  return (
    <CapiroTableWrap>
      <CapiroTable>
        <CapiroTableHead>
          <tr>
            <CapiroTableHeaderCell>Vehicle</CapiroTableHeaderCell>
            <CapiroTableHeaderCell>Route</CapiroTableHeaderCell>
            <CapiroTableHeaderCell>Held by</CapiroTableHeaderCell>
            <CapiroTableHeaderCell>Last date to order</CapiroTableHeaderCell>
            <CapiroTableHeaderCell>Order count</CapiroTableHeaderCell>
            <CapiroTableHeaderCell>IDV obligations</CapiroTableHeaderCell>
          </tr>
        </CapiroTableHead>
        <CapiroTableBody>
          {evidence.map((row) => (
            <tr key={`${row.tangoVehicleId}:${row.relationship}`}>
              <CapiroTableCell>{row.vehicleName ?? row.tangoVehicleId}</CapiroTableCell>
              <CapiroTableCell>
                <FovPill>{RELATIONSHIP_LABELS[row.relationship] ?? row.relationship}</FovPill>
              </CapiroTableCell>
              <CapiroTableCell>{row.recipientUei}</CapiroTableCell>
              <CapiroTableCell>
                {row.lastDateToOrder ? (
                  <span
                    className={row.expired ? 'fov-danger-text' : undefined}
                    title={row.expired ? 'Past this date' : 'Still open'}
                  >
                    {new Date(row.lastDateToOrder).toLocaleDateString()}
                  </span>
                ) : (
                  <span className="fov-muted">Not stated</span>
                )}
              </CapiroTableCell>
              <CapiroTableCell>{row.orderCount ?? '—'}</CapiroTableCell>
              <CapiroTableCell>{money(row.idvObligations)}</CapiroTableCell>
            </tr>
          ))}
        </CapiroTableBody>
      </CapiroTable>
    </CapiroTableWrap>
  );
}

function Populated({ position }: { position: AcquisitionPosition }) {
  return (
    <div className="fov-stack fov-stack--8">
      <span className="fov-row">
        <FovPill tone={STATE_COLORS[position.state]} testId="acquisition-position-state">
          {ACQUISITION_POSITION_LABELS[position.state]}
        </FovPill>
        {position.freshness.neverSynced ? (
          <FovPill title="The vehicle sync has not completed a run yet.">Never synced</FovPill>
        ) : position.freshness.lastSyncedAt ? (
          <FovPill title={new Date(position.freshness.lastSyncedAt).toLocaleString()}>
            Synced {new Date(position.freshness.lastSyncedAt).toLocaleDateString()}
          </FovPill>
        ) : null}
      </span>
      <div>
        <span className="fov-fact__label">Summary</span>
        <div>{position.summary}</div>
      </div>
      <div>
        <span className="fov-fact__label">Recommended route</span>
        <div>{position.recommendedRoute}</div>
      </div>
      {position.evidence.length > 0 ? (
        <FovDisclosure summary={<span className="fov-micro">Evidence ({position.evidence.length})</span>}>
          <EvidenceTable evidence={position.evidence} />
        </FovDisclosure>
      ) : null}
      <span className="fov-micro">
        Source: MakeGov/Tango. Not legal eligibility and not a probability of winning.
      </span>
    </div>
  );
}

export function AcquisitionPositionPanel({ opportunity: o }: { opportunity: FundingOpportunity }) {
  const unscored = o.clientId == null;

  let body: ReactNode;
  if (o.acquisitionPosition) {
    body = <Populated position={o.acquisitionPosition} />;
  } else if (unscored) {
    body = (
      <span className="fov-muted">
        Not calculated without a client. Acquisition position is a fact about a client-opportunity
        pair, not about the notice.
      </span>
    );
  } else if (o.source === 'grants_gov') {
    body = <span className="fov-muted">Not provided. A grant carries no contract-vehicle concept.</span>;
  } else {
    body = <span className="fov-muted">Not yet available for this workspace.</span>;
  }

  return (
    <FovCard title="Acquisition position" testId="fo-detail-acquisition">
      {body}
    </FovCard>
  );
}
