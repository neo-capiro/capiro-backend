/**
 * Phase 10B-35 -- "Reviewed partial records" page.
 *
 * Displays the first independently source-checked, individually
 * human-reviewed R-2 PE totals, explicitly labeled as a partial, single-
 * source collection -- never implying complete fiscal-year or family
 * coverage. Capiro-internal only (the API route 404s for any other tenant).
 *
 * Deliberately: no totals row, no ranking, no delta, no export that could
 * read as a complete-collection artifact -- this list is meant to be read
 * one row at a time, each with its own citation.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useMe } from '../../../../lib/me.js';
import { CapiroBadge } from '../../../components/badges/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../../components/feedback/index.js';
import { CapiroSelect } from '../../../components/fields/index.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../../components/tables/index.js';
import { listReviewedPartialPeTotals, type ReviewedPartialPeTotal } from './reviewed-partial-pe-totals-api.js';

const FISCAL_YEAR_OPTIONS = [2024, 2025, 2026, 2027, 2028].map((year) => ({ label: `FY${year}`, value: String(year) }));

function formatMillions(value: string | null): string {
  if (value == null) return '—';
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}M` : `$${value}M`;
}

function ReviewedPartialRow({ row }: { row: ReviewedPartialPeTotal }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <tr>
        <CapiroTableCell>
          <div style={{ fontWeight: 600 }}>{row.peCode}</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>{row.peTitle}</div>
        </CapiroTableCell>
        <CapiroTableCell>{row.component}</CapiroTableCell>
        <CapiroTableCell>{row.stageLabel}</CapiroTableCell>
        <CapiroTableCell style={{ textAlign: 'right' }}>{formatMillions(row.amountMillions.base)}</CapiroTableCell>
        <CapiroTableCell style={{ textAlign: 'right' }}>{formatMillions(row.amountMillions.oco)}</CapiroTableCell>
        <CapiroTableCell style={{ textAlign: 'right', fontWeight: 600 }}>{formatMillions(row.amountMillions.total)}</CapiroTableCell>
        <CapiroTableCell>
          <a href={row.source.sourceUrl ?? undefined} target="_blank" rel="noreferrer">
            {row.source.exhibit} · p.{row.source.physicalPage}
          </a>
        </CapiroTableCell>
        <CapiroTableCell>
          <CapiroBadge tone="warning">Reviewed · partial</CapiroBadge>
        </CapiroTableCell>
        <CapiroTableCell>
          <button type="button" onClick={() => setExpanded((v) => !v)} className="pe-ws-link-btn">
            {expanded ? 'Hide detail' : 'Show detail'}
          </button>
        </CapiroTableCell>
      </tr>
      {expanded ? (
        <tr>
          <CapiroTableCell colSpan={9}>
            <div style={{ padding: '8px 4px', fontSize: 13 }}>
              <div>
                <strong>Coverage limitations</strong>
              </div>
              <ul style={{ margin: '4px 0 12px 18px' }}>
                {row.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              <div>
                <strong>Review</strong>
              </div>
              <div>
                Reviewer: {row.review.reviewerId} · {new Date(row.review.reviewedAt).toLocaleString()}
              </div>
              <div>
                Policy: {row.review.policyId} v{row.review.policyVersion}
              </div>
              <div>Rationale: {row.review.rationale}</div>
              <div style={{ marginTop: 8 }}>
                <strong>Source identity</strong>
              </div>
              <div>Source document: {row.source.sourceDocumentId}</div>
              <div>Source PDF SHA-256: {row.source.sourceSha256}</div>
              <div>Artifact: {row.source.artifactId}</div>
            </div>
          </CapiroTableCell>
        </tr>
      ) : null}
    </>
  );
}

export function ReviewedPartialPeTotalsPage() {
  const api = useApi();
  const me = useMe();
  const isInternal = me.data?.tenant.slug === 'capiro-internal';
  const [fiscalYear, setFiscalYear] = useState(2024);

  const query = useQuery({
    queryKey: ['reviewed-partial-pe-totals', fiscalYear],
    queryFn: () => listReviewedPartialPeTotals(api, fiscalYear),
    enabled: isInternal,
    staleTime: 30_000,
  });

  if (!isInternal) {
    return <CapiroEmptyState variant="no-access" title="Not available" description="This view is limited to Capiro-internal accounts." />;
  }

  return (
    <div className="pe-ws-pad">
      <div className="pe-v2-page-title" style={{ fontSize: 20, marginBottom: 4 }}>
        Reviewed partial budget records
      </div>
      <p className="pe-ws-cap" style={{ maxWidth: 720, marginBottom: 16 }}>
        Individually reviewed source totals only. Each row was independently source-checked and
        approved for exactly the program element and fiscal year shown — this is not a complete
        fiscal-year or family collection, and missing programs or project-level detail are unknown,
        not zero. Values are not summed, ranked, or compared against other years here.
      </p>

      <div style={{ marginBottom: 16, maxWidth: 200 }}>
        <CapiroSelect
          label="Fiscal year"
          value={String(fiscalYear)}
          onChange={(e) => setFiscalYear(Number(e.target.value))}
          options={FISCAL_YEAR_OPTIONS}
        />
      </div>

      {query.isLoading ? <CapiroSkeleton height={240} /> : null}
      {query.isError ? <CapiroErrorState title="Could not load reviewed partial records" /> : null}
      {query.data && query.data.items.length === 0 ? (
        <CapiroEmptyState
          variant="no-data"
          title={`No reviewed partial records for FY${fiscalYear}`}
          description="No program elements have been independently reviewed and approved for bounded display in this fiscal year yet."
        />
      ) : null}
      {query.data && query.data.items.length > 0 ? (
        <>
          <div style={{ marginBottom: 8, fontSize: 13, opacity: 0.8 }}>{query.data.coverageNote}</div>
          <CapiroTableWrap>
            <CapiroTable>
              <CapiroTableHead>
                <tr>
                  <CapiroTableHeaderCell>Program element</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Component</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Stage</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell style={{ textAlign: 'right' }}>Base ($M)</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell style={{ textAlign: 'right' }}>OCO ($M)</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell style={{ textAlign: 'right' }}>Total ($M)</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Source</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Status</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell />
                </tr>
              </CapiroTableHead>
              <CapiroTableBody>
                {query.data.items.map((row) => (
                  <ReviewedPartialRow key={`${row.peCode}-${row.fiscalYear}`} row={row} />
                ))}
              </CapiroTableBody>
            </CapiroTable>
          </CapiroTableWrap>
        </>
      ) : null}
    </div>
  );
}
