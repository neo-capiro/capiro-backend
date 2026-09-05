/**
 * LegiWatch V2 Wave 1 (W1-6) — the Client Relevance surface.
 *
 * Not one generated sentence: a band, why it matters, the matched priorities,
 * the evidence with transcript timecodes, implications, recommended actions and
 * the provenance behind all of it.
 *
 * The client lens changes the ANALYSIS only. Nothing in this panel writes to or
 * re-renders the canonical public facts above it — switching clients refetches
 * the tenant overlay and leaves the hearing record untouched.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import { LwPill, LwSkeleton } from '../lib/primitives.js';
import { LwStateUnavailable } from '../states/SystemStates.js';
import {
  isAllClients,
  useClientRelevance,
  w1Error,
  type ClientRelevance,
  type RelevanceBand,
} from '../lib/wave1-api.js';

const BAND_LABEL: Record<RelevanceBand, string> = {
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
  NONE: 'No meaningful match',
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence',
};

function bandTone(band: RelevanceBand): 'brand' | 'gray' {
  return band === 'HIGH' || band === 'MEDIUM' ? 'brand' : 'gray';
}

export function ClientRelevancePanel({
  hearingId,
  clientId,
  onSelectClient,
  onJumpToSegment,
  onAction,
}: {
  hearingId: string;
  /** '' = the All Clients ranked view. */
  clientId: string;
  onSelectClient: (clientId: string) => void;
  onJumpToSegment: (segmentId: string) => void;
  onAction: (
    action: string,
    refs: { insightId?: string; segmentId?: string; clientId?: string },
  ) => void;
}) {
  const api = useApi();
  const relevance = useClientRelevance(hearingId, clientId);
  const clients = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
    staleTime: 5 * 60_000,
    retry: false,
  });

  return (
    <section className="lw-card" style={{ padding: 18 }} aria-label="Client relevance">
      <div className="lw-card__head">
        <h2 className="lw-card__title">Client relevance</h2>
        <span className="lw-card__meta">Your workspace only</span>
      </div>

      <label style={{ display: 'block', margin: '8px 0 14px' }}>
        <span className="lw-eyebrow" style={{ display: 'block', marginBottom: 4 }}>
          Client lens
        </span>
        <select
          aria-label="Client lens"
          value={clientId}
          onChange={(e) => onSelectClient(e.target.value)}
          style={{ minWidth: 240, padding: '6px 8px' }}
        >
          <option value="">All clients</option>
          {(clients.data ?? [])
            .filter((c) => c.status !== 'archived')
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </label>

      {relevance.isLoading ? (
        <>
          <LwSkeleton height={28} />
          <div style={{ height: 8 }} />
          <LwSkeleton height={80} delay={2} />
        </>
      ) : relevance.isError ? (
        <LwStateUnavailable
          source="Client relevance"
          reason={`Relevance analysis is unavailable. ${w1Error(relevance.error)}`}
          onRetry={() => void relevance.refetch()}
        />
      ) : isAllClients(relevance.data) ? (
        <>
          <p className="lw-card__meta" style={{ marginTop: 0 }}>
            {relevance.data.counts.HIGH} high · {relevance.data.counts.MEDIUM} medium ·{' '}
            {relevance.data.counts.LOW} low across {relevance.data.clients.length} clients.
          </p>
          {relevance.data.clients.length === 0 ? (
            <p className="lw-card__meta">
              There are no active clients in this workspace to rank this proceeding against.
            </p>
          ) : (
            <ol
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              {relevance.data.clients.map((row) => (
                <li key={row.clientId}>
                  <button
                    type="button"
                    className="lw-relevance-row"
                    onClick={() => onSelectClient(row.clientId)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      display: 'flex',
                      gap: 10,
                      alignItems: 'center',
                      background: 'none',
                      border: 0,
                      borderLeft: '2px solid var(--lw-faint)',
                      padding: '4px 0 4px 10px',
                      cursor: 'pointer',
                    }}
                    aria-label={`View ${row.clientName ?? 'client'} relevance (${BAND_LABEL[row.band]})`}
                  >
                    <LwPill tone={bandTone(row.band)} size="22">
                      {BAND_LABEL[row.band]}
                    </LwPill>
                    <span style={{ fontSize: 14, fontWeight: 500 }}>
                      {row.clientName ?? row.clientId}
                    </span>
                    <span className="lw-card__meta" style={{ fontSize: 12, marginLeft: 'auto' }}>
                      {row.provenance.matchCount} match
                      {row.provenance.matchCount === 1 ? '' : 'es'}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </>
      ) : relevance.data ? (
        <SingleClientRelevance
          result={relevance.data}
          onJumpToSegment={onJumpToSegment}
          onAction={onAction}
        />
      ) : null}
    </section>
  );
}

function SingleClientRelevance({
  result,
  onJumpToSegment,
  onAction,
}: {
  result: ClientRelevance;
  onJumpToSegment: (segmentId: string) => void;
  onAction: (
    action: string,
    refs: { insightId?: string; segmentId?: string; clientId?: string },
  ) => void;
}) {
  const [showProvenance, setShowProvenance] = useState(false);

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <LwPill tone={bandTone(result.band)} size="24">
          {BAND_LABEL[result.band]}
        </LwPill>
        <strong style={{ fontSize: 15 }}>{result.clientName ?? result.clientId}</strong>
        {result.score != null ? (
          <span className="lw-mono lw-card__meta" style={{ fontSize: 11 }}>
            score {result.score.toFixed(2)}
          </span>
        ) : null}
      </div>

      <p style={{ margin: '10px 0 0', fontSize: 14 }}>{result.whyItMatters}</p>

      {result.matchedPriorities.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <span className="lw-eyebrow">Matched priorities</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            {result.matchedPriorities.map((p) => (
              <LwPill key={p.label} tone="gray" size="22">
                {p.label}
                {p.kind ? ` · ${p.kind}` : ''}
              </LwPill>
            ))}
          </div>
        </div>
      ) : null}

      {result.evidence.length > 0 ? (
        <div style={{ marginTop: 14 }}>
          <span className="lw-eyebrow">Evidence</span>
          <ul
            style={{
              listStyle: 'none',
              margin: '6px 0 0',
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            {result.evidence.map((e) => (
              <li key={e.insightId} style={{ borderLeft: '2px solid var(--lw-brand-dot)', paddingLeft: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <LwPill tone="brand" size="22">
                    {e.insightType}
                  </LwPill>
                  <strong style={{ fontSize: 13 }}>{e.title}</strong>
                  {e.preliminary ? (
                    <span className="lw-card__meta" style={{ fontSize: 11 }}>
                      preliminary
                    </span>
                  ) : null}
                </div>
                <p style={{ margin: '4px 0 0', fontSize: 13 }}>{e.summary}</p>
                {e.quote ? (
                  e.segmentId ? (
                    // The quote is a control: it jumps to the supporting segment.
                    <button
                      type="button"
                      className="lw-backlink"
                      style={{ display: 'block', padding: 0, textAlign: 'left', margin: '6px 0 0' }}
                      onClick={() => onJumpToSegment(e.segmentId!)}
                      aria-label={`Jump to transcript evidence${e.timecode ? ` at ${e.timecode}` : ''}`}
                    >
                      <span className="lw-mono" style={{ fontSize: 11 }}>
                        “{e.quote}”{e.timecode ? ` @ ${e.timecode}` : ''}
                        {e.speakerName ? ` — ${e.speakerName}` : ''}
                      </span>
                    </button>
                  ) : (
                    <p className="lw-mono lw-card__meta" style={{ margin: '6px 0 0', fontSize: 11 }}>
                      “{e.quote}”
                      {e.speakerName ? ` — ${e.speakerName}` : ''}
                    </p>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : result.band === 'INSUFFICIENT_EVIDENCE' ? (
        <p className="lw-card__meta" style={{ marginTop: 12 }}>
          No transcript is available for this proceeding, so no evidence can be cited.
        </p>
      ) : null}

      {result.implications.length > 0 ? (
        <div style={{ marginTop: 14 }}>
          <span className="lw-eyebrow">Implications</span>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
            {result.implications.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.recommendedActions.length > 0 ? (
        <div style={{ marginTop: 14 }}>
          <span className="lw-eyebrow">Recommended actions</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            {result.recommendedActions.map((a) => (
              <button
                key={`${a.action}-${a.insightId ?? ''}`}
                type="button"
                className="lw-btn"
                title={a.rationale}
                onClick={() =>
                  onAction(a.action, {
                    insightId: a.insightId,
                    segmentId: a.segmentId,
                    clientId: result.clientId,
                  })
                }
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: 14 }}>
        <button
          type="button"
          className="lw-backlink"
          style={{ padding: 0 }}
          aria-expanded={showProvenance}
          onClick={() => setShowProvenance((v) => !v)}
        >
          {showProvenance ? 'Hide provenance' : 'Show provenance'}
        </button>
        {showProvenance ? (
          <dl
            className="lw-mono"
            style={{
              margin: '8px 0 0',
              display: 'grid',
              gridTemplateColumns: '160px 1fr',
              rowGap: 4,
              fontSize: 11,
            }}
          >
            <dt className="lw-card__meta">Hearing</dt>
            <dd style={{ margin: 0 }}>{result.provenance.hearingId}</dd>
            <dt className="lw-card__meta">Findings cited</dt>
            <dd style={{ margin: 0 }}>{result.provenance.insightIds.join(', ') || '—'}</dd>
            <dt className="lw-card__meta">Segments cited</dt>
            <dd style={{ margin: 0 }}>{result.provenance.segmentIds.join(', ') || '—'}</dd>
            <dt className="lw-card__meta">Transcript</dt>
            <dd style={{ margin: 0 }}>
              {result.provenance.transcriptAvailable ? 'available' : 'not available'}
            </dd>
            <dt className="lw-card__meta">Extractors</dt>
            <dd style={{ margin: 0 }}>{result.provenance.extractors.join(', ') || '—'}</dd>
            <dt className="lw-card__meta">Evaluated</dt>
            <dd style={{ margin: 0 }}>{result.evaluatedAt ?? '—'}</dd>
          </dl>
        ) : null}
      </div>
    </div>
  );
}
