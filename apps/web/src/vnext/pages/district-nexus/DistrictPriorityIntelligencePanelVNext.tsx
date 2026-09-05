import { useQuery } from '@tanstack/react-query';
import { CapiroSkeleton } from '../../components/feedback/index.js';
import { useApi } from '../../../lib/use-api.js';
import {
  getClientDistrictPriorityIntelligence,
  DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE,
  type ClientPriorityIntelligenceResponse,
  type CpfCdsRequestSignal,
} from '../../../pages/intelligence/district-nexus/priority-intelligence-api.js';
import { splitDistrictKey } from '../../../pages/intelligence/district-nexus/district-nexus-format.js';

/**
 * District Nexus Release 4 — "Federal & local priorities" drawer rail.
 *
 * Rendered INSIDE the existing DistrictNexusDrawerVNext (no second drawer, no
 * new map). Honesty rules:
 *  - public context (member requests, federal presence, industry/workforce) is
 *    visually distinct from client footprint (client-attributed requests);
 *  - source + year are visible; provenance links are real anchors;
 *  - requested vs final amounts use different labels and never sum;
 *  - unavailable is not empty, missing is not zero, stale is visibly stale;
 *  - a partial failure on one rail does not blank the others;
 *  - no fixture data after loading settles.
 */
export function DistrictPriorityIntelligencePanelVNext({
  clientId,
  districtKey,
}: {
  clientId: string | null;
  districtKey: string | null;
}) {
  const api = useApi();
  const { state, districtNo } = districtKey
    ? splitDistrictKey(districtKey)
    : { state: '', districtNo: '' };
  const enabled = Boolean(clientId && state && districtNo);

  const query = useQuery<ClientPriorityIntelligenceResponse>({
    queryKey: ['district-nexus', 'priority-intelligence', clientId, state, districtNo],
    queryFn: () => {
      if (!clientId) throw new Error('clientId required');
      return getClientDistrictPriorityIntelligence(api, clientId, state, districtNo);
    },
    enabled,
    retry: false,
    staleTime: 60_000,
  });

  if (!enabled) {
    return (
      <div className="dnx-hint dnx-info">
        Select a client to view federal &amp; local priorities.
      </div>
    );
  }

  if (query.isPending) {
    return (
      <div className="dnx-skel-rows" aria-busy="true">
        <CapiroSkeleton height={14} width="55%" />
        <CapiroSkeleton height={14} width="80%" />
        <CapiroSkeleton height={14} width="68%" />
      </div>
    );
  }

  if (query.isError) {
    const status = (query.error as { response?: { status?: number } }).response?.status;
    if (status === 404) {
      return (
        <div className="dnx-hint dnx-info">
          Federal &amp; local priority intelligence is not enabled for this tenant (
          {DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE}).
        </div>
      );
    }
    return (
      <div className="dnx-hint dnx-warning">
        Priority intelligence could not load. Other rails above are unaffected — this is an error,
        not empty data.
      </div>
    );
  }

  const d = query.data;
  if (!d) return null;

  const cpf = d.priorityIntelligence.cpfCds;

  return (
    <div className="dnx-priority">
      {d.warnings.length > 0 ? (
        <div className="dnx-hint dnx-warning" style={{ marginBottom: 10 }}>
          {d.warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      ) : null}

      {d.geographyVintage.conflict ? (
        <div className="dnx-hint dnx-warning" style={{ marginBottom: 10 }}>
          <b>Geography vintage conflict:</b> {d.geographyVintage.detail}
        </div>
      ) : null}

      {/* ── Member priorities ─────────────────────────────────────────── */}
      <div className="dnx-list-label">Member priorities</div>
      {cpf.memberHistoricalPriorities.length === 0 ? (
        <div className="dnx-hint dnx-info">
          {cpf.availability.status === 'unavailable'
            ? 'CPF/CDS corpus not ingested in this environment — unavailable, not zero.'
            : 'No member request history attributable under deterministic rules for this district.'}
        </div>
      ) : (
        <ul className="dnx-kv" style={{ margin: '0 0 10px', paddingLeft: 16 }}>
          {cpf.memberHistoricalPriorities.map((m) => (
            <li key={m.bioguideId} style={{ marginBottom: 4 }}>
              <span style={{ fontFamily: 'monospace', fontSize: 11.5 }}>{m.bioguideId}</span>{' '}
              {m.chamber === 'senate' ? 'senate' : `house ${m.state ?? ''}`}
              {' — '}
              <b>requested</b> ${Math.round(m.requestedTotalUsd).toLocaleString('en-US')}
              {m.finalTotalUsd > 0 ? (
                <>
                  {' · '}
                  <b>final/enacted</b> ${Math.round(m.finalTotalUsd).toLocaleString('en-US')}
                </>
              ) : (
                ' · no final/enacted amount recorded'
              )}
              {m.includesStatewideAttribution ? ' · includes statewide (senate) requests' : null}
              {' · FY'}
              {m.fiscalYears.join(', FY')}
            </li>
          ))}
        </ul>
      )}

      {/* ── CPF/CDS requests ──────────────────────────────────────────── */}
      <div className="dnx-list-label">CPF / CDS requests</div>
      {cpf.districtRequests.length === 0 ? (
        <div className="dnx-hint dnx-info">
          {cpf.availability.status === 'unavailable'
            ? 'CPF/CDS corpus not ingested — unavailable, not zero.'
            : 'No canonical requests attributed to this district/state.'}
        </div>
      ) : (
        <div style={{ marginBottom: 10 }}>
          {cpf.districtRequests.slice(0, 8).map((r) => (
            <CpfCdsRow key={r.requestId} request={r} clientLinked={r.clientAttribution != null} />
          ))}
          {cpf.districtRequests.length > 8 ? (
            <div className="dnx-muted" style={{ fontSize: 12 }}>
              +{cpf.districtRequests.length - 8} more
            </div>
          ) : null}
        </div>
      )}

      {/* ── Client-attributed requests (visually distinct) ────────────── */}
      {cpf.clientRequests.length > 0 ? (
        <>
          <div className="dnx-list-label" style={{ color: 'var(--uui-text-primary, #1c1e21)' }}>
            Linked to this client (deterministic review)
          </div>
          <div style={{ marginBottom: 10 }}>
            {cpf.clientRequests.slice(0, 5).map((r) => (
              <CpfCdsRow key={r.requestId} request={r} clientLinked />
            ))}
          </div>
        </>
      ) : null}

      {/* ── Federal presence (GSA) ────────────────────────────────────── */}
      <div className="dnx-list-label">Federal presence (GSA FRPP)</div>
      <FederalPresenceBlock data={d} />

      {/* ── Industry / workforce ──────────────────────────────────────── */}
      <div className="dnx-list-label" style={{ marginTop: 8 }}>
        Industry &amp; workforce (public context)
      </div>
      <SectorBlock data={d} />

      {/* ── Recent changes ────────────────────────────────────────────── */}
      <div className="dnx-list-label" style={{ marginTop: 8 }}>
        Recent changes (deterministic)
      </div>
      {d.priorityIntelligence.recentChanges.length === 0 ? (
        <div className="dnx-hint dnx-info">
          No deterministic changes recorded for this district yet.
        </div>
      ) : (
        <ul style={{ margin: '0 0 8px', paddingLeft: 16, fontSize: 12.5 }}>
          {d.priorityIntelligence.recentChanges.slice(0, 6).map((c, i) => (
            <li key={i} style={{ marginBottom: 3 }}>
              <b>{c.changeKind}</b> ({c.severity}) · {c.observedAt.slice(0, 10)}
              {c.sourceYear ? ` · source year ${c.sourceYear}` : ''}
              {c.geographyVintage ? ` · ${c.geographyVintage}` : ''}
            </li>
          ))}
        </ul>
      )}

      {d.missingPrioritySources.length > 0 ? (
        <div className="dnx-hint dnx-info" style={{ marginTop: 6 }}>
          <b>Missing sources:</b> {d.missingPrioritySources.join('; ')}
        </div>
      ) : null}
    </div>
  );
}

function CpfCdsRow({
  request: r,
  clientLinked,
}: {
  request: CpfCdsRequestSignal;
  clientLinked: boolean;
}) {
  return (
    <div
      style={{
        marginBottom: 6,
        fontSize: 12.5,
        paddingLeft: clientLinked ? 8 : 0,
        borderLeft: clientLinked ? '2px solid var(--uui-text-primary, #1c1e21)' : undefined,
      }}
    >
      <div>
        <b>{r.chamber === 'house' ? 'House CPF' : 'Senate CDS (statewide)'}</b> FY{r.fiscalYear} ·{' '}
        {r.recipientName}
        {clientLinked ? ' · ★ linked to client' : ''}
      </div>
      <div className="dnx-muted">{r.projectTitle}</div>
      <div className="dnx-muted">
        <b>Requested:</b> ${Math.round(r.requestedAmountUsd).toLocaleString('en-US')}
        {r.finalAmountUsd != null ? (
          <>
            {' · '}
            <b>Final/enacted:</b> ${Math.round(r.finalAmountUsd).toLocaleString('en-US')}
          </>
        ) : (
          ' · no final/enacted amount recorded'
        )}
        {' · stage: '}
        {r.amountStageRaw}
        {' · '}
        {r.sourceOccurrenceCount} source occurrence{r.sourceOccurrenceCount === 1 ? '' : 's'}
      </div>
    </div>
  );
}

function FederalPresenceBlock({ data: d }: { data: ClientPriorityIntelligenceResponse }) {
  const g = d.priorityIntelligence.federalProperty;
  const sourceLabel = g.fiscalYears.length
    ? `FY${g.fiscalYears[g.fiscalYears.length - 1]} public dataset`
    : 'public dataset';
  if (g.availability.status === 'not_loaded') {
    return (
      <div style={{ marginBottom: 8 }}>
        <div className="dnx-hint dnx-info">
          GSA FRPP data not ingested in this environment — unavailable, not zero.
        </div>
        {g.warnings.map((w, i) => (
          <div key={i} className="dnx-hint dnx-warning">
            {w}
          </div>
        ))}
      </div>
    );
  }
  if (g.availability.status === 'error') {
    return (
      <div style={{ marginBottom: 8 }}>
        <div className="dnx-hint dnx-warning">
          GSA FRPP last source run failed — data unavailable, not empty.
        </div>
        {g.warnings.map((w, i) => (
          <div key={i} className="dnx-hint dnx-warning">
            {w}
          </div>
        ))}
      </div>
    );
  }
  if ((g.detailedAssetCount ?? 0) === 0) {
    return (
      <div style={{ marginBottom: 8 }}>
        <div className="dnx-hint dnx-info">
          No FRPP assets recorded for this district (source loaded, FY{g.fiscalYears.at(-1) ?? '?'}
          ). Real empty, not missing data.
        </div>
        {g.warnings.map((w, i) => (
          <div key={i} className="dnx-hint dnx-warning">
            {w}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div style={{ marginBottom: 8, fontSize: 12.5 }}>
      {g.warnings.map((w, i) => (
        <div key={i} className="dnx-hint dnx-warning" style={{ marginBottom: 4 }}>
          {w}
        </div>
      ))}
      <div>
        {g.detailedAssetCount} asset{g.detailedAssetCount === 1 ? '' : 's'} ({g.ownedCount ?? '?'}{' '}
        owned / {g.leasedCount ?? '?'} leased)
        {g.detailedSquareFeetTotal != null
          ? ` · ${Math.round(g.detailedSquareFeetTotal).toLocaleString('en-US')} sq ft`
          : ' · sq ft unavailable'}
        {g.summarizedInstallationCount
          ? ` · ${g.summarizedInstallationCount} summarized installation row(s) kept separate`
          : ''}
      </div>
      <div className="dnx-muted">
        Source: GSA FRPP {sourceLabel} · FY{g.fiscalYears.join(', FY')} ·{' '}
        {d.geographyVintage.boundaryCongress == null
          ? 'district vintage source-unknown (not inferred)'
          : `boundary congress ${d.geographyVintage.boundaryCongress}`}
      </div>
      {g.topAssets.slice(0, 4).map((a) => (
        <div key={a.rpUid} className="dnx-muted" style={{ fontSize: 12 }}>
          {a.reportingAgency} — {a.realPropertyUse ?? a.realPropertyType ?? 'property'}
          {a.city ? `, ${a.city}` : ''}
          {a.squareFeet != null
            ? ` · ${Math.round(a.squareFeet).toLocaleString('en-US')} sq ft`
            : ''}
          {a.sourceUrl ? (
            <>
              {' · '}
              <a href={a.sourceUrl} target="_blank" rel="noreferrer">
                source
              </a>
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function SectorBlock({ data: d }: { data: ClientPriorityIntelligenceResponse }) {
  const s = d.priorityIntelligence.sectorSignals;
  if (s.availability.status === 'not_loaded') {
    return (
      <div className="dnx-hint dnx-info" style={{ marginBottom: 8 }}>
        Public economic metrics not ingested — unavailable, not zero.
      </div>
    );
  }
  const visible = s.metrics.filter((m) => m.metricValue != null).slice(0, 6);
  return (
    <div style={{ marginBottom: 8, fontSize: 12.5 }}>
      {visible.length === 0 ? (
        <div className="dnx-hint dnx-info">No mapped sector metrics for this district.</div>
      ) : (
        visible.map((m) => (
          <div key={`${m.source}:${m.metricKey}:${m.naicsCode ?? ''}`}>
            {m.label}:{' '}
            <b>
              {Math.round(m.metricValue!).toLocaleString('en-US')}
              {m.unit ? ` ${m.unit}` : ''}
            </b>
            {' · '}
            {m.source.toUpperCase()} {m.sourceYear ? `(${m.sourceYear})` : ''}
            {m.naicsCode ? ` · NAICS ${m.naicsCode}` : ''}
            {' · public district context, not client figures'}
          </div>
        ))
      )}
      {s.availability.status === 'stale' ? (
        <div className="dnx-hint dnx-warning">
          Some economic sources are stale — see freshness below.
        </div>
      ) : null}
    </div>
  );
}
