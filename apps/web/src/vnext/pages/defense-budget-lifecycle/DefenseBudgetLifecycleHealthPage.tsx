import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { useMe } from '../../../lib/me.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { CapiroSelect } from '../../components/fields/index.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import {
  getCoverageReconciliation,
  getCycleHealth,
  getScheduleTickHealth,
  type CoverageExceptionCode,
} from './defense-budget-lifecycle-api.js';
import './defense-budget-lifecycle-vnext.css';

const FISCAL_YEAR_OPTIONS = [2029, 2028, 2027, 2026, 2025].map((year) => ({
  label: `FY${year}`,
  value: String(year),
}));

function relativeFromNow(iso: string | null): string {
  if (!iso) return 'never recorded';
  const deltaMs = Date.now() - new Date(iso).getTime();
  const hours = Math.round(Math.abs(deltaMs) / 3_600_000);
  if (hours < 1) return 'less than an hour ago';
  if (hours < 48) return `${hours}h ${deltaMs >= 0 ? 'ago' : 'from now'}`;
  return `${Math.round(hours / 24)}d ${deltaMs >= 0 ? 'ago' : 'from now'}`;
}

function ExceptionCodes({ codes }: { codes: readonly CoverageExceptionCode[] }) {
  return codes.length ? (
    <span className="dbl-vnext-exceptions">
      {codes.map((code) => <code key={code}>{code}</code>)}
    </span>
  ) : <span>none</span>;
}

function CoverageCount({ value }: { value: number | null | undefined }) {
  return <>{value == null ? 'unknown' : value}</>;
}

/**
 * Phase 8 Session 11 — Cycle health + coverage.
 *
 * Read-only, Capiro-internal analyst view over the Session 7-10 discovery
 * control plane. Every number here is exactly what `buildCycleHealth`
 * (Session 7 domain, unmodified) reports — nothing on this page re-derives,
 * rounds, or fills in a number the API did not return. `notFiled` and
 * `reviewRequired` are shown as their own tiles rather than folded into a
 * total, because an unpublished expected source has no known amount — it is
 * not zero.
 */
export function DefenseBudgetLifecycleHealthPage() {
  const api = useApi();
  const me = useMe();
  const isInternal = me.data?.tenant.slug === 'capiro-internal';
  const [fiscalYear, setFiscalYear] = useState(2027);

  const healthQuery = useQuery({
    queryKey: ['defense-budget-lifecycle-cycle-health', fiscalYear],
    queryFn: () => getCycleHealth(api, fiscalYear),
    enabled: isInternal,
    staleTime: 60_000,
  });
  const tickHealthQuery = useQuery({
    queryKey: ['defense-budget-lifecycle-schedule-tick-health'],
    queryFn: () => getScheduleTickHealth(api),
    enabled: isInternal,
    staleTime: 60_000,
  });
  const reconciliationQuery = useQuery({
    queryKey: ['defense-budget-lifecycle-coverage-reconciliation', fiscalYear],
    queryFn: () => getCoverageReconciliation(api, fiscalYear),
    enabled: isInternal,
    staleTime: 60_000,
  });

  const health = healthQuery.data;

  const tiles = useMemo(() => {
    if (!health) return [];
    return [
      { label: 'Expected sources', value: health.expectedSources, tone: 'neutral' as const },
      { label: 'Published', value: health.published, tone: 'success' as const },
      { label: 'Not filed', value: health.notFiled, tone: 'neutral' as const },
      { label: 'Review required', value: health.reviewRequired, tone: 'warning' as const },
      { label: 'Review backlog', value: health.reviewBacklog, tone: 'warning' as const },
      { label: 'Failed downloads', value: health.failedDownloads, tone: 'danger' as const },
      { label: 'Parser failures', value: health.parserFailures, tone: 'danger' as const },
    ];
  }, [health]);

  if (!isInternal) {
    return (
      <section className="dbl-vnext" data-screen-label="Defense budget lifecycle">
        <CapiroEmptyState
          title="Not available for this workspace"
          description="Defense budget cycle health is a Capiro-internal analyst view."
        />
      </section>
    );
  }

  return (
    <section className="dbl-vnext" data-screen-label="Defense budget lifecycle">
      <div className="dbl-vnext-head">
        <div>
          <div className="dbl-vnext-title">Defense budget cycle health</div>
          <div className="dbl-vnext-sub">
            Official-source discovery and classification coverage — not funding amounts. An
            unpublished expected source is a recorded state, never a zero.
          </div>
        </div>
        <div className="dbl-vnext-actions">
          <CapiroSelect
            label="Fiscal year"
            options={FISCAL_YEAR_OPTIONS}
            value={String(fiscalYear)}
            onChange={(e) => setFiscalYear(Number(e.target.value))}
          />
          <Link to={`/defense-budget-lifecycle/review-queue?fiscalYear=${fiscalYear}`} className="dbl-vnext-link">
            Review queue →
          </Link>
          <Link to="/defense-budget-lifecycle/reviewed-partial" className="dbl-vnext-link">
            Reviewed partial records →
          </Link>
        </div>
      </div>

      {healthQuery.isLoading ? (
        <div className="dbl-vnext-card" style={{ padding: 24 }}>
          <CapiroSkeleton height={80} />
        </div>
      ) : healthQuery.isError ? (
        <div className="dbl-vnext-card" style={{ padding: 24 }}>
          <CapiroErrorState
            description="Could not load cycle health."
            onRetry={() => healthQuery.refetch()}
          />
        </div>
      ) : health ? (
        <>
          <div className="dbl-vnext-tiles">
            {tiles.map((tile) => (
              <div key={tile.label} className="dbl-vnext-tile">
                <span className="dbl-vnext-tile-value">{tile.value}</span>
                <span className="dbl-vnext-tile-label">{tile.label}</span>
              </div>
            ))}
          </div>

          <div className="dbl-vnext-card">
            <div className="dbl-vnext-card-head">
              <div className="dbl-vnext-card-title">Coverage by authority track</div>
            </div>
            {health.tracks.length === 0 ? (
              <div style={{ padding: '32px 24px' }}>
                <CapiroEmptyState title={`No expected sources registered for FY${fiscalYear}`} />
              </div>
            ) : (
              <CapiroTableWrap>
                <CapiroTable>
                  <CapiroTableHead>
                    <tr>
                      <CapiroTableHeaderCell>Authority track</CapiroTableHeaderCell>
                      <CapiroTableHeaderCell>Expected</CapiroTableHeaderCell>
                      <CapiroTableHeaderCell>Published</CapiroTableHeaderCell>
                      <CapiroTableHeaderCell>Not filed</CapiroTableHeaderCell>
                      <CapiroTableHeaderCell>Review required</CapiroTableHeaderCell>
                      <CapiroTableHeaderCell>Superseded</CapiroTableHeaderCell>
                      <CapiroTableHeaderCell>Withdrawn</CapiroTableHeaderCell>
                      <CapiroTableHeaderCell>Unavailable</CapiroTableHeaderCell>
                    </tr>
                  </CapiroTableHead>
                  <CapiroTableBody>
                    {health.tracks.map((track) => (
                      <tr key={track.authorityTrack}>
                        <CapiroTableCell>
                          <span className="dbl-vnext-mono">{track.authorityTrack}</span>
                        </CapiroTableCell>
                        <CapiroTableCell>{track.expectedSources}</CapiroTableCell>
                        <CapiroTableCell>{track.published}</CapiroTableCell>
                        <CapiroTableCell>{track.notFiled}</CapiroTableCell>
                        <CapiroTableCell>
                          {track.reviewRequired > 0 ? (
                            <CapiroBadge tone="warning">{track.reviewRequired}</CapiroBadge>
                          ) : (
                            0
                          )}
                        </CapiroTableCell>
                        <CapiroTableCell>{track.superseded}</CapiroTableCell>
                        <CapiroTableCell>{track.withdrawn}</CapiroTableCell>
                        <CapiroTableCell>{track.unavailable}</CapiroTableCell>
                      </tr>
                    ))}
                  </CapiroTableBody>
                </CapiroTable>
              </CapiroTableWrap>
            )}
          </div>

          <div className="dbl-vnext-card">
            <div className="dbl-vnext-card-head">
              <div className="dbl-vnext-card-title">Discovery freshness</div>
            </div>
            <dl className="dbl-vnext-facts">
              <div>
                <dt>Last discovery</dt>
                <dd>{relativeFromNow(health.lastDiscoveryAt)}</dd>
              </div>
              <div>
                <dt>Next watcher run</dt>
                <dd>{relativeFromNow(health.nextWatcherRunAt)}</dd>
              </div>
              <div>
                <dt>Stale adapters (no run &gt;72h)</dt>
                <dd>{health.staleAdapters.length === 0 ? 'none' : health.staleAdapters.join(', ')}</dd>
              </div>
              <div>
                <dt>GPU routing</dt>
                <dd>{health.nvidiaRouting} — {health.productionParser}</dd>
              </div>
            </dl>
          </div>

          <div className="dbl-vnext-card" data-testid="physical-source-reconciliation">
            <div className="dbl-vnext-card-head">
              <div className="dbl-vnext-card-title">Physical-source reconciliation</div>
              <div className="dbl-vnext-sub">
                Logical source slots reconciled to physical files and downstream processing. Unknown
                catalog denominators stay unknown; these counts are not funding amounts.
              </div>
            </div>
            {reconciliationQuery.isLoading ? (
              <div style={{ padding: 24 }}><CapiroSkeleton height={60} /></div>
            ) : reconciliationQuery.isError ? (
              <div style={{ padding: 24 }}>
                <CapiroErrorState
                  description="Could not load physical-source reconciliation."
                  onRetry={() => reconciliationQuery.refetch()}
                />
              </div>
            ) : reconciliationQuery.data ? (
              <>
                <div className="dbl-vnext-reconciliation-meta">
                  FY{reconciliationQuery.data.fiscalYear} · {reconciliationQuery.data.logicalSlotCount} logical slots · environment {reconciliationQuery.data.environment} · active snapshot <span data-testid="active-snapshot-id">{reconciliationQuery.data.activeSnapshotId ?? 'unknown'}</span>
                </div>
                {reconciliationQuery.data.rows.length === 0 ? (
                  <div style={{ padding: '24px' }}>
                    <CapiroEmptyState title={`No physical-source slots registered for FY${fiscalYear}`} />
                  </div>
                ) : (
                  <CapiroTableWrap>
                    <CapiroTable>
                      <CapiroTableHead>
                        <tr>
                          <CapiroTableHeaderCell>Logical slot</CapiroTableHeaderCell>
                          <CapiroTableHeaderCell>Source family</CapiroTableHeaderCell>
                          <CapiroTableHeaderCell>Component</CapiroTableHeaderCell>
                          <CapiroTableHeaderCell>Discovery</CapiroTableHeaderCell>
                          <CapiroTableHeaderCell>Required known / total</CapiroTableHeaderCell>
                          <CapiroTableHeaderCell>Optional known</CapiroTableHeaderCell>
                          <CapiroTableHeaderCell>Parsed</CapiroTableHeaderCell>
                          <CapiroTableHeaderCell>Verified</CapiroTableHeaderCell>
                          <CapiroTableHeaderCell>Reviewed</CapiroTableHeaderCell>
                          <CapiroTableHeaderCell>Published</CapiroTableHeaderCell>
                          <CapiroTableHeaderCell>Row exceptions</CapiroTableHeaderCell>
                        </tr>
                      </CapiroTableHead>
                      <CapiroTableBody>
                        {reconciliationQuery.data.rows.map((row) => (
                          <tr key={row.slotId}>
                            <CapiroTableCell><span className="dbl-vnext-mono">{row.slotId}</span></CapiroTableCell>
                            <CapiroTableCell>{row.sourceFamily}</CapiroTableCell>
                            <CapiroTableCell>{row.component ?? 'unknown'}</CapiroTableCell>
                            <CapiroTableCell>{row.discovery}</CapiroTableCell>
                            <CapiroTableCell>
                              {row.knownRequiredUnits} known / <CoverageCount value={row.denominator} />
                            </CapiroTableCell>
                            <CapiroTableCell><CoverageCount value={row.knownOptionalUnits} /></CapiroTableCell>
                            <CapiroTableCell><CoverageCount value={row.parsed} /></CapiroTableCell>
                            <CapiroTableCell><CoverageCount value={row.verified} /></CapiroTableCell>
                            <CapiroTableCell><CoverageCount value={row.reviewed} /></CapiroTableCell>
                            <CapiroTableCell><CoverageCount value={row.published} /></CapiroTableCell>
                            <CapiroTableCell><ExceptionCodes codes={row.exceptions} /></CapiroTableCell>
                          </tr>
                        ))}
                      </CapiroTableBody>
                    </CapiroTable>
                  </CapiroTableWrap>
                )}
                <div className="dbl-vnext-card-head dbl-vnext-unit-head">
                  <div className="dbl-vnext-card-title">Physical units and exceptions</div>
                </div>
                {reconciliationQuery.data.rows.every((row) => row.units.length === 0) ? (
                  <div style={{ padding: '20px 24px' }}>
                    <CapiroEmptyState title="No physical units recorded" />
                  </div>
                ) : (
                  <CapiroTableWrap>
                    <CapiroTable>
                      <CapiroTableHead>
                        <tr>
                          <CapiroTableHeaderCell>Logical slot / family</CapiroTableHeaderCell>
                          <CapiroTableHeaderCell>Unit</CapiroTableHeaderCell>
                          <CapiroTableHeaderCell>Requirement / account</CapiroTableHeaderCell>
                          <CapiroTableHeaderCell>Budget activity / volume</CapiroTableHeaderCell>
                          <CapiroTableHeaderCell>Source document ID</CapiroTableHeaderCell>
                          <CapiroTableHeaderCell>Source SHA-256</CapiroTableHeaderCell>
                          <CapiroTableHeaderCell>Parsed</CapiroTableHeaderCell>
                          <CapiroTableHeaderCell>Verified</CapiroTableHeaderCell>
                          <CapiroTableHeaderCell>Reviewed</CapiroTableHeaderCell>
                          <CapiroTableHeaderCell>Published</CapiroTableHeaderCell>
                          <CapiroTableHeaderCell>Unit exceptions</CapiroTableHeaderCell>
                        </tr>
                      </CapiroTableHead>
                      <CapiroTableBody>
                        {reconciliationQuery.data.rows.flatMap((row) => row.units.map((unit) => (
                          <tr key={unit.unitId}>
                            <CapiroTableCell>
                              <span className="dbl-vnext-mono">{row.slotId}</span><br />{row.sourceFamily} · {row.component ?? 'unknown'}
                            </CapiroTableCell>
                            <CapiroTableCell>{unit.kind} · <span className="dbl-vnext-mono">{unit.unitId}</span></CapiroTableCell>
                            <CapiroTableCell>{unit.required ? 'required' : 'optional'} · {unit.account ?? 'account unknown'}</CapiroTableCell>
                            <CapiroTableCell>{unit.budgetActivity ?? 'unknown'} / {unit.volume ?? 'unknown'}</CapiroTableCell>
                            <CapiroTableCell><span data-testid={`source-document-id-${unit.unitId}`} className="dbl-vnext-mono">{unit.sourceDocumentId ?? 'unknown'}</span></CapiroTableCell>
                            <CapiroTableCell><span data-testid={`source-sha256-${unit.unitId}`} className="dbl-vnext-mono">{unit.sourceSha256 ?? 'unknown'}</span></CapiroTableCell>
                            <CapiroTableCell>{unit.parsed ? 'yes' : 'no'}</CapiroTableCell>
                            <CapiroTableCell>{unit.verified ? 'yes' : 'no'}</CapiroTableCell>
                            <CapiroTableCell>{unit.reviewed ? 'yes' : 'no'}</CapiroTableCell>
                            <CapiroTableCell>{unit.published ? 'yes' : 'no'}</CapiroTableCell>
                            <CapiroTableCell><ExceptionCodes codes={unit.exceptions} /></CapiroTableCell>
                          </tr>
                        )))}
                      </CapiroTableBody>
                    </CapiroTable>
                  </CapiroTableWrap>
                )}
              </>
            ) : null}
          </div>
        </>
      ) : null}

      <div className="dbl-vnext-card">
        <div className="dbl-vnext-card-head">
          <div className="dbl-vnext-card-title">Schedule tick health</div>
        </div>
        {tickHealthQuery.isLoading ? (
          <div style={{ padding: 24 }}>
            <CapiroSkeleton height={40} />
          </div>
        ) : tickHealthQuery.isError ? (
          <div style={{ padding: 24 }}>
            <CapiroErrorState description="Could not load schedule tick health." onRetry={() => tickHealthQuery.refetch()} />
          </div>
        ) : tickHealthQuery.data && tickHealthQuery.data.ticksConsidered === 0 ? (
          <div style={{ padding: '32px 24px' }}>
            <CapiroEmptyState
              title="No schedule ticks recorded"
              description="Production schedule activation is separate deployment work, not part of this view."
            />
          </div>
        ) : tickHealthQuery.data ? (
          <dl className="dbl-vnext-facts">
            <div>
              <dt>Last tick</dt>
              <dd>
                {relativeFromNow(tickHealthQuery.data.lastTickAt)}
                {tickHealthQuery.data.staleSinceLastTick ? (
                  <CapiroBadge tone="warning" style={{ marginLeft: 8 }}>
                    stale
                  </CapiroBadge>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>Completed / failed ticks</dt>
              <dd>
                {tickHealthQuery.data.completedTicks} / {tickHealthQuery.data.failedTicks}
              </dd>
            </div>
            <div>
              <dt>Adapters succeeded / failed (all ticks)</dt>
              <dd>
                {tickHealthQuery.data.totalAdaptersSucceeded} / {tickHealthQuery.data.totalAdaptersFailed}
              </dd>
            </div>
          </dl>
        ) : null}
      </div>
    </section>
  );
}
