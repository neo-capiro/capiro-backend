import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  BILL_DOSSIER_SECTIONS,
  BILL_DOSSIER_SECTION_LABELS,
  type BillDossierSection,
} from '@capiro/shared';
import { useBillDossier } from '../../../pages/bills/bill-360-api.js';
import { CapiroButton, CapiroIconButton } from '../../components/actions/index.js';
import { CapiroEmptyState, CapiroSkeleton } from '../../components/feedback/index.js';
import { CapiroTabs } from '../../components/menus/index.js';
import { Bill360ExportVNext } from './Bill360ExportVNext.js';
import { BillDossierHeroVNext, decorateKpis } from './BillDossierHeroVNext.js';
import { BillEvidenceTab } from './BillEvidenceTab.js';
import { BillFundingTab } from './BillFundingTab.js';
import { BillHearingsTab } from './BillHearingsTab.js';
import { BillAgenda } from '../legiwatch/hearings/BillAgenda.js';
import { BillImpactTab } from './BillImpactTab.js';
import { BillOverviewTab } from './BillOverviewTab.js';
import { BillPathVotesTab } from './BillPathVotesTab.js';
import { BillProvisionsTab } from './BillProvisionsTab.js';
import { BackIcon, CloseIcon, DossierKpiStrip, OpenFullIcon } from './dossier-primitives.js';
import { FolderContextPanel } from '../legiwatch/bills/FolderContextPanel.js';
import { BillSourceRecords } from '../legiwatch/bills/BillSourceRecords.js';

/**
 * The Bill 360 dossier body, vNext re-skin of pages/bills/BillDossierBody.tsx —
 * the SAME content in a drawer or a full page. It renders its own chrome (Bill
 * 360 eyebrow, Track, Open full page / Back, close) to match the prototype,
 * then the hero, the 6-KPI strip, the 7-tab bar, and the active tab. Identical
 * props, endpoint, query keys and copy as the canonical body; presentation is
 * Untitled UI primitives (CapiroTabs/CapiroButton/CapiroSkeleton/
 * CapiroEmptyState) over the vNext token layer. All facts carry a provenance
 * badge; funding shows a grounded empty state until R3.
 */
export function BillDossierBodyVNext({
  billId,
  clientId,
  folderId,
  mode,
  isTracked,
  onTrack,
  onClose,
  onOpenBill,
}: {
  billId: string;
  clientId?: string | null;
  folderId?: string | null;
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
  const location = useLocation();
  const returnedToHearings = mode === 'page' && new URLSearchParams(location.search).get('section') === 'hearings';
  const query = useBillDossier(billId, clientId ?? null);
  const [tab, setTab] = useState<BillDossierSection>(returnedToHearings ? 'hearings' : 'overview');

  // Swapping bills in place (related vehicle, like-for-like comparison) returns to
  // Overview, exactly as the prototype's openBill() resets `tab`.
  useEffect(() => setTab(returnedToHearings ? 'hearings' : 'overview'), [billId, returnedToHearings]);

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
    <div className="b360-dossier">
      <div className="b360-chrome">
        {mode === 'page' && onClose ? (
          <CapiroButton size="compact" onClick={onClose} leadingIcon={<BackIcon />}>
            Back
          </CapiroButton>
        ) : null}
        <span className="b360-eyebrow">Bill 360</span>
        <span className="b360-chrome-spacer" />
        {/* Export (R4 §4.5). Only offered once the dossier has loaded — there is
            nothing to export from a skeleton. */}
        {d ? <Bill360ExportVNext dossier={d} /> : null}
        {mode === 'drawer' ? (
          <CapiroButton size="compact" onClick={openFull} leadingIcon={<OpenFullIcon />}>
            Open full page
          </CapiroButton>
        ) : null}
        {onTrack ? (
          <CapiroButton
            size="compact"
            variant={tracked ? 'secondary' : 'primary'}
            onClick={() => onTrack(billId)}
          >
            {tracked ? 'Tracked' : 'Track bill'}
          </CapiroButton>
        ) : null}
        {/* The prototype renders the close control in BOTH modes (page mode shows
            Back and the X, both closing the dossier) — kept identical. */}
        {onClose ? <CapiroIconButton label="Close" icon={<CloseIcon />} onClick={onClose} /> : null}
      </div>

      <div className="b360-inner">
        {query.isLoading ? (
          <div className="b360-loading" aria-label="Loading bill dossier">
            <CapiroSkeleton width="34%" height={14} />
            <CapiroSkeleton width="72%" height={28} />
            <CapiroSkeleton width="48%" height={14} />
            <CapiroSkeleton height={96} />
            <CapiroSkeleton width="88%" height={14} />
            <CapiroSkeleton width="80%" height={14} />
            <CapiroSkeleton width="84%" height={14} />
            <CapiroSkeleton width="62%" height={14} />
          </div>
        ) : !d ? (
          <div className="b360-empty">
            <CapiroEmptyState title="Bill not found." />
          </div>
        ) : (
          <>
            <BillDossierHeroVNext dossier={d} />

            {d.bill.isState && d.bill.sponsorLegislatorId ? (
              <a
                href={`/directory/state-legislators/${encodeURIComponent(d.bill.sponsorLegislatorId)}`}
              >
                Sponsor profile
              </a>
            ) : null}

            {folderId && tab === 'overview' ? (
              <FolderContextPanel
                key={`${folderId}:${billId}`}
                folderId={folderId}
                billId={billId}
              />
            ) : null}

            <DossierKpiStrip items={decorateKpis(d)} />

            <div className="b360-tabs">
              <CapiroTabs
                label="Bill 360 sections"
                items={BILL_DOSSIER_SECTIONS.map((s) => ({
                  id: s,
                  label: BILL_DOSSIER_SECTION_LABELS[s],
                }))}
                activeId={tab}
                onChange={(id) => setTab(id as BillDossierSection)}
              />
            </div>

            {tab === 'overview' ? (
              <BillOverviewTab
                overview={d.overview}
                related={d.relatedVehicles}
                onOpenBill={openBill}
              />
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
            {tab === 'provisions' ? <BillProvisionsTab provisions={d.funding.provisions} /> : null}
            {tab === 'impact' ? <BillImpactTab funding={d.funding} onOpenPe={openPe} /> : null}
            {tab === 'hearings' ? (
              <>
                <BillAgenda billId={billId} clientId={clientId} folderId={folderId} />
                <BillHearingsTab hearings={d.hearings} />
              </>
            ) : null}
            {tab === 'evidence' ? <BillEvidenceTab provenance={d.provenance} /> : null}
            {d.bill.isState && (tab === 'path' || tab === 'evidence') ? (
              <BillSourceRecords
                key={`${billId}:${tab}`}
                billId={billId}
                initialSection={tab === 'evidence' ? 'documents' : 'history'}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
