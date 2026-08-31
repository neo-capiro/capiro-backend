import { useState } from 'react';
import { Card, CardHead, Pill, type PillTone } from './portfolio-primitives.js';
import { CAP_PERF } from './portfolio-fixtures.js';
import {
  OUTCOME_TONE,
  OUTCOME_TYPE_LABEL,
} from '../../../pages/clients/submission-history-api.js';
import { useClientSubmissions, type SubmissionWithCapability } from './client-submissions.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

/**
 * Past performance — real (wire-audit "4 New capability" row 12).
 *
 * Reads the client's `ClientSubmissionHistory` rows across its capabilities.
 * The columns differ from the design's on purpose: that table wanted Agency /
 * Value / Period / Role, and this store carries none of those — it holds
 * fiscal year, title, free-text meta, an outcome and its coarse type. Inventing
 * a dollar value or a prime/sub role beside a real submission title would read
 * as award data the product does not have, so the table shows what is stored.
 * "View all N" is the real row count, not the design's 14.
 *
 * Lives in its own module because it renders on Intelligence / Federal
 * Footprint (federal delivery history sits with the rest of the client's
 * federal record) rather than on Capabilities, where it used to be §7.3.
 */
export function PastPerformanceCard({ client }: { client: Client }) {
  const { rows, settled, failed, retry } = useClientSubmissions(client.id);
  const [showAll, setShowAll] = useState(false);
  // Fixture only while the reads are genuinely still in flight — NEVER on a
  // confirmed error. Every other card on this page (Lobbying activity,
  // Federal awards, Political giving, the domain stats strip) already draws
  // this exact line between "still loading" and "confirmed failed"; this
  // card was the one exception, silently showing invented submission history
  // with no way to tell it apart from a real one and no way to retry.
  const showFixture = !settled && !failed;
  const genuinelyEmpty = settled && !failed && rows.length === 0;
  const hasMore = !showFixture && !failed && rows.length > 3;
  const visibleRows = hasMore && !showAll ? rows.slice(0, 3) : rows;

  return (
    <Card>
      <CardHead
        withDesc
        title="Past performance"
        description="Submissions recorded against this client's capabilities, and what happened to each."
        action={
          showFixture || failed || rows.length === 0 ? null : hasMore ? (
            <LinkBtn onClick={() => setShowAll((current) => !current)}>
              {showAll ? 'Show recent' : `View all ${rows.length}`}
            </LinkBtn>
          ) : (
            <span style={{ fontSize: 13, color: '#667085', whiteSpace: 'nowrap' }}>
              {`${rows.length} record${rows.length === 1 ? '' : 's'}`}
            </span>
          )
        }
      />
      {failed ? (
        <div style={{ margin: 0, padding: '4px 24px 20px' }}>
          <p style={{ margin: '0 0 8px', fontSize: 14, color: '#667085' }}>
            Past performance could not be loaded.
          </p>
          <LinkBtn onClick={retry}>Retry</LinkBtn>
        </div>
      ) : genuinelyEmpty ? (
        <p style={{ margin: 0, padding: '4px 24px 20px', fontSize: 14, color: '#667085' }}>
          No submissions recorded against this client&apos;s capabilities yet.
        </p>
      ) : (
        <div style={{ width: '100%', overflowX: 'auto' }}>
          <div style={{ minWidth: showFixture ? 900 : 720 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                padding: '10px 24px',
                background: '#F9FAFB',
                borderTop: '1px solid #EAECF0',
                borderBottom: '1px solid #EAECF0',
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: '.04em',
                textTransform: 'uppercase',
                color: '#667085',
              }}
            >
              {showFixture ? (
                <>
                  <span style={{ flex: 1, minWidth: 0 }}>Award</span>
                  <span style={{ flex: '0 0 auto', width: 188 }}>Agency</span>
                  <span style={{ flex: '0 0 auto', width: 96, textAlign: 'right' }}>Value</span>
                  <span style={{ flex: '0 0 auto', width: 132 }}>Period</span>
                  <span style={{ flex: '0 0 auto', width: 88 }}>Role</span>
                  <span style={{ flex: '0 0 auto', width: 112 }}>Status</span>
                </>
              ) : (
                <>
                  <span style={{ flex: '0 0 auto', width: 72 }}>FY</span>
                  <span style={{ flex: 1, minWidth: 0 }}>Submission</span>
                  <span style={{ flex: '0 0 auto', width: 188 }}>Capability</span>
                  <span style={{ flex: '0 0 auto', width: 132 }}>Outcome</span>
                  <span style={{ flex: '0 0 auto', width: 112 }}>Status</span>
                </>
              )}
            </div>
            {showFixture
              ? CAP_PERF.map((p) => <PerfRow key={p.title} perf={p} />)
              : visibleRows.map((row) => <SubmissionRow key={row.id} row={row} />)}
          </div>
        </div>
      )}
    </Card>
  );
}

function LinkBtn({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ fontSize: 14, fontWeight: 600, color: hover ? '#0E141C' : '#101828', whiteSpace: 'nowrap' }}
    >
      {children}
    </button>
  );
}

function SubmissionRow({ row }: { row: SubmissionWithCapability }) {
  const [hover, setHover] = useState(false);
  const tone = (OUTCOME_TONE[row.outcomeType] ?? 'gray') as PillTone;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        width: '100%',
        alignItems: 'center',
        gap: 16,
        padding: '13px 24px',
        borderBottom: '1px solid #F2F4F7',
        textAlign: 'left',
        background: hover ? '#F9FAFB' : 'transparent',
      }}
    >
      <span style={{ flex: '0 0 auto', width: 72, fontSize: 13, fontWeight: 600, color: '#101828' }}>
        {row.fiscalYear}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 14, fontWeight: 500, color: '#101828', textWrap: 'pretty' }}>
          {row.title}
        </span>
        {row.meta ? (
          <span style={{ display: 'block', marginTop: 2, fontSize: 13, color: '#667085', textWrap: 'pretty' }}>
            {row.meta}
          </span>
        ) : null}
      </span>
      <span
        style={{
          flex: '0 0 auto',
          width: 188,
          fontSize: 13,
          color: '#475467',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {row.capabilityName ?? '—'}
      </span>
      <span style={{ flex: '0 0 auto', width: 132, fontSize: 13, color: '#475467', textWrap: 'pretty' }}>
        {/* The free-text outcome when there is one; the coarse type is the pill. */}
        {row.outcome ?? '—'}
      </span>
      <span style={{ flex: '0 0 auto', width: 112 }}>
        <Pill tone={tone}>{OUTCOME_TYPE_LABEL[row.outcomeType] ?? row.outcomeType}</Pill>
      </span>
    </div>
  );
}

function PerfRow({ perf }: { perf: (typeof CAP_PERF)[number] }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        width: '100%',
        alignItems: 'center',
        gap: 16,
        padding: '13px 24px',
        borderBottom: '1px solid #F2F4F7',
        textAlign: 'left',
        background: hover ? '#F9FAFB' : 'transparent',
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 14,
          fontWeight: 500,
          color: '#101828',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {perf.title}
      </span>
      <span
        style={{
          flex: '0 0 auto',
          width: 188,
          fontSize: 13,
          color: '#475467',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {perf.agency}
      </span>
      <span style={{ flex: '0 0 auto', width: 96, fontSize: 14, fontWeight: 600, color: '#101828', textAlign: 'right' }}>
        {perf.value}
      </span>
      <span style={{ flex: '0 0 auto', width: 132, fontSize: 13, color: '#475467' }}>{perf.period}</span>
      <span style={{ flex: '0 0 auto', width: 88, fontSize: 13, color: '#475467' }}>{perf.role}</span>
      <span style={{ flex: '0 0 auto', width: 112 }}>
        <Pill tone={perf.ui as PillTone}>{perf.status}</Pill>
      </span>
    </button>
  );
}
