import { Button, Drawer, Space, Tag, Tooltip, Typography, message } from 'antd';
import { CopyOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { useMemo, useState } from 'react';
import type { FundingClaim } from '@capiro/shared/funding-claim';
import { buildFundingClaim } from '@capiro/shared/funding-claim';
import {
  buildSourceCoverageSummary,
  deriveTrustCycleFromYears,
  formatClaimWithCitation,
} from './trust-model.js';
import type { ProgramElementYearPoint } from './types.js';

const { Text } = Typography;

export interface PeTrustHeaderProps {
  peCode: string;
  title: string;
  years: ProgramElementYearPoint[];
  /** Catalog-wide mode-request FY (informational; may differ from PE mark cycle). */
  catalogCurrentCycleFy?: number | null;
  lastSyncedAt?: string | null;
  sourceCount?: number | null;
  projectCount?: number | null;
  billCount?: number | null;
  description?: string | null;
  /** Open reconciliation conflicts known for this PE (admin-scale; usually 0). */
  reconciliationConflictCount?: number | null;
  /** Caveats the operator should read before quoting (coverage, historical, etc.). */
  extraCaveats?: string[];
  className?: string;
}

function formatVerified(value: string | null | undefined): string {
  if (!value) return 'not recorded';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/** Prefer furthest-along claim on the PE mark-bearing cycle for copy. */
function pickHeadlineClaim(
  years: ProgramElementYearPoint[],
  peCycleFy: number | null,
): FundingClaim | null {
  if (peCycleFy == null) return null;
  const y = years.find((row) => row.fy === peCycleFy);
  if (!y) return null;
  const n = (v: string | number | null | undefined): number | null => {
    if (v == null) return null;
    const num = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(num) ? num : null;
  };
  const order: Array<{
    stage: Parameters<typeof buildFundingClaim>[0]['stage'];
    value: number | null;
  }> = [
    { stage: 'enacted', value: n(y.enacted) },
    { stage: 'appropriations_conference', value: n(y.conference) },
    { stage: 'sacd', value: n(y.sacDMark) },
    { stage: 'hacd', value: n(y.hacDMark) },
    { stage: 'ndaa_conference', value: n(y.ndaaConference) },
    { stage: 'sasc', value: n(y.sascMark) },
    { stage: 'hasc', value: n(y.hascMark) },
    { stage: 'request', value: n(y.request) },
  ];
  for (const step of order) {
    if (step.value != null) {
      return buildFundingClaim({
        value: step.value,
        fiscalYear: peCycleFy,
        stage: step.stage,
        currentCycleFy: peCycleFy,
      });
    }
  }
  return null;
}

/**
 * Trust strip: current FY / stage / vehicle / verification time / coverage /
 * reconciliation conflicts, plus a caveats drawer and copy-with-citation.
 */
export function PeTrustHeader({
  peCode,
  title,
  years,
  catalogCurrentCycleFy = null,
  lastSyncedAt = null,
  sourceCount = null,
  projectCount = null,
  billCount = null,
  description = null,
  reconciliationConflictCount = null,
  extraCaveats = [],
  className,
}: PeTrustHeaderProps) {
  const [caveatsOpen, setCaveatsOpen] = useState(false);
  const cycle = useMemo(() => deriveTrustCycleFromYears(years), [years]);
  const coverage = useMemo(
    () =>
      buildSourceCoverageSummary({
        yearCount: years.length,
        sourceCount,
        projectCount,
        billCount,
        hasDescription: description != null && description.trim().length > 0,
      }),
    [years.length, sourceCount, projectCount, billCount, description],
  );

  const headline = useMemo(() => pickHeadlineClaim(years, cycle.currentFy), [years, cycle.currentFy]);

  const conflictN = reconciliationConflictCount ?? 0;

  const caveats = useMemo(() => {
    const list: string[] = [...extraCaveats];
    list.push(
      'Dollar figures are USD millions unless labeled otherwise. A recorded zero is a real value, not missing data.',
    );
    list.push(
      'Authorization-track marks (HASC/SASC/NDAA conference) never replace appropriations-track figures, and the two tracks are not mixed in percent deltas.',
    );
    list.push(
      'FYDP outyears are projections and must not be quoted as the current-cycle request.',
    );
    if (catalogCurrentCycleFy != null && cycle.currentFy != null && catalogCurrentCycleFy !== cycle.currentFy) {
      list.push(
        `Catalog mode-request FY is FY${catalogCurrentCycleFy}; this PE's mark-bearing cycle is FY${cycle.currentFy}. Prefer the PE cycle when quoting this line.`,
      );
    }
    if (years.length === 0) {
      list.push('No program_element_year rows are ingested for this PE yet.');
    }
    if (conflictN > 0) {
      list.push(
        `${conflictN} open cross-source reconciliation conflict${conflictN === 1 ? '' : 's'} — resolve before treating conflicting fields as final.`,
      );
    }
    if ((sourceCount ?? 0) === 0) {
      list.push('No page-level source citations are registered in the proof pack for this PE.');
    }
    return list;
  }, [extraCaveats, catalogCurrentCycleFy, cycle.currentFy, years.length, conflictN, sourceCount]);

  const onCopy = async () => {
    if (!headline) {
      message.warning('No current-cycle dollar claim is available to copy.');
      return;
    }
    const citation = lastSyncedAt
      ? `last verified ${formatVerified(lastSyncedAt)}; PE ${peCode} watch surface`
      : `PE ${peCode} watch surface; verification time not recorded`;
    const text = formatClaimWithCitation({ peCode, title, claim: headline, citation });
    if (!text) {
      message.warning('Claim is incomplete and was not copied.');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      message.success('Claim copied with citation');
    } catch {
      message.error('Clipboard unavailable — select and copy manually.');
    }
  };

  return (
    <div className={className ? `pe-trust-header ${className}` : 'pe-trust-header'} data-testid="pe-trust-header">
      <div className="pe-trust-row">
        <span className="pe-trust-item" data-testid="pe-trust-fy">
          <span className="pe-trust-k">Current FY</span>
          <span className="pe-trust-v">{cycle.currentFy != null ? `FY${cycle.currentFy}` : '—'}</span>
        </span>
        <span className="pe-trust-item" data-testid="pe-trust-stage">
          <span className="pe-trust-k">Stage</span>
          <span className="pe-trust-v">{cycle.stageLabel ?? '—'}</span>
        </span>
        <span className="pe-trust-item" data-testid="pe-trust-vehicle">
          <span className="pe-trust-k">Vehicle</span>
          <span className="pe-trust-v">{cycle.vehicleLabel ?? '—'}</span>
        </span>
        <span className="pe-trust-item" data-testid="pe-trust-verified">
          <span className="pe-trust-k">Verified</span>
          <span className="pe-trust-v">{formatVerified(lastSyncedAt)}</span>
        </span>
        <span className="pe-trust-item" data-testid="pe-trust-coverage">
          <span className="pe-trust-k">Coverage</span>
          <span className="pe-trust-v pe-trust-coverage-chips">
            {coverage.map((c) => (
              <Tag key={c} className="pe-trust-chip">
                {c}
              </Tag>
            ))}
          </span>
        </span>
        <span className="pe-trust-item" data-testid="pe-trust-conflicts">
          <span className="pe-trust-k">Reconciliation</span>
          <span className="pe-trust-v">
            {conflictN > 0 ? (
              <Tag color="volcano">{conflictN} open conflict{conflictN === 1 ? '' : 's'}</Tag>
            ) : (
              <Tag color="default">no open conflicts reported</Tag>
            )}
          </span>
        </span>
      </div>
      <div className="pe-trust-actions">
        <Tooltip title="Coverage gaps, track separation, and quotation rules">
          <Button
            size="small"
            type="link"
            icon={<InfoCircleOutlined />}
            onClick={() => setCaveatsOpen(true)}
            data-testid="pe-trust-caveats-open"
          >
            Coverage & caveats
          </Button>
        </Tooltip>
        <Button
          size="small"
          type="link"
          icon={<CopyOutlined />}
          onClick={() => void onCopy()}
          data-testid="pe-trust-copy-claim"
          disabled={!headline}
        >
          Copy claim with citation
        </Button>
      </div>

      <Drawer
        title="Coverage & caveats"
        placement="right"
        width={420}
        open={caveatsOpen}
        onClose={() => setCaveatsOpen(false)}
        destroyOnClose
        className="pe-trust-caveats-drawer"
        data-testid="pe-trust-caveats-drawer"
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Text type="secondary">
            Read these before quoting dollars or stage labels out of Capiro. Fail-closed: missing
            coverage is disclosed, never invented.
          </Text>
          <ul className="pe-trust-caveat-list">
            {caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </Space>
      </Drawer>
    </div>
  );
}

export default PeTrustHeader;
