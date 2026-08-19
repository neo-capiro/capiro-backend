/**
 * Top contractors — native vNext port of
 * `pages/program-element/ContractorsPanel.tsx` (re-skin: identical props,
 * copy, ordering, empty/error states; antd Table → CapiroTable family).
 */
import { useMemo } from 'react';
import type {
  ProgramElementContractor,
  ProgramElementContractorsResponse,
  ProgramElementNamedPrime,
} from '../../../../pages/program-element/types.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../../components/tables/index.js';
import {
  PeFbEmpty,
  PeFbPanel,
  PeFbSecondaryFailed,
  PeFbSkeleton,
  PeFbTag,
} from './pe-fallback-ui.js';

export interface ContractorsPanelVNextProps {
  contractors: ProgramElementContractorsResponse | null | undefined;
  loading?: boolean;
  errored?: boolean;
  onRetry?: () => void;
}

function dollarsCompact(amountMm: number): string {
  if (amountMm >= 1000) {
    return `$${(amountMm / 1000).toFixed(1)}B`;
  }
  return `$${amountMm.toFixed(1)}M`;
}

export function PeContractorsPanelVNext({
  contractors,
  loading = false,
  errored = false,
  onRetry,
}: ContractorsPanelVNextProps) {
  // Canonical antd column: defaultSortOrder 'descend' on $ obligated.
  const namedPrimes = useMemo(
    () =>
      [...(contractors?.namedPrimes ?? [])].sort(
        (a, b) => (b.totalCostM ?? -1) - (a.totalCostM ?? -1),
      ),
    [contractors?.namedPrimes],
  );
  const rows = useMemo(
    () => [...(contractors?.data ?? [])].sort((a, b) => b.amount - a.amount),
    [contractors?.data],
  );

  if (loading) {
    return (
      <PeFbPanel title="Top contractors touching this PE">
        <PeFbSkeleton rows={4} />
      </PeFbPanel>
    );
  }

  if (errored) {
    return (
      <PeFbSecondaryFailed label="contractors" testId="pe-secondary-failed-contractors" onRetry={onRetry} />
    );
  }

  if (namedPrimes.length === 0 && rows.length === 0) {
    return (
      <PeFbPanel className="pe-fb-contractors-card" title="Top contractors touching this PE">
        <PeFbEmpty
          description={
            contractors?.todo ??
            'No contractors linked to this program element yet. Capiro links awards by DoD acquisition program; programs without a contract-level program code (services, support) will not appear here.'
          }
        />
      </PeFbPanel>
    );
  }

  const top10 = rows.slice(0, 10);
  const hasProgramLinked = top10.some((r) => r.source === 'program');

  return (
    <PeFbPanel className="pe-fb-contractors-card" title="Top contractors touching this PE">
      {contractors?.todo ? (
        <span className="pe-fb-muted" style={{ display: 'block', marginBottom: 8 }}>
          {contractors.todo}
        </span>
      ) : null}

      {namedPrimes.length > 0 ? (
        <div style={{ marginBottom: rows.length > 0 ? 20 : 0 }}>
          <strong style={{ display: 'block', marginBottom: 4 }}>
            Named primes (per Service budget exhibit)
          </strong>
          <span className="pe-fb-muted" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
            Companies the Service names as the performing activity for this program element in
            its R-3 “Product Development” exhibit — a direct, document-level attribution.
          </span>
          <CapiroTableWrap className="pe-fb-scroll">
            <CapiroTable>
              <CapiroTableHead>
                <tr>
                  <CapiroTableHeaderCell>Prime</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Location</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell style={{ textAlign: 'right' }}>Stated value</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell style={{ textAlign: 'right' }}>Source</CapiroTableHeaderCell>
                </tr>
              </CapiroTableHead>
              <CapiroTableBody>
                {namedPrimes.map((row: ProgramElementNamedPrime) => {
                  const label = `${row.publisher ?? 'DoD'}${row.fy ? ` FY${row.fy}` : ''} R-3${
                    row.pageNumber ? ` p.${row.pageNumber}` : ''
                  }`;
                  const tag = (
                    <PeFbTag color="green" title={row.attribution ?? undefined}>
                      {label}
                    </PeFbTag>
                  );
                  return (
                    <tr key={`${row.contractorName}-${row.fy ?? ''}-${row.pageNumber ?? ''}`}>
                      <CapiroTableCell>
                        {row.contractorName}
                        {row.contractMethod ? (
                          <PeFbTag
                            color="purple"
                            style={{ marginLeft: 6 }}
                            title="Contract method per the R-3 exhibit"
                          >
                            {row.contractMethod}
                          </PeFbTag>
                        ) : null}
                      </CapiroTableCell>
                      <CapiroTableCell>{row.location ?? '—'}</CapiroTableCell>
                      <CapiroTableCell style={{ textAlign: 'right' }}>
                        {typeof row.totalCostM === 'number' ? dollarsCompact(row.totalCostM) : '—'}
                      </CapiroTableCell>
                      <CapiroTableCell style={{ textAlign: 'right' }}>
                        {row.sourceUrl ? (
                          <a
                            href={row.pageNumber ? `${row.sourceUrl}#page=${row.pageNumber}` : row.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {tag}
                          </a>
                        ) : (
                          tag
                        )}
                      </CapiroTableCell>
                    </tr>
                  );
                })}
              </CapiroTableBody>
            </CapiroTable>
          </CapiroTableWrap>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <>
          {namedPrimes.length > 0 ? (
            <strong style={{ display: 'block', marginBottom: 8 }}>
              Award dollar flow (USAspending, last 24 months)
            </strong>
          ) : null}
          <CapiroTableWrap className="pe-fb-scroll">
            <CapiroTable>
              <CapiroTableHead>
                <tr>
                  <CapiroTableHeaderCell>Contractor</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell style={{ textAlign: 'right' }}>$ obligated (24 mo)</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell style={{ textAlign: 'right' }}>Awards</CapiroTableHeaderCell>
                </tr>
              </CapiroTableHead>
              <CapiroTableBody>
                {top10.map((row: ProgramElementContractor) => (
                  <tr
                    key={row.contractorName}
                    className={
                      row.isNewEntrant
                        ? 'pe-fb-contractor-row-warning'
                        : row.contractorIsCrmClient
                          ? 'pe-fb-contractor-row-crm'
                          : undefined
                    }
                  >
                    <CapiroTableCell>
                      {row.contractorName}{' '}
                      {row.contractorIsCrmClient ? <PeFbTag color="blue">CRM Client</PeFbTag> : null}
                      {row.isNewEntrant ? <PeFbTag color="warning">New</PeFbTag> : null}
                      {row.source === 'program' ? (
                        <PeFbTag
                          color="geekblue"
                          title={row.attribution ?? 'Linked via DoD Acquisition Program (USAspending)'}
                        >
                          via Acq Program
                        </PeFbTag>
                      ) : null}
                    </CapiroTableCell>
                    <CapiroTableCell style={{ textAlign: 'right' }}>
                      {dollarsCompact(row.amount)}
                    </CapiroTableCell>
                    <CapiroTableCell style={{ textAlign: 'right' }}>
                      {typeof row.awards === 'number' ? row.awards.toLocaleString() : '—'}
                    </CapiroTableCell>
                  </tr>
                ))}
              </CapiroTableBody>
            </CapiroTable>
          </CapiroTableWrap>
          {hasProgramLinked ? (
            <span className="pe-fb-muted" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
              Rows tagged “via Acq Program” are linked through the contract’s DoD acquisition
              program code (USAspending), not a direct program-element attribution.
            </span>
          ) : null}
        </>
      ) : null}
    </PeFbPanel>
  );
}
