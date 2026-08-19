import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import {
  FUNDING_OPPORTUNITIES_RISK_FEATURE,
  riskContextApiPath,
  type ExclusionViewData,
  type ProtestViewData,
  type RiskContextView,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { FovAlert, FovCard, FovPill } from './fov-ui.js';

/**
 * Protest and exclusion risk context (P45) — vNext port of the canonical panel.
 *
 * Unchanged rules: everything here is an observation with a date and a source;
 * the four exclusion states render with different colours AND different
 * sentences (`unverified` never collapses into either neighbour); the absence
 * caveat renders on every state — it matters most on the clean one.
 */

const EXCLUSION_COLORS: Record<ExclusionViewData['state'], string> = {
  active: 'red',
  expired: 'default',
  unverified: 'orange',
  none_observed: 'default',
};

const EXCLUSION_LABELS: Record<ExclusionViewData['state'], string> = {
  active: 'Exclusion observed — active',
  expired: 'Exclusion observed — ended',
  unverified: 'Exclusion observed — not re-checked recently',
  none_observed: 'No exclusion observed',
};

function ProtestTable({ protests }: { protests: ProtestViewData[] }) {
  return (
    <CapiroTableWrap>
      <CapiroTable>
        <CapiroTableHead>
          <tr>
            <CapiroTableHeaderCell>Case</CapiroTableHeaderCell>
            <CapiroTableHeaderCell>Outcome</CapiroTableHeaderCell>
            <CapiroTableHeaderCell>Filed</CapiroTableHeaderCell>
            <CapiroTableHeaderCell>Decided</CapiroTableHeaderCell>
            <CapiroTableHeaderCell>Agency</CapiroTableHeaderCell>
          </tr>
        </CapiroTableHead>
        <CapiroTableBody>
          {protests.map((row) => (
            <tr key={row.caseNumber ?? `${row.filedDate}-${row.agencyName}`}>
              <CapiroTableCell>
                <div className="fov-stack">
                  {row.sourceUrl ? (
                    <a href={row.sourceUrl} target="_blank" rel="noreferrer">
                      {row.caseNumber ?? 'View docket'}
                    </a>
                  ) : (
                    <span>{row.caseNumber ?? 'Not stated'}</span>
                  )}
                  {/* The forum, never normalized away: GAO and the Court of
                      Federal Claims use the same outcome words for different
                      events. */}
                  {row.sourceSystem ? (
                    <span className="fov-micro">{row.sourceSystem.toUpperCase()}</span>
                  ) : null}
                </div>
              </CapiroTableCell>
              <CapiroTableCell>
                {row.outcome ? (
                  <FovPill testId="protest-outcome" title={row.outcomeCaveat ?? undefined}>
                    {row.outcome}
                  </FovPill>
                ) : (
                  // Null is open or unstated. Never rendered as a loss.
                  <span className="fov-muted" data-testid="protest-outcome-open">
                    Open or not stated
                  </span>
                )}
              </CapiroTableCell>
              <CapiroTableCell>
                {row.filedDate ?? <span className="fov-muted">Not stated</span>}
              </CapiroTableCell>
              <CapiroTableCell>
                {row.decisionDate ?? <span className="fov-muted">Not stated</span>}
              </CapiroTableCell>
              <CapiroTableCell>
                {row.agencyName ?? <span className="fov-muted">Not stated</span>}
              </CapiroTableCell>
            </tr>
          ))}
        </CapiroTableBody>
      </CapiroTable>
    </CapiroTableWrap>
  );
}

export function OpportunityRiskPanel({ clientId }: { clientId: string | null }) {
  const api = useApi();
  const flag = useIntelFeature(FUNDING_OPPORTUNITIES_RISK_FEATURE);
  const enabled = flag.ready && flag.enabled && clientId != null;

  const query = useQuery<RiskContextView>({
    queryKey: ['funding-opportunity-risk', clientId],
    queryFn: async () => (await api.get<RiskContextView>(riskContextApiPath(clientId!))).data,
    retry: false,
    enabled,
  });

  if (!flag.ready || !flag.enabled) return null;

  let body: ReactNode;
  if (clientId == null) {
    body = (
      <span className="fov-muted">
        Not available without a client. Risk evidence is matched to a client’s own UEI.
      </span>
    );
  } else if (query.isPending) {
    body = <span className="fov-muted">Loading…</span>;
  } else if (query.isError) {
    body = (
      <FovAlert
        tone="error"
        testId="risk-error"
        message="Risk context could not be loaded"
        description="This is a request failure. Nothing can be concluded from it about this client."
      />
    );
  } else if (query.data) {
    const data = query.data;
    body = (
      <div className="fov-stack fov-stack--10">
        {data.recommendationHint ? (
          <FovAlert
            tone="warning"
            testId="risk-hint"
            message="Needs review"
            description={data.recommendationHint.reason}
          />
        ) : null}

        <div data-testid="risk-exclusion">
          <span className="fov-fact__label">Exclusion</span>
          <div className="fov-stack fov-stack--2">
            <span className="fov-row">
              <FovPill tone={EXCLUSION_COLORS[data.exclusion.state]}>
                {EXCLUSION_LABELS[data.exclusion.state]}
              </FovPill>
              {data.exclusion.observedAt ? (
                <span className="fov-micro">Observed {data.exclusion.observedAt.slice(0, 10)}</span>
              ) : null}
            </span>
            <span style={{ fontSize: 12 }}>{data.exclusion.explanation}</span>
            {data.exclusion.sourceUrl ? (
              <a href={data.exclusion.sourceUrl} target="_blank" rel="noreferrer">
                Provider record
              </a>
            ) : null}
          </div>
        </div>

        <div data-testid="risk-protests">
          <span className="fov-fact__label">Protests naming this client</span>
          {data.protests.length > 0 ? (
            <ProtestTable protests={data.protests} />
          ) : (
            <span className="fov-muted">
              Capiro has observed no protest naming this client’s UEI. This is not a statement that
              none exists.
            </span>
          )}
        </div>

        {/* On every state, including the clean one — where it matters most. */}
        <ul
          className="fov-stack fov-stack--2"
          data-testid="risk-caveats"
          style={{ listStyle: 'none', margin: 0, padding: 0 }}
        >
          {data.caveats.map((caveat) => (
            <li key={caveat}>
              <span className="fov-micro">{caveat}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <FovCard title="Procurement risk" testId="fo-detail-risk">
      {body}
    </FovCard>
  );
}
