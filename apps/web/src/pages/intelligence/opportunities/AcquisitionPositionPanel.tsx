import { Card, Collapse, Space, Table, Tag, Tooltip, Typography } from 'antd';
import {
  ACQUISITION_POSITION_LABELS,
  type AcquisitionPosition,
  type AcquisitionPositionState,
  type AcquisitionVehicleEvidence,
  type FundingOpportunity,
} from './funding-opportunities-api.js';

const { Text } = Typography;

/**
 * Acquisition position (P23): whether this client has a CREDIBLE PATH to the
 * acquisition. Full detail-page panel; OpportunityCard.tsx carries the
 * concise badge version of the same facts.
 *
 * ── The one rule every line of copy in this file follows ────────────────────
 *
 * NEVER a word from `ELIGIBILITY_LABELS` (eligible/ineligible/needs review)
 * and NEVER a probability ("likely to win", a percentage, a star rating).
 * Acquisition position answers a THIRD question — not "is this your kind of
 * work" (relevance), not "may you apply" (eligibility), not "how confident
 * is the evidence" (recommendationConfidence) — and blending it into any of
 * those would recreate the exact failure decision-log D-05 exists to name.
 *
 * `related_entity_access` and `known_teaming_route` are real, credible
 * routes and are shown with real weight — but NEVER with the same color or
 * icon as `direct_prime_access`, so a reader cannot mistake "your parent can
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
    <Table
      size="small"
      pagination={false}
      rowKey={(row) => `${row.tangoVehicleId}:${row.relationship}`}
      dataSource={evidence}
      columns={[
        {
          title: 'Vehicle',
          dataIndex: 'vehicleName',
          render: (name: string | null, row) => name ?? row.tangoVehicleId,
        },
        {
          title: 'Route',
          dataIndex: 'relationship',
          render: (rel: string) => <Tag>{RELATIONSHIP_LABELS[rel] ?? rel}</Tag>,
        },
        { title: 'Held by', dataIndex: 'recipientUei' },
        {
          title: 'Last date to order',
          dataIndex: 'lastDateToOrder',
          render: (d: string | null, row) =>
            d ? (
              <Tooltip title={row.expired ? 'Past this date' : 'Still open'}>
                <Text type={row.expired ? 'danger' : undefined}>{new Date(d).toLocaleDateString()}</Text>
              </Tooltip>
            ) : (
              <Text type="secondary">Not stated</Text>
            ),
        },
        {
          title: 'Order count',
          dataIndex: 'orderCount',
          render: (n: number | null) => n ?? '—',
        },
        {
          title: 'IDV obligations',
          dataIndex: 'idvObligations',
          render: (n: number | null) => money(n),
        },
      ]}
    />
  );
}

function Populated({ position }: { position: AcquisitionPosition }) {
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space size={6} wrap>
        <Tag color={STATE_COLORS[position.state]} data-testid="acquisition-position-state">
          {ACQUISITION_POSITION_LABELS[position.state]}
        </Tag>
        {position.freshness.neverSynced ? (
          <Tooltip title="The vehicle sync has not completed a run yet.">
            <Tag>Never synced</Tag>
          </Tooltip>
        ) : position.freshness.lastSyncedAt ? (
          <Tooltip title={new Date(position.freshness.lastSyncedAt).toLocaleString()}>
            <Tag>Synced {new Date(position.freshness.lastSyncedAt).toLocaleDateString()}</Tag>
          </Tooltip>
        ) : null}
      </Space>
      <div>
        <Text type="secondary" className="fo-fact__label">
          Summary
        </Text>
        <div>
          <Text>{position.summary}</Text>
        </div>
      </div>
      <div>
        <Text type="secondary" className="fo-fact__label">
          Recommended route
        </Text>
        <div>
          <Text>{position.recommendedRoute}</Text>
        </div>
      </div>
      {position.evidence.length > 0 ? (
        <Collapse
          ghost
          size="small"
          items={[
            {
              key: 'evidence',
              label: (
                <Text type="secondary" style={{ fontSize: 11 }}>
                  Evidence ({position.evidence.length})
                </Text>
              ),
              children: <EvidenceTable evidence={position.evidence} />,
            },
          ]}
        />
      ) : null}
      <Text type="secondary" style={{ fontSize: 11 }}>
        Source: MakeGov/Tango. Not legal eligibility and not a probability of winning.
      </Text>
    </Space>
  );
}

export function AcquisitionPositionPanel({ opportunity: o }: { opportunity: FundingOpportunity }) {
  const unscored = o.clientId == null;

  let body: React.ReactNode;
  if (o.acquisitionPosition) {
    body = <Populated position={o.acquisitionPosition} />;
  } else if (unscored) {
    body = (
      <Text type="secondary" style={{ fontSize: 12 }}>
        Not calculated without a client. Acquisition position is a fact about a client-opportunity pair, not about
        the notice.
      </Text>
    );
  } else if (o.source === 'grants_gov') {
    body = (
      <Text type="secondary" style={{ fontSize: 12 }}>
        Not provided. A grant carries no contract-vehicle concept.
      </Text>
    );
  } else {
    body = (
      <Text type="secondary" style={{ fontSize: 12 }}>
        Not yet available for this workspace.
      </Text>
    );
  }

  return (
    <Card size="small" title="Acquisition position" className="fo-detail__section" data-testid="fo-detail-acquisition">
      {body}
    </Card>
  );
}
