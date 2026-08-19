/**
 * Congressional activity — native vNext port of
 * `pages/program-element/ProvisionsPanel.tsx` (Step 2.4). Accepted provisions
 * render plainly; candidate provisions carry a "Candidate — review" badge so
 * unreviewed extractions are never implied to be confirmed. Honest empty state.
 */
import type { ProvisionItem } from '../../../../pages/program-element/types.js';
import {
  PeFbEmpty,
  PeFbExpandableText,
  PeFbPanel,
  PeFbSecondaryFailed,
  PeFbSkeleton,
  PeFbTag,
} from './pe-fallback-ui.js';

export interface ProvisionsPanelVNextProps {
  provisions: ProvisionItem[] | null | undefined;
  loading?: boolean;
  errored?: boolean;
  onRetry?: () => void;
}

const COMMITTEE_LABEL: Record<string, string> = {
  hasc: 'HASC',
  sasc: 'SASC',
  hac_d: 'HAC-D',
  sac_d: 'SAC-D',
  conference: 'Conference',
};

const ACTION_TYPE_LABEL: Record<string, string> = {
  directs_briefing: 'Directs briefing',
  directs_report: 'Directs report',
  adds: 'Adds',
  cuts: 'Cuts',
  transfers: 'Transfers',
  restricts: 'Restricts',
  encourages: 'Encourages',
  expresses_concern: 'Expresses concern',
};

const ACTION_TYPE_COLOR: Record<string, string> = {
  directs_briefing: 'blue',
  directs_report: 'blue',
  adds: 'green',
  cuts: 'red',
  transfers: 'gold',
  restricts: 'volcano',
  encourages: 'cyan',
  expresses_concern: 'orange',
};

/** Human label for a committee code (falls back to the raw value). */
export function committeeLabel(committee: string): string {
  return COMMITTEE_LABEL[committee] ?? committee.toUpperCase();
}

/** Human label for an actionType (or "—" when null/unknown). */
export function actionTypeLabel(actionType: string | null): string {
  if (!actionType) return '—';
  return ACTION_TYPE_LABEL[actionType] ?? actionType;
}

/** Tag color for an actionType (defaults to the neutral tag). */
export function actionTypeColor(actionType: string | null): string {
  if (!actionType) return 'default';
  return ACTION_TYPE_COLOR[actionType] ?? 'default';
}

/** Open-at-page deep link for a provision (sourceUrl + #page= when present). */
function provisionHref(p: ProvisionItem): string | null {
  if (!p.sourceUrl) return null;
  return p.pageStart ? `${p.sourceUrl}#page=${p.pageStart}` : p.sourceUrl;
}

export function PeProvisionsPanelVNext({
  provisions,
  loading = false,
  errored = false,
  onRetry,
}: ProvisionsPanelVNextProps) {
  if (loading) {
    return (
      <PeFbPanel title="Congressional activity">
        <PeFbSkeleton rows={3} />
      </PeFbPanel>
    );
  }

  if (errored) {
    return (
      <PeFbSecondaryFailed label="congressional provisions" testId="pe-secondary-failed-provisions" onRetry={onRetry} />
    );
  }

  const rows = Array.isArray(provisions) ? provisions : [];

  if (rows.length === 0) {
    return (
      <PeFbPanel className="pe-fb-provisions-card" title="Congressional activity">
        <PeFbEmpty description="No congressional report language linked to this PE yet — populated once report provisions are extracted." />
      </PeFbPanel>
    );
  }

  return (
    <PeFbPanel className="pe-fb-provisions-card" title={`Congressional activity · ${rows.length}`}>
      <p className="pe-fb-muted" style={{ marginBottom: 8, fontSize: 12 }}>
        Report language from the defense authorization and appropriations committees that touches
        this Program Element — what each committee directed, added, cut, or flagged, with a deep
        link into the report page. Candidate rows are machine-extracted and await review.
        Program-level matches name a broader program (not this PE code alone) and carry an
        attribution caveat so they are never quoted as exclusive to this PE.
      </p>

      <div className="pe-fb-row-list">
        {rows.map((p) => {
          const href = provisionHref(p);
          return (
            <div key={p.id} className="pe-fb-row-item">
              <div className="pe-fb-tag-row" style={{ marginBottom: 4 }}>
                <PeFbTag color="geekblue">{committeeLabel(p.committee)}</PeFbTag>
                <PeFbTag color={actionTypeColor(p.actionType)}>{actionTypeLabel(p.actionType)}</PeFbTag>
                <PeFbTag>FY{p.fy}</PeFbTag>
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer">
                    {p.pageStart ? `p. ${p.pageStart}` : 'Open source'}
                  </a>
                ) : null}
                {p.reviewStatus === 'candidate' ? (
                  <PeFbTag color="gold">Candidate — review</PeFbTag>
                ) : null}
                {p.matchScope === 'program_level' ? (
                  <PeFbTag color="purple" data-testid="pe-provision-program-scope">
                    Program-level match
                  </PeFbTag>
                ) : p.matchScope === 'pe_specific' ? (
                  <PeFbTag data-testid="pe-provision-pe-scope">PE-specific</PeFbTag>
                ) : null}
              </div>
              {p.attributionCaveat ? (
                <p
                  style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--capiro-color-text-warning)' }}
                  data-testid="pe-provision-attribution-caveat"
                >
                  {p.attributionCaveat}
                </p>
              ) : null}
              <div>
                <strong>{p.heading}</strong>
              </div>
              {p.text ? (
                <PeFbExpandableText text={p.text} rows={3} className="pe-fb-muted-text" />
              ) : null}
            </div>
          );
        })}
      </div>
    </PeFbPanel>
  );
}
