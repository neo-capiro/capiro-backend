/**
 * Funding Opportunities v2 — the detail drawer (480px, expandable to full).
 *
 * The mockup's right-hand drawer: header (client mark, client / source id, ASK
 * MERI, expand, close), then the opportunity body — recommendation hero, fit &
 * eligibility ladder, acquisition position, government landscape, requirements &
 * documents, notice timeline, pursuit plan, and the source record. ASK MERI swaps
 * the body for the governed Meri assessment (P38), which cannot change the
 * recommendation.
 *
 * Every section binds to a real endpoint and states its coverage rather than
 * faking data: a flag-off capability renders the dashed "not entitled/available"
 * panel the mockup specifies, with the flag named.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Skeleton } from 'antd';
import { useApi } from '../../../../lib/use-api.js';
import { useIntelFeature } from '../../../../lib/intel-feature-flags.js';
import {
  ACQUISITION_POSITION_LABELS,
  FUNDING_OPPORTUNITIES_DOCUMENTS_FEATURE,
  FUNDING_OPPORTUNITIES_LANDSCAPE_FEATURE,
  FUNDING_OPPORTUNITIES_MERI_FEATURE,
  FUNDING_OPPORTUNITIES_NOTICE_HISTORY_FEATURE,
  FUNDING_OPPORTUNITIES_PIPELINE_FEATURE,
  KIND_LABELS,
  LANDSCAPE_SOURCE_LABELS,
  SOURCE_LABELS,
  actionPlanApiPath,
  asCatalogRef,
  assessmentApiPath,
  landscapeApiPath,
  moneyLine,
  opportunityActionApiPath,
  requirementsApiPath,
  timelineApiPath,
  type AcquisitionPosition,
  type ActionPlanResultView,
  type AssessmentResultView,
  type FundingOpportunity,
  type LandscapePacketView,
  type OpportunityRef,
  type OpportunityRequirementsResponse,
  type OpportunityTimelineResponse,
} from '../funding-opportunities-api.js';
import { FoV2OutcomeModal } from './FoV2OutcomeModal.js';
import { clientInitials, evidenceMark, fitClass, fitFromScore, recChip } from './fo-v2-model.js';

interface ClientLite {
  id: string;
  name: string;
  status?: string;
}

export function FoV2Drawer({
  refValue,
  onClose,
  clients,
  meriEnabled,
  onChanged,
}: {
  refValue: OpportunityRef;
  onClose: () => void;
  clients: ClientLite[];
  meriEnabled: boolean;
  onChanged: () => void;
}) {
  const [full, setFull] = useState(false);
  const [meri, setMeri] = useState(false);
  const [outcomeOpen, setOutcomeOpen] = useState(false);

  const catalog = asCatalogRef(refValue);
  const clientName = clients.find((c) => c.id === refValue.clientId)?.name;

  return (
    <div
      className={`fo-v2-drawer${full ? ' full' : ''}`}
      data-testid="fo-v2-drawer"
      role="complementary"
      aria-label="Opportunity detail"
    >
      <div className="fo-v2-drawer-head">
        <span className="fo-v2-mark fo-v2-mark-20" aria-hidden>
          {clientName ? clientInitials(clientName) : '—'}
        </span>
        <span className="fo-v2-mono-sm">{clientName?.toUpperCase() ?? 'NO CLIENT'}</span>
        <span className="fo-v2-mono-sm" style={{ color: 'var(--fov2-border-strong)' }}>
          /
        </span>
        <span
          className="fo-v2-mono-sm"
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {refValue.sourceRecordId}
        </span>
        <div style={{ flex: 1, minWidth: 6 }} />
        {meriEnabled && catalog && refValue.clientId ? (
          <button
            type="button"
            className={`fo-v2-btn-mono${meri ? ' primary' : ''}`}
            onClick={() => setMeri((m) => !m)}
            aria-pressed={meri}
            data-testid="fo-v2-meri-toggle"
          >
            {meri ? 'MERI OPEN' : 'ASK MERI'}
          </button>
        ) : null}
        <button
          type="button"
          className="fo-v2-icon-btn"
          onClick={() => setFull((f) => !f)}
          aria-label={full ? 'Collapse drawer' : 'Expand drawer'}
        >
          {full ? '⊟' : '⊞'}
        </button>
        <button
          type="button"
          className="fo-v2-icon-btn"
          onClick={onClose}
          aria-label="Close drawer"
        >
          ✕
        </button>
      </div>

      {meri && meriEnabled && catalog && refValue.clientId ? (
        <MeriBody
          source={catalog.source}
          sourceRecordId={catalog.sourceRecordId}
          onBack={() => setMeri(false)}
        />
      ) : catalog ? (
        <DetailBody
          refValue={refValue}
          catalog={{ source: catalog.source, sourceRecordId: catalog.sourceRecordId }}
          clientId={refValue.clientId}
          onOpenOutcome={() => setOutcomeOpen(true)}
          onChanged={onChanged}
        />
      ) : (
        <div style={{ padding: 22 }}>
          <div className="fo-v2-unsupported">
            <div className="fo-v2-unsupported-tag">◈ FORECAST RECORD</div>
            <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--fov2-body)', marginTop: 7 }}>
              An agency forecast has no response deadline, eligibility determination or money. Open
              it from the legacy surface for the forecast-specific body.
            </div>
          </div>
        </div>
      )}

      {outcomeOpen && refValue.clientId && catalog ? (
        <FoV2OutcomeModal
          clientId={refValue.clientId}
          source={catalog.source}
          sourceRecordId={catalog.sourceRecordId}
          title={clientName ?? ''}
          onClose={() => setOutcomeOpen(false)}
          onRecorded={onChanged}
        />
      ) : null}
    </div>
  );
}

/* ── The opportunity body ──────────────────────────────────────────────────── */
function DetailBody({
  refValue,
  catalog,
  clientId,
  onOpenOutcome,
  onChanged,
}: {
  refValue: OpportunityRef;
  catalog: { source: 'grants_gov' | 'sam_gov'; sourceRecordId: string };
  clientId: string | null;
  onOpenOutcome: () => void;
  onChanged: () => void;
}) {
  const api = useApi();
  const { notification } = AntApp.useApp();
  const qc = useQueryClient();

  const landscapeFlag = useIntelFeature(FUNDING_OPPORTUNITIES_LANDSCAPE_FEATURE);
  const documentsFlag = useIntelFeature(FUNDING_OPPORTUNITIES_DOCUMENTS_FEATURE);
  const timelineFlag = useIntelFeature(FUNDING_OPPORTUNITIES_NOTICE_HISTORY_FEATURE);
  const pipelineFlag = useIntelFeature(FUNDING_OPPORTUNITIES_PIPELINE_FEATURE);

  const detail = useQuery<FundingOpportunity>({
    queryKey: ['funding-opportunity-detail', catalog.source, catalog.sourceRecordId, clientId],
    queryFn: async () => {
      const suffix = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
      return (
        await api.get<FundingOpportunity>(
          `/api/intelligence/opportunities/${catalog.source}/${encodeURIComponent(catalog.sourceRecordId)}${suffix}`,
        )
      ).data;
    },
    retry: false,
  });

  const landscape = useQuery<LandscapePacketView>({
    queryKey: ['fo-v2-landscape', catalog.source, catalog.sourceRecordId, clientId],
    queryFn: async () =>
      (
        await api.get<LandscapePacketView>(
          landscapeApiPath(catalog.source, catalog.sourceRecordId, clientId!),
        )
      ).data,
    enabled: landscapeFlag.enabled && Boolean(clientId),
    retry: false,
  });

  const requirements = useQuery<OpportunityRequirementsResponse>({
    queryKey: ['fo-v2-requirements', catalog.source, catalog.sourceRecordId],
    queryFn: async () =>
      (
        await api.get<OpportunityRequirementsResponse>(
          requirementsApiPath(catalog.source, catalog.sourceRecordId),
        )
      ).data,
    enabled: documentsFlag.enabled,
    retry: false,
  });

  const timeline = useQuery<OpportunityTimelineResponse>({
    queryKey: ['fo-v2-timeline', catalog.source, catalog.sourceRecordId],
    queryFn: async () =>
      (
        await api.get<OpportunityTimelineResponse>(
          timelineApiPath(catalog.source, catalog.sourceRecordId),
        )
      ).data,
    enabled: timelineFlag.enabled && catalog.source === 'sam_gov',
    retry: false,
  });

  const plan = useQuery<ActionPlanResultView>({
    queryKey: ['fo-v2-action-plan', catalog.source, catalog.sourceRecordId, clientId],
    queryFn: async () =>
      (
        await api.get<ActionPlanResultView>(
          actionPlanApiPath(catalog.source, catalog.sourceRecordId, clientId!),
        )
      ).data,
    enabled: Boolean(clientId),
    retry: false,
  });

  const decide = useMutation({
    mutationFn: async (decision: 'pursue' | 'monitor' | 'pass') => {
      await api.post(
        `/api/intelligence/clients/${encodeURIComponent(clientId!)}/opportunities/${catalog.source}/${encodeURIComponent(catalog.sourceRecordId)}/decision`,
        { decision },
      );
    },
    onSuccess: (_r, decision) => {
      notification.success({
        message:
          decision === 'pursue' ? 'Pursuing' : decision === 'monitor' ? 'Monitoring' : 'Passed',
      });
      void qc.invalidateQueries({ queryKey: ['funding-opportunity-detail'] });
      void qc.invalidateQueries({ queryKey: ['funding-opportunity-inbox'] });
      onChanged();
    },
    onError: () => notification.error({ message: 'Decision failed' }),
  });

  const acceptPlan = useMutation({
    mutationFn: async () => {
      await api.post(opportunityActionApiPath(clientId!, catalog.source, catalog.sourceRecordId), {
        intent: 'pursuit',
      });
    },
    onSuccess: () => {
      notification.success({ message: 'Pursuit started and tasks created' });
      void qc.invalidateQueries({ queryKey: ['funding-opportunity-inbox'] });
      void qc.invalidateQueries({ queryKey: ['fo-v2-pipeline'] });
      onChanged();
    },
    onError: () => notification.error({ message: 'Could not start the pursuit' }),
  });

  if (detail.isPending) {
    return (
      <div className="fo-v2-drawer-body" style={{ padding: 22 }}>
        <Skeleton active paragraph={{ rows: 10 }} />
      </div>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <div className="fo-v2-drawer-body" style={{ padding: 22 }}>
        <div className="fo-v2-unsupported">
          <div className="fo-v2-unsupported-tag">⚠ FAILED TO LOAD</div>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--fov2-body)', marginTop: 7 }}>
            This is a request failure, not an empty record. Nothing can be concluded about the
            opportunity from it.
          </div>
        </div>
      </div>
    );
  }

  const o = detail.data;
  const chip = recChip(o.recommendation?.machineRecommendation ?? o.workflow?.status);
  const money = moneyLine(o);
  const fit = fitFromScore(o.relevanceScore);
  const ev = evidenceMark(o);
  const eligState = o.eligibility.state;
  const eligOk = eligState === 'eligible';
  const acq: AcquisitionPosition | null = o.acquisitionPosition;
  const cov = landscape.data?.coverage;

  return (
    <div className="fo-v2-drawer-body" data-testid="fo-v2-detail-body">
      {/* Title block */}
      <div style={{ padding: '16px 18px 17px', borderBottom: '1px solid var(--fov2-border)' }}>
        <div className="fo-v2-d-title">{o.title}</div>
        <div className="fo-v2-d-agency">
          {[o.agency, o.subAgency, o.office].filter(Boolean).join(' · ') || 'Agency not stated'}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', marginTop: 11 }}>
          <span className="fo-v2-mono-sm">{SOURCE_LABELS[o.source].toUpperCase()}</span>
          <span className="fo-v2-mono-sm">{KIND_LABELS[o.kind].toUpperCase()}</span>
          <span className="fo-v2-mono-sm">
            {o.responseDeadline
              ? `CLOSES ${o.responseDeadline.slice(0, 10).toUpperCase()}`
              : 'NO DEADLINE STATED'}
          </span>
          <span className="fo-v2-mono-sm">
            {money.label.toUpperCase()} {money.value}
          </span>
        </div>
      </div>

      {/* Recommendation hero */}
      <div className="fo-v2-d-hero">
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, flexWrap: 'wrap' }}>
          <span className={`fo-v2-chip ${chip.cls}`}>{chip.text}</span>
          <span className="fo-v2-mono-sm">
            CONFIDENCE {(o.recommendation?.recommendationConfidence ?? '—').toUpperCase()}
          </span>
          <span className="fo-v2-mono-sm">EVIDENCE QUALITY, NOT WIN PROBABILITY</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11, marginTop: 14 }}>
          <div>
            <div className="fo-v2-d-sub">STRONGEST REASON</div>
            <div className="fo-v2-d-body">
              {o.recommendation?.primaryReason ?? 'No recommendation reason recorded.'}
            </div>
          </div>
          <div>
            <div className="fo-v2-d-sub info">PRIMARY RISK</div>
            <div className="fo-v2-d-body">
              {o.recommendation?.primaryRisk ?? 'No risk recorded at this stage.'}
            </div>
          </div>
          <div>
            <div className="fo-v2-d-sub">RECOMMENDED NEXT ACTION</div>
            <div className="fo-v2-d-body">{o.recommendation?.recommendedNextAction ?? '—'}</div>
          </div>
        </div>
      </div>

      {/* Fit & eligibility */}
      <div className="fo-v2-d-section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="fo-v2-section-head-label">FIT &amp; ELIGIBILITY</span>
          <span style={{ flex: 1, height: 1, background: 'var(--fov2-hairline)' }} />
          <span className={`fo-v2-fit ${fitClass(fit)}`}>{fit.toUpperCase()}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 11 }}>
          {(o.matchedSignals ?? []).map((s, i) => (
            <div key={i} className="fo-v2-ladder-row">
              <span
                className="fo-v2-glyph"
                style={{
                  color:
                    s.strength === 'strong'
                      ? 'var(--fov2-ink)'
                      : s.strength === 'moderate'
                        ? 'var(--fov2-body)'
                        : 'var(--fov2-border-strong)',
                }}
              >
                {s.strength === 'strong' ? '■' : s.strength === 'moderate' ? '◧' : '◇'}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.4, display: 'block' }}
                >
                  {s.signal}
                </span>
                <span
                  className="fo-v2-mono-sm"
                  style={{ display: 'block', marginTop: 3, fontSize: 11.5 }}
                >
                  {s.matchedOn.toUpperCase()}
                </span>
              </span>
              <span
                className="fo-v2-strength"
                style={{
                  color: s.strength === 'strong' ? 'var(--fov2-ink)' : 'var(--fov2-body)',
                  fontWeight: s.strength === 'strong' ? 600 : 500,
                }}
              >
                {s.strength.toUpperCase()}
              </span>
            </div>
          ))}
        </div>
        <div className={`fo-v2-elig ${eligOk ? 'fo-v2-elig-ok' : 'fo-v2-elig-review'}`}>
          <div
            className="fo-v2-mono"
            style={{
              fontSize: 11,
              letterSpacing: '0.06em',
              color: eligOk
                ? 'var(--fov2-success)'
                : eligState === 'ineligible'
                  ? 'var(--fov2-destructive)'
                  : 'var(--fov2-info-ink)',
            }}
          >
            ELIGIBILITY · {eligState.replace('_', ' ').toUpperCase()}
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--fov2-body)', marginTop: 6 }}>
            {o.eligibility.reason}
          </div>
        </div>
      </div>

      {/* Acquisition position */}
      <div className="fo-v2-d-section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="fo-v2-section-head-label">ACQUISITION POSITION</span>
          <span style={{ flex: 1, height: 1, background: 'var(--fov2-hairline)' }} />
          <span
            className="fo-v2-mono-sm"
            style={{ color: acq ? 'var(--fov2-info-ink)' : 'var(--fov2-body)' }}
          >
            {acq ? ACQUISITION_POSITION_LABELS[acq.state].toUpperCase() : 'UNKNOWN'}
          </span>
        </div>
        {acq ? (
          <>
            <div style={{ fontSize: 13.5, lineHeight: 1.6, marginTop: 10 }}>{acq.summary}</div>
            {acq.evidence.length ? (
              <div className="fo-v2-fact-grid">
                {acq.evidence.slice(0, 4).map((e, i) => (
                  <div key={i} className="fo-v2-fact">
                    <div className="fo-v2-fact-k">{e.relationship.toUpperCase()}</div>
                    <div className="fo-v2-fact-v">{e.vehicleName ?? e.tangoVehicleId}</div>
                  </div>
                ))}
              </div>
            ) : null}
            <div
              style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--fov2-body)', marginTop: 10 }}
            >
              A route to the acquisition is not legal eligibility and not a probability of winning.
              Absence of vehicle evidence is recorded, not assumed.
            </div>
          </>
        ) : (
          <div className="fo-v2-col-empty" style={{ marginTop: 11 }}>
            <div className="fo-v2-empty-tag">⊘ NOT YET AVAILABLE</div>
            <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--fov2-body)', marginTop: 7 }}>
              Vehicle and past-performance context is not enabled for this tenant
              {o.source === 'grants_gov'
                ? ', or this is a grant with no contract-vehicle concept'
                : ''}
              , so Capiro cannot say whether this client has a direct route.
            </div>
            <div
              className="fo-v2-mono"
              style={{
                fontSize: 11,
                letterSpacing: '0.05em',
                color: 'var(--fov2-secondary)',
                marginTop: 9,
              }}
            >
              FLAG · FUNDING_OPPORTUNITIES_VEHICLE_FIT
            </div>
          </div>
        )}
      </div>

      {/* Government landscape */}
      <div className="fo-v2-d-section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="fo-v2-section-head-label">GOVERNMENT LANDSCAPE</span>
          <span style={{ flex: 1, height: 1, background: 'var(--fov2-hairline)' }} />
          <span className="fo-v2-mono-sm">
            {cov
              ? `COVERAGE ${cov.available} OF ${cov.declared} SOURCES`
              : landscapeFlag.enabled
                ? '—'
                : 'FLAG OFF'}
          </span>
        </div>
        {!landscapeFlag.enabled ? (
          <DisabledPanel
            flag="FUNDING_OPPORTUNITIES_GOVERNMENT_LANDSCAPE"
            what="PE linkage, legislation, relationships and client priorities tied to this opportunity."
          />
        ) : (landscape.data?.items ?? []).length === 0 ? (
          <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--fov2-body)', marginTop: 10 }}>
            {landscape.isPending
              ? 'Loading landscape…'
              : 'No landscape item links to this opportunity. That is a finding, not a gap in coverage.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', marginTop: 10 }}>
            {landscape.data!.items.map((l, i) => (
              <div key={i} className="fo-v2-land-row">
                <span className={`fo-v2-land-tag ${l.basis === 'source_backed' ? 'ok' : 'warn'}`}>
                  {l.basis === 'source_backed' ? 'VERIFIED' : 'INFERRED'}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.4, display: 'block' }}
                  >
                    {l.label}
                  </span>
                  <span
                    style={{
                      fontSize: 12.5,
                      lineHeight: 1.55,
                      color: 'var(--fov2-body)',
                      display: 'block',
                      marginTop: 3,
                    }}
                  >
                    {LANDSCAPE_SOURCE_LABELS[l.source] ?? l.source} · matched on {l.matchedOn}
                  </span>
                  {l.evidenceRef ? (
                    <span
                      className="fo-v2-mono-sm"
                      style={{ display: 'block', marginTop: 4, fontSize: 11 }}
                    >
                      {l.evidenceRef.toUpperCase()}
                    </span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Requirements & documents */}
      <div className="fo-v2-d-section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="fo-v2-section-head-label">REQUIREMENTS &amp; DOCUMENTS</span>
          <span style={{ flex: 1, height: 1, background: 'var(--fov2-hairline)' }} />
          <span className="fo-v2-mono-sm">
            {requirements.data
              ? `${requirements.data.requirements.length} EXTRACTED`
              : documentsFlag.enabled
                ? '—'
                : 'FLAG OFF'}
          </span>
        </div>
        {!documentsFlag.enabled ? (
          <DisabledPanel
            flag="FUNDING_OPPORTUNITIES_DOCUMENTS"
            what="Attachments are archived and hashed; extracted requirement text is not entitled on the current tier."
          />
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: 10 }}>
              {(requirements.data?.requirements ?? []).slice(0, 8).map((r) => (
                <div key={r.id} className="fo-v2-doc-row">
                  <span aria-hidden style={{ flex: 'none', fontSize: 12 }}>
                    ▤
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 13,
                      fontWeight: 500,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {r.statement}
                  </span>
                  <span className="fo-v2-mono-sm" style={{ flex: 'none', fontSize: 11 }}>
                    {r.fileName ?? 'ATTACHMENT'}
                  </span>
                  <span
                    className={`fo-v2-state-chip fo-v2-state-${r.reviewStatus === 'accepted' ? 'ok' : r.reviewStatus === 'rejected' ? 'bad' : 'quiet'}`}
                  >
                    {r.reviewStatus.toUpperCase()}
                  </span>
                </div>
              ))}
            </div>
            {requirements.data && requirements.data.coverage !== 'available' ? (
              <div className="fo-v2-col-empty" style={{ marginTop: 12 }}>
                <div className="fo-v2-empty-tag">
                  ⊘ {requirements.data.coverage.replace(/_/g, ' ').toUpperCase()}
                </div>
                <div
                  style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--fov2-body)', marginTop: 7 }}
                >
                  {requirements.data.coverageExplanation}
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Timeline */}
      <div className="fo-v2-d-section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="fo-v2-section-head-label">TIMELINE</span>
          <span style={{ flex: 1, height: 1, background: 'var(--fov2-hairline)' }} />
          <span className="fo-v2-mono-sm">
            {timeline.data
              ? `${timeline.data.entries.length} NOTICES · ${timeline.data.changeCount} CHANGES`
              : timelineFlag.enabled
                ? '—'
                : 'FLAG OFF'}
          </span>
        </div>
        {!timelineFlag.enabled ? (
          <DisabledPanel
            flag="FUNDING_OPPORTUNITIES_NOTICE_HISTORY"
            what="Amendment timeline with before and after values for deadline, NAICS, set-aside and closure."
          />
        ) : catalog.source !== 'sam_gov' ? (
          <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--fov2-body)', marginTop: 10 }}>
            The material-change timeline covers SAM.gov notices. Grants.gov assistance records carry
            no per-notice amendment history in this build.
          </div>
        ) : (timeline.data?.entries ?? []).length === 0 ? (
          <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--fov2-body)', marginTop: 10 }}>
            {timeline.data?.coverageExplanation ?? 'Loading timeline…'}
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              marginTop: 11,
              position: 'relative',
            }}
          >
            {timeline.data!.entries.map((t, i, arr) => {
              const delta = t.changes.length > 0;
              return (
                <div key={t.tangoNoticeId} className="fo-v2-tl-row">
                  <span className="fo-v2-tl-rail">
                    <span className={`fo-v2-tl-dot ${delta ? 'delta' : 'plain'}`} aria-hidden />
                    {i < arr.length - 1 ? <span className="fo-v2-tl-line" aria-hidden /> : null}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, position: 'relative', top: -3 }}>
                    <span className="fo-v2-mono-sm" style={{ display: 'block' }}>
                      {(t.postedDate ?? t.providerUpdatedAt ?? '').slice(0, 10).toUpperCase()}
                    </span>
                    <span
                      style={{
                        fontSize: 13.5,
                        fontWeight: 600,
                        lineHeight: 1.4,
                        display: 'block',
                        marginTop: 3,
                      }}
                    >
                      {t.title ?? 'Notice'}
                    </span>
                    {t.changes.map((c, ci) => (
                      <span
                        key={ci}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          marginTop: 5,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span
                          className="fo-v2-mono"
                          style={{
                            fontSize: 11.5,
                            color: 'var(--fov2-secondary)',
                            textDecoration: 'line-through',
                          }}
                        >
                          {c.before ?? '—'}
                        </span>
                        <span
                          className="fo-v2-mono"
                          style={{ fontSize: 11.5, color: 'var(--fov2-border-strong)' }}
                        >
                          →
                        </span>
                        <span
                          className="fo-v2-mono"
                          style={{ fontSize: 11.5, color: 'var(--fov2-ink)', fontWeight: 600 }}
                        >
                          {c.after ?? '—'}
                        </span>
                      </span>
                    ))}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pursuit plan */}
      <div className="fo-v2-d-section alt">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="fo-v2-section-head-label">PURSUIT PLAN</span>
          <span style={{ flex: 1, height: 1, background: 'var(--fov2-border)' }} />
          <span className="fo-v2-mono-sm">
            STAGE · {(o.workflow?.status ?? 'SUGGESTED').toUpperCase()}
          </span>
        </div>
        <div
          className="fo-v2-fact-grid"
          style={{
            background: 'var(--fov2-border)',
            border: '1px solid var(--fov2-border)',
            marginTop: 11,
          }}
        >
          <div className="fo-v2-fact">
            <div className="fo-v2-fact-k">HUMAN DECISION</div>
            <div className="fo-v2-fact-v">
              {o.decision ? o.decision.decision.toUpperCase() : 'None recorded'}
            </div>
          </div>
          <div className="fo-v2-fact">
            <div className="fo-v2-fact-k">OWNER</div>
            <div className="fo-v2-fact-v">
              {o.workflow?.owner?.name ?? o.workflow?.owner?.email ?? 'Unassigned'}
            </div>
          </div>
          <div className="fo-v2-fact">
            <div className="fo-v2-fact-k">NEXT ACTION DUE</div>
            <div className="fo-v2-fact-v">
              {o.decision?.nextActionDueAt?.slice(0, 10).toUpperCase() ?? '—'}
            </div>
          </div>
          <div className="fo-v2-fact">
            <div className="fo-v2-fact-k">DECIDED</div>
            <div className="fo-v2-fact-v">
              {o.decision?.decidedAt?.slice(0, 10).toUpperCase() ?? '—'}
            </div>
          </div>
        </div>

        {plan.data?.state === 'available' && plan.data.plan && plan.data.plan.actions.length ? (
          <>
            <div className="fo-v2-d-sub" style={{ marginTop: 14 }}>
              PROPOSED ACTIONS
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: 7 }}>
              {plan.data.plan.actions.map((a) => (
                <div key={a.id} className="fo-v2-action-row">
                  <span className="fo-v2-action-box" aria-hidden />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.4, display: 'block' }}
                    >
                      {a.title}
                    </span>
                    <span
                      style={{
                        fontSize: 12.5,
                        lineHeight: 1.5,
                        color: 'var(--fov2-body)',
                        display: 'block',
                        marginTop: 3,
                      }}
                    >
                      {a.rationale}
                    </span>
                  </span>
                  <span className="fo-v2-mono-sm" style={{ flex: 'none' }}>
                    {a.dueDate ? a.dueDate.slice(0, 10).toUpperCase() : ''}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {clientId ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 14 }}>
            <button
              type="button"
              className="fo-v2-btn fo-v2-btn-primary"
              disabled={acceptPlan.isPending || decide.isPending}
              onClick={() => acceptPlan.mutate()}
              data-testid="fo-v2-accept-plan"
            >
              Accept plan and create tasks
            </button>
            <button
              type="button"
              className="fo-v2-btn fo-v2-btn-outline-strong"
              disabled={decide.isPending}
              onClick={() => decide.mutate('monitor')}
            >
              Monitor
            </button>
            <button
              type="button"
              className="fo-v2-btn fo-v2-btn-outline-strong"
              disabled={decide.isPending}
              onClick={() => decide.mutate('pass')}
            >
              Pass
            </button>
            {pipelineFlag.enabled ? (
              <button
                type="button"
                className="fo-v2-btn fo-v2-btn-outline-strong"
                onClick={onOpenOutcome}
              >
                Record outcome
              </button>
            ) : null}
          </div>
        ) : null}
        <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--fov2-body)', marginTop: 11 }}>
          Accepting an action creates the task and moves the pursuit in one transaction. A retry
          with the same action returns the same task.
        </div>
      </div>

      {/* Source record */}
      <div style={{ padding: '15px 18px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="fo-v2-section-head-label">SOURCE RECORD</span>
          <span style={{ flex: 1, height: 1, background: 'var(--fov2-hairline)' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 9 }}>
          {[
            ['SOURCE SYSTEM', SOURCE_LABELS[o.source].toUpperCase()],
            ['RECORD ID', o.sourceRecordId],
            o.sourceReference ? ['REFERENCE', o.sourceReference] : null,
            o.postedDate ? ['POSTED', o.postedDate.slice(0, 10).toUpperCase()] : null,
            o.sourceUpdatedAt
              ? ['SOURCE UPDATED', o.sourceUpdatedAt.slice(0, 10).toUpperCase()]
              : null,
            o.naicsCodes.length ? ['NAICS', o.naicsCodes.join(', ')] : null,
            o.pscCodes.length ? ['PSC', o.pscCodes.join(', ')] : null,
            o.setAside ? ['SET-ASIDE', o.setAside] : null,
          ]
            .filter((r): r is [string, string] => r != null)
            .map(([k, v]) => (
              <div key={k} className="fo-v2-prov-row">
                <span className="fo-v2-mono-sm" style={{ flex: 'none' }}>
                  {k}
                </span>
                <span
                  className="fo-v2-mono"
                  style={{
                    fontSize: 11.5,
                    color: 'var(--fov2-ink)',
                    textAlign: 'right',
                    wordBreak: 'break-word',
                  }}
                >
                  {v}
                </span>
              </div>
            ))}
        </div>
        {o.sourceUrl ? (
          <div style={{ marginTop: 13 }}>
            <a
              href={o.sourceUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                fontSize: 12.5,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                color: 'var(--fov2-ink)',
              }}
            >
              Open the record at the source ↗
            </a>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* The flag-off dashed panel, repeated for each unentitled capability. */
function DisabledPanel({ flag, what }: { flag: string; what: string }) {
  return (
    <div className="fo-v2-col-empty" style={{ marginTop: 11 }}>
      <div className="fo-v2-empty-tag">⊘ NOT YET AVAILABLE</div>
      <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--fov2-body)', marginTop: 7 }}>
        {what}
      </div>
      <div
        className="fo-v2-mono"
        style={{
          fontSize: 11,
          letterSpacing: '0.05em',
          color: 'var(--fov2-secondary)',
          marginTop: 9,
        }}
      >
        FLAG · {flag}
      </div>
    </div>
  );
}

/* ── The governed Meri assessment body (P38) ───────────────────────────────── */
function MeriBody({
  source,
  sourceRecordId,
  onBack,
}: {
  source: 'grants_gov' | 'sam_gov';
  sourceRecordId: string;
  onBack: () => void;
}) {
  const api = useApi();
  // A POST, not a GET: producing an assessment calls a model and writes an audit
  // artifact. It runs only when the user opens Meri, never on drawer open.
  const assessment = useMutation<AssessmentResultView>({
    mutationFn: async () =>
      (await api.post<AssessmentResultView>(assessmentApiPath(source, sourceRecordId), {})).data,
  });

  // Fire once on mount — a POST that calls a model and writes an audit artifact.
  useEffect(() => {
    assessment.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const result = assessment.data;

  return (
    <div className="fo-v2-drawer-body" data-testid="fo-v2-meri-body">
      <div style={{ padding: '16px 18px 18px', borderBottom: '1px solid var(--fov2-border)' }}>
        <button type="button" className="fo-v2-btn-mono" onClick={onBack}>
          ← BACK TO PURSUIT PLAN
        </button>
        <div
          style={{
            fontSize: 18,
            fontWeight: 700,
            lineHeight: 1.28,
            marginTop: 13,
            letterSpacing: '-0.014em',
          }}
        >
          Meri assessment
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--fov2-body)', marginTop: 6 }}>
          Meri read the same deterministic packet shown in this drawer. It cannot change the
          recommendation, and every claim below is checked against the packet.
        </div>
      </div>

      {assessment.isPending ? (
        <div style={{ padding: 22 }}>
          <Skeleton active paragraph={{ rows: 6 }} />
        </div>
      ) : !result || result.state !== 'available' ? (
        <div style={{ padding: '15px 18px' }}>
          <div className="fo-v2-unsupported">
            <div className="fo-v2-unsupported-tag">
              ⊘{' '}
              {result && 'state' in result
                ? result.state.replace(/_/g, ' ').toUpperCase()
                : 'UNAVAILABLE'}
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--fov2-body)', marginTop: 7 }}>
              {result && 'explanation' in result
                ? result.explanation
                : 'The assessment could not be produced. This is not a judgement on the opportunity.'}
            </div>
          </div>
        </div>
      ) : (
        <MeriAssessmentBody result={result} />
      )}
    </div>
  );
}

function MeriAssessmentBody({
  result,
}: {
  result: Extract<AssessmentResultView, { state: 'available' }>;
}) {
  const a = result.assessment;
  const held = a.claims.filter((c) => c.verdict === 'held' || c.verdict === 'rejected');
  return (
    <>
      {a.incomplete ? (
        <div
          style={{
            padding: '14px 18px 16px',
            borderBottom: '1px solid var(--fov2-hairline)',
            background: 'var(--fov2-raised)',
          }}
        >
          <div className="fo-v2-d-sub">INCOMPLETE</div>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--fov2-ink)', marginTop: 7 }}>
            {a.incompleteReasons.join(' ')}
          </div>
        </div>
      ) : null}

      <div style={{ padding: '15px 18px 17px', borderBottom: '1px solid var(--fov2-hairline)' }}>
        <div className="fo-v2-d-sub">ASSESSMENT</div>
        {a.nextThreeActions.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 9 }}>
            {a.nextThreeActions.map((t, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    background: 'var(--fov2-border-strong)',
                    flex: 'none',
                    position: 'relative',
                    top: -1,
                  }}
                  aria-hidden
                />
                <span style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--fov2-body)' }}>
                  {t}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {Object.values(a.sections)
          .flat()
          .map((p, i) => (
            <div
              key={i}
              style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--fov2-ink)', marginTop: 10 }}
            >
              {p}
            </div>
          ))}
      </div>

      {held.length ? (
        <div style={{ padding: '15px 18px 17px', borderBottom: '1px solid var(--fov2-hairline)' }}>
          <div className="fo-v2-unsupported">
            <div className="fo-v2-unsupported-tag">⚠ UNSUPPORTED CLAIM · HELD FROM THE DRAFT</div>
            {held.map((c, i) => (
              <div
                key={i}
                style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--fov2-ink)', marginTop: 8 }}
              >
                {c.text}
                {c.holdReason ? (
                  <div
                    style={{
                      fontSize: 12.5,
                      lineHeight: 1.55,
                      color: 'var(--fov2-body)',
                      marginTop: 4,
                    }}
                  >
                    {c.holdReason}
                  </div>
                ) : null}
              </div>
            ))}
            <div
              style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--fov2-body)', marginTop: 8 }}
            >
              Held claims are separated here rather than deleted. Approval is blocked until each is
              removed or annotated with a source.
            </div>
          </div>
        </div>
      ) : null}

      <div style={{ padding: '15px 18px 22px' }}>
        <div className="fo-v2-d-sub">COMMIT</div>
        <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--fov2-body)', marginTop: 8 }}>
          Nothing Meri writes is committed from this drawer. Saving to the client, inserting into a
          briefing and proposing to memory are separate governed actions, each repeating tenant and
          client in its confirmation.
        </div>
      </div>
    </>
  );
}
