import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { CapiroModal } from '../../components/overlays/index.js';
import { CapiroButton } from '../../components/actions/index.js';
import { Card, CardHead, Pill, type PillTone } from './portfolio-primitives.js';
import {
  deleteSubmissionHistory,
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
  const api = useApi();
  const queryClient = useQueryClient();
  const { rows, settled, failed, retry } = useClientSubmissions(client.id);
  const [showAll, setShowAll] = useState(false);
  const [removing, setRemoving] = useState<SubmissionWithCapability | null>(null);
  const remove = useMutation({
    mutationFn: ({ clientId, id }: { clientId: string; id: string }) =>
      deleteSubmissionHistory(api, clientId, id),
    onSuccess: async (_result, { clientId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['client-submission-history-prime', clientId] }),
        queryClient.invalidateQueries({ queryKey: ['client-submission-history', clientId] }),
      ]);
      setRemoving(null);
    },
  });
  const genuinelyEmpty = settled && !failed && rows.length === 0;
  const hasMore = settled && !failed && rows.length > 3;
  const visibleRows = hasMore && !showAll ? rows.slice(0, 3) : rows;

  return (
    <Card>
      <CardHead
        withDesc
        title="Past performance"
        description="Submissions recorded against this client's capabilities, and what happened to each."
        action={
          !settled || failed || rows.length === 0 ? null : hasMore ? (
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
      ) : !settled ? (
        <p role="status" style={{ margin: 0, padding: '4px 24px 20px', fontSize: 14, color: '#667085' }}>
          Loading past performance…
        </p>
      ) : genuinelyEmpty ? (
        <p style={{ margin: 0, padding: '4px 24px 20px', fontSize: 14, color: '#667085' }}>
          No submissions recorded against this client&apos;s capabilities yet.
        </p>
      ) : (
        <div style={{ width: '100%', overflowX: 'auto' }}>
          <div style={{ minWidth: 720 }}>
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
              <span style={{ flex: '0 0 auto', width: 72 }}>FY</span>
              <span style={{ flex: 1, minWidth: 0 }}>Submission</span>
              <span style={{ flex: '0 0 auto', width: 188 }}>Capability</span>
              <span style={{ flex: '0 0 auto', width: 132 }}>Outcome</span>
              <span style={{ flex: '0 0 auto', width: 112 }}>Status</span>
            </div>
            {visibleRows.map((row) => <SubmissionRow key={row.id} row={row} removing={remove.isPending}
              onRemove={() => { remove.reset(); setRemoving(row); }} />)}
          </div>
        </div>
      )}
      {removing ? (
        <CapiroModal open title="Remove submission?" onClose={() => {
          if (!remove.isPending) { remove.reset(); setRemoving(null); }
        }}>
          <p>Permanently remove “{removing.title}” ({removing.fiscalYear}) from {client.name}&apos;s past performance?</p>
          <p>The capability and its documents will remain. This cannot be undone.</p>
          {remove.isError ? <p role="alert">Could not remove this submission. Try again.</p> : null}
          <div className="capiro-crm__form-actions">
            <CapiroButton variant="primary" loading={remove.isPending} disabled={remove.isPending}
              onClick={() => remove.mutate({ clientId: client.id, id: removing.id })}>Remove submission</CapiroButton>
            <CapiroButton variant="secondary" disabled={remove.isPending}
              onClick={() => { remove.reset(); setRemoving(null); }}>Cancel</CapiroButton>
          </div>
        </CapiroModal>
      ) : null}
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

function SubmissionRow({ row, onRemove, removing }: { row: SubmissionWithCapability; onRemove: () => void; removing: boolean }) {
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
        <button type="button" aria-label={`Remove submission ${row.title}`} onClick={onRemove} disabled={removing}
          style={{ display: 'block', marginTop: 6, fontSize: 12, fontWeight: 600, color: '#B42318' }}>
          Remove
        </button>
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
