import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeftOutlined, CloseOutlined, ExportOutlined } from '@ant-design/icons';
import { Empty, Skeleton } from 'antd';
import { BILL_DOSSIER_SECTIONS, BILL_DOSSIER_SECTION_LABELS, type BillDossierSection } from '@capiro/shared';
import { DossierKpiStrip } from '../../components/dossier/DossierKpiStrip.js';
import { BillDossierHero, decorateKpis } from './BillDossierHero.js';
import { Bill360Export } from './Bill360Export.js';
import { useBillDossier } from './bill-360-api.js';
import { BillOverviewTab } from './BillOverviewTab.js';
import { BillPathVotesTab } from './BillPathVotesTab.js';
import { BillFundingTab } from './BillFundingTab.js';
import { BillProvisionsTab } from './BillProvisionsTab.js';
import { BillImpactTab } from './BillImpactTab.js';
import { BillHearingsTab } from './BillHearingsTab.js';
import { BillEvidenceTab } from './BillEvidenceTab.js';
import '../../components/dossier/dossier.css';

/**
 * The Bill 360 dossier body — the SAME content in a drawer or a full page. It
 * renders its own chrome (Bill 360 eyebrow, Track, Open full page / Back, close)
 * to match the prototype, then the hero, the 6-KPI strip, the 7-tab bar, and the
 * active tab. Reused by BillDrawer (drawer mode, flag-gated) and Bill360Page
 * (page mode). All facts carry a provenance badge; funding shows a grounded empty
 * state until R3.
 */
export function BillDossierBody({
  billId,
  clientId,
  mode,
  isTracked,
  onTrack,
  onClose,
  onOpenBill,
}: {
  billId: string;
  clientId?: string | null;
  mode: 'drawer' | 'page';
  isTracked?: boolean;
  onTrack?: (billId: string) => void;
  onClose?: () => void;
  /**
   * Swap the dossier to another bill IN PLACE. Supplied in drawer mode so a
   * related-vehicle click stays inside LegiWatch (prototype: `openBill(id,
   * dz.mode, scope)` keeps the current mode). Omitted in page mode → navigate.
   */
  onOpenBill?: (billId: string) => void;
}) {
  const navigate = useNavigate();
  const query = useBillDossier(billId, clientId ?? null);
  const [tab, setTab] = useState<BillDossierSection>('overview');

  // Swapping bills in place (related vehicle, like-for-like comparison) returns to
  // Overview, exactly as the prototype's openBill() resets `tab`.
  useEffect(() => setTab('overview'), [billId]);

  const clientSuffix = clientId ? `?client=${encodeURIComponent(clientId)}` : '';
  const openBill = (id: string) => {
    if (onOpenBill) {
      onOpenBill(id);
      return;
    }
    navigate(`/bills/${encodeURIComponent(id)}${clientSuffix}`);
  };
  const openPe = (pe: string) => navigate(`/program-elements/${encodeURIComponent(pe)}`);
  const openFull = () => {
    onClose?.();
    navigate(`/bills/${encodeURIComponent(billId)}${clientSuffix}`);
  };

  const d = query.data ?? null;
  const tracked = isTracked ?? d?.tracking?.tracked ?? false;

  return (
    <div className="dossier" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="dsr-chrome">
        {mode === 'page' && onClose ? (
          <button type="button" className="dsr-btn" onClick={onClose}>
            <ArrowLeftOutlined /> Back
          </button>
        ) : null}
        <span className="dsr-eyebrow">Bill 360</span>
        <span className="dsr-chrome-spacer" />
        {/* Export (R4 §4.5). The prototype has no export affordance, so this reuses
            the prototype's own chrome-button treatment to stay visually part of the
            same bar. Only offered once the dossier has loaded — there is nothing to
            export from a skeleton. */}
        {d ? <Bill360Export dossier={d} /> : null}
        {mode === 'drawer' ? (
          <button type="button" className="dsr-btn" onClick={openFull}>
            <ExportOutlined /> Open full page
          </button>
        ) : null}
        {onTrack ? (
          <button
            type="button"
            className={`dsr-btn ${tracked ? 'tracked' : 'track'}`}
            onClick={() => onTrack(billId)}
          >
            {tracked ? 'Tracked' : 'Track bill'}
          </button>
        ) : null}
        {/* The prototype renders the close control in BOTH modes (page mode shows
            Back and the X, both closing the dossier) — kept identical. */}
        {onClose ? (
          <button type="button" className="dsr-close" onClick={onClose} aria-label="Close">
            <CloseOutlined />
          </button>
        ) : null}
      </div>

      <div className="dsr-scroll">
        <div className="dsr-inner">
          {query.isLoading ? (
            <Skeleton active paragraph={{ rows: 8 }} />
          ) : !d ? (
            <Empty description="Bill not found." />
          ) : (
            <>
              <BillDossierHero dossier={d} />

              <DossierKpiStrip items={decorateKpis(d)} />

              <div className="dsr-tabs">
                {BILL_DOSSIER_SECTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`dsr-tab${tab === s ? ' active' : ''}`}
                    onClick={() => setTab(s)}
                  >
                    {BILL_DOSSIER_SECTION_LABELS[s]}
                  </button>
                ))}
              </div>

              {tab === 'overview' ? (
                <BillOverviewTab overview={d.overview} related={d.relatedVehicles} onOpenBill={openBill} />
              ) : null}
              {tab === 'path' ? (
                <BillPathVotesTab
                  milestones={d.milestones}
                  governingRules={d.governingRules}
                  votes={d.votes}
                  noVote={d.noVote}
                />
              ) : null}
              {tab === 'funding' ? (
                <BillFundingTab funding={d.funding} onOpenPe={openPe} onOpenBill={openBill} />
              ) : null}
              {tab === 'provisions' ? (
                <BillProvisionsTab provisions={d.funding.provisions} />
              ) : null}
              {tab === 'impact' ? <BillImpactTab funding={d.funding} onOpenPe={openPe} /> : null}
              {tab === 'hearings' ? <BillHearingsTab hearings={d.hearings} /> : null}
              {tab === 'evidence' ? <BillEvidenceTab provenance={d.provenance} /> : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
