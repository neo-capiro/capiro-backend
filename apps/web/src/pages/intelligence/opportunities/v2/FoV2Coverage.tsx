/**
 * Funding Opportunities v2 — Coverage & profiles.
 *
 * The mockup's Coverage tab: the "Source & capability register" — every capability
 * separately flag-gated, showing state, freshness and what it changes — built from
 * the REAL feature flags and the source freshness rails.
 *
 * The mockup's lower "Identity & profile review" (proposed profile changes,
 * identity basis by client, producer coverage) has NO backend endpoint; its data in
 * the mockup is invented. Per the v2 evidence-honesty rule it renders as a static
 * dashed "not enabled" panel rather than a fabricated interactive review.
 */
import { formatFreshness, type OpportunitySourceFreshness } from '../funding-opportunities-api.js';

interface CoverageFlags {
  documents: boolean;
  landscape: boolean;
  budget: boolean;
  risk: boolean;
  meri: boolean;
  noticeHistory: boolean;
  forecasts: boolean;
  pipeline: boolean;
}

interface CapRow {
  name: string;
  flag: string;
  state: string;
  sk: 'ok' | 'info' | 'warn' | 'off' | 'quiet';
  fresh: string;
  fk: 'ok' | 'warn' | 'quiet';
  note: string;
}

export function FoV2Coverage({
  freshness,
  flags,
}: {
  freshness: OpportunitySourceFreshness[];
  flags: CoverageFlags;
}) {
  const rail = (src: string) => freshness.find((f) => f.source === src);
  const railFresh = (src: string): { fresh: string; fk: 'ok' | 'warn' | 'quiet' } => {
    const f = rail(src);
    if (!f) return { fresh: 'NO DATA', fk: 'quiet' };
    if (f.lastRunStatus === 'error') return { fresh: 'STALE', fk: 'warn' };
    if (f.neverSynced) return { fresh: 'NEVER SYNCED', fk: 'quiet' };
    return { fresh: f.lastSyncedAt ? 'FRESH' : 'UNKNOWN', fk: 'ok' };
  };

  const sam = railFresh('sam_gov');
  const grants = railFresh('grants_gov');

  const caps: CapRow[] = [
    {
      name: 'SAM.gov contract notices',
      flag: 'FIRST-PARTY RAIL',
      state: 'LIVE',
      sk: 'ok',
      fresh: sam.fresh,
      fk: sam.fk,
      note: 'Source of record for contract notices, deadlines and lifecycle.',
    },
    {
      name: 'Grants.gov assistance notices',
      flag: 'FIRST-PARTY RAIL',
      state: 'LIVE',
      sk: 'ok',
      fresh: grants.fresh,
      fk: grants.fk,
      note: 'Source of record for grant eligibility criteria, cost share and application windows.',
    },
    {
      name: 'Notice history & change timeline',
      flag: 'funding_opportunities_notice_history',
      state: flags.noticeHistory ? 'LIVE' : 'OFF',
      sk: flags.noticeHistory ? 'ok' : 'off',
      fresh: flags.noticeHistory ? 'FRESH' : 'NO DATA',
      fk: flags.noticeHistory ? 'ok' : 'quiet',
      note: 'Amendment timeline with before and after values for deadline, NAICS, set-aside and closure.',
    },
    {
      name: 'Attachments & requirement extraction',
      flag: 'funding_opportunities_documents',
      state: flags.documents ? 'LIVE' : 'OFF',
      sk: flags.documents ? 'ok' : 'off',
      fresh: flags.documents ? 'AVAILABLE' : 'NO DATA',
      fk: flags.documents ? 'ok' : 'quiet',
      note: 'Attachments are archived and hashed; requirement text is extracted where the tier allows.',
    },
    {
      name: 'Government landscape',
      flag: 'funding_opportunities_government_landscape',
      state: flags.landscape ? 'LIVE' : 'OFF',
      sk: flags.landscape ? 'ok' : 'off',
      fresh: flags.landscape ? 'AVAILABLE' : 'NO DATA',
      fk: flags.landscape ? 'ok' : 'quiet',
      note: 'PE linkage, legislation, relationships and client priorities tied to the opportunity.',
    },
    {
      name: 'Pursuit pipeline board',
      flag: 'funding_opportunities_pipeline_v2',
      state: flags.pipeline ? 'LIVE' : 'OFF',
      sk: flags.pipeline ? 'ok' : 'off',
      fresh: flags.pipeline ? 'AVAILABLE' : 'NO DATA',
      fk: flags.pipeline ? 'ok' : 'quiet',
      note: 'The human stage board. A machine recommendation never moves a stage.',
    },
    {
      name: 'Agency forecasts (early signals)',
      flag: 'funding_opportunities_forecasts',
      state: flags.forecasts ? 'LIVE' : 'NOT YET AVAILABLE',
      sk: flags.forecasts ? 'ok' : 'off',
      fresh: flags.forecasts ? 'AVAILABLE' : 'NO DATA',
      fk: 'quiet',
      note: 'Pre-solicitation signals with anticipated award dates. Forecasts are opportunities to shape, never solicitations to submit.',
    },
    {
      name: 'Protest & exclusion risk',
      flag: 'funding_opportunities_risk_context',
      state: flags.risk ? 'LIVE' : 'OFF',
      sk: flags.risk ? 'info' : 'off',
      fresh: flags.risk ? 'AVAILABLE' : 'NO DATA',
      fk: 'quiet',
      note: 'Exclusion evidence blocks a pursuit pending review. Absence of an exclusion is never shown as proof of good standing.',
    },
    {
      name: 'Budget account context (beta)',
      flag: 'funding_opportunities_budget_context',
      state: flags.budget ? 'CANARY' : 'NOT YET AVAILABLE',
      sk: flags.budget ? 'info' : 'off',
      fresh: flags.budget ? 'AVAILABLE' : 'NO DATA',
      fk: 'quiet',
      note: 'Federal-account execution context. It sits beside Program Element funding, never replaces it.',
    },
    {
      name: 'Meri opportunity assessment',
      flag: 'funding_opportunities_meri_v2',
      state: flags.meri ? 'LIVE' : 'OFF',
      sk: flags.meri ? 'ok' : 'off',
      fresh: flags.meri ? 'AVAILABLE' : 'NO DATA',
      fk: 'quiet',
      note: 'A governed assessment over the deterministic packet. It cannot change the recommendation.',
    },
  ];

  return (
    <div className="fo-v2-coverage" data-testid="fo-v2-coverage">
      <div className="fo-v2-coverage-inner">
        <div className="fo-v2-section-head">
          <span className="fo-v2-section-head-label">SOURCE &amp; CAPABILITY REGISTER</span>
          <span className="fo-v2-section-head-rule" />
          <span className="fo-v2-section-head-note">EVERY CAPABILITY IS SEPARATELY FLAG-GATED</span>
        </div>
        <div
          style={{
            fontSize: 13.5,
            lineHeight: 1.6,
            color: 'var(--fov2-body)',
            marginTop: 9,
            maxWidth: 720,
          }}
        >
          What Capiro can currently see, and what it cannot. A capability that is off shows what it
          will add and why it is unavailable — it is never rendered as an empty result set.
        </div>

        <div
          style={{
            border: '1px solid var(--fov2-border)',
            background: 'var(--fov2-surface)',
            marginTop: 16,
          }}
        >
          <div className="fo-v2-cap-grid-head">
            <div className="fo-v2-th" style={{ padding: '9px 15px' }}>
              CAPABILITY
            </div>
            <div className="fo-v2-th" style={{ padding: '9px 15px' }}>
              STATE
            </div>
            <div className="fo-v2-th" style={{ padding: '9px 15px' }}>
              FRESHNESS
            </div>
            <div className="fo-v2-th" style={{ padding: '9px 15px' }}>
              WHAT IT CHANGES IN THIS TAB
            </div>
          </div>
          {caps.map((c) => (
            <div key={c.flag} className="fo-v2-cap-grid-row">
              <div style={{ padding: '11px 15px', minWidth: 0 }}>
                <div className="fo-v2-cap-name">{c.name}</div>
                <div className="fo-v2-cap-flag">{c.flag}</div>
              </div>
              <div style={{ padding: '11px 15px' }}>
                <span className={`fo-v2-state-chip fo-v2-state-${c.sk}`}>{c.state}</span>
              </div>
              <div
                style={{
                  padding: '11px 15px',
                  fontFamily: 'var(--fov2-mono)',
                  fontSize: 11.5,
                  color:
                    c.fk === 'ok'
                      ? 'var(--fov2-success)'
                      : c.fk === 'warn'
                        ? 'var(--fov2-info-ink)'
                        : 'var(--fov2-secondary)',
                }}
              >
                {c.fresh}
              </div>
              <div
                style={{
                  padding: '11px 15px',
                  fontSize: 12.5,
                  lineHeight: 1.55,
                  color: 'var(--fov2-body)',
                }}
              >
                {c.note}
              </div>
            </div>
          ))}
        </div>

        {/* Identity & profile review — no backend; rendered as an honest dashed panel. */}
        <div className="fo-v2-section-head" style={{ marginTop: 30 }}>
          <span className="fo-v2-section-head-label">IDENTITY &amp; PROFILE REVIEW</span>
          <span className="fo-v2-section-head-rule" />
          <span className="fo-v2-section-head-note">ADMIN ONLY</span>
        </div>
        <div
          className="fo-v2-col-empty"
          style={{ marginTop: 14, maxWidth: 560 }}
          data-testid="fo-v2-identity-unavailable"
        >
          <div className="fo-v2-empty-tag">⊘ NOT YET AVAILABLE</div>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--fov2-body)', marginTop: 7 }}>
            Proposed profile changes, identity basis by client and producer coverage have no backend
            in this build. Nothing is shown here rather than an invented review queue — accepting or
            rejecting a profile change is a governed write this surface does not fake.
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
            FLAG · NOT WIRED
          </div>
        </div>
      </div>
    </div>
  );
}
