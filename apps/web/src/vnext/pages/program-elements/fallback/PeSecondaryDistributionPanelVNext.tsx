/**
 * P-40 Secondary Distribution — native vNext port of
 * `pages/program-element/SecondaryDistributionPanel.tsx`. Per-recipient
 * quantity + obligation authority across fiscal years; toggle between quantity
 * and dollars. Honest empty state for PEs with no procurement lines.
 */
import { useState } from 'react';
import type {
  ProcurementLineRecipient,
  ProcurementLinesResponse,
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
} from './pe-fallback-ui.js';

export interface SecondaryDistributionPanelVNextProps {
  data: ProcurementLinesResponse | null | undefined;
  loading?: boolean;
  /** Request failed — must not paint honesty Empty. */
  errored?: boolean;
  onRetry?: () => void;
}

/** Compact USD: $1.59M / $2.04B from a full-dollar value. */
export function fmtDollars(v: number | null): string {
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

export function fmtQty(v: number | null): string {
  if (v == null) return '—';
  return v.toLocaleString('en-US');
}

interface RecipientRow {
  key: string;
  recipient: string;
  byFy: Record<number, { quantity: number | null; dollars: number | null }>;
}

export function PeSecondaryDistributionPanelVNext({
  data,
  loading = false,
  errored = false,
  onRetry,
}: SecondaryDistributionPanelVNextProps) {
  const [metric, setMetric] = useState<'quantity' | 'dollars'>('dollars');

  if (loading) {
    return (
      <PeFbPanel title="Secondary Distribution">
        <PeFbSkeleton rows={3} />
      </PeFbPanel>
    );
  }

  if (errored) {
    return (
      <PeFbPanel className="pe-fb-sd-card" title="Secondary Distribution">
        <PeFbSecondaryFailed
          label="secondary distribution"
          testId="pe-secondary-failed-procurement-lines"
          onRetry={onRetry}
        />
      </PeFbPanel>
    );
  }

  const recipients: ProcurementLineRecipient[] = data?.recipients ?? [];
  const years = data?.years ?? [];
  if (recipients.length === 0 || years.length === 0) {
    return (
      <PeFbPanel className="pe-fb-sd-card" title="Secondary Distribution">
        <PeFbEmpty description="No per-recipient procurement breakdown for this PE — it may be RDT&E, or its procurement book had no Secondary Distribution block." />
      </PeFbPanel>
    );
  }

  const rows: RecipientRow[] = recipients.map((r) => {
    const byFy: RecipientRow['byFy'] = {};
    for (const fr of r.fyRows) byFy[fr.fy] = { quantity: fr.quantity, dollars: fr.dollars };
    return { key: r.recipient, recipient: r.recipient, byFy };
  });

  const sourceHref = data?.sourceUrl ?? null;

  return (
    <PeFbPanel
      className="pe-fb-sd-card"
      title={`Secondary Distribution · ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}`}
      extra={
        <div className="pe-fb-segment" role="radiogroup" aria-label="Metric">
          {(
            [
              { label: 'Obligation $', value: 'dollars' },
              { label: 'Quantity', value: 'quantity' },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={metric === option.value}
              className={metric === option.value ? 'active' : ''}
              onClick={() => setMetric(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      }
    >
      <span className="pe-fb-muted" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
        Per-recipient {metric === 'dollars' ? 'obligation authority' : 'procurement quantity'} from
        the P-40 Secondary Distribution block, by fiscal year (request year + prior actuals + FYDP).
        {sourceHref ? (
          <>
            {' '}
            <a href={sourceHref} target="_blank" rel="noreferrer">
              Source (P-40)
            </a>
          </>
        ) : null}
      </span>
      <CapiroTableWrap className="pe-fb-scroll">
        <CapiroTable>
          <CapiroTableHead>
            <tr>
              <CapiroTableHeaderCell>Recipient</CapiroTableHeaderCell>
              {years.map((y) => (
                <CapiroTableHeaderCell key={`fy${y}`} style={{ textAlign: 'right' }}>
                  FY{String(y).slice(-2)}
                </CapiroTableHeaderCell>
              ))}
            </tr>
          </CapiroTableHead>
          <CapiroTableBody>
            {rows.map((row) => (
              <tr key={row.key}>
                <CapiroTableCell>
                  <strong>{row.recipient}</strong>
                </CapiroTableCell>
                {years.map((y) => {
                  const cell = row.byFy[y];
                  return (
                    <CapiroTableCell key={`fy${y}`} style={{ textAlign: 'right' }}>
                      {!cell ? (
                        <span className="pe-fb-muted">—</span>
                      ) : metric === 'dollars' ? (
                        fmtDollars(cell.dollars)
                      ) : (
                        fmtQty(cell.quantity)
                      )}
                    </CapiroTableCell>
                  );
                })}
              </tr>
            ))}
          </CapiroTableBody>
        </CapiroTable>
      </CapiroTableWrap>
    </PeFbPanel>
  );
}
