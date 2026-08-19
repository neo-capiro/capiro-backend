/**
 * Data Explorer ("Intelligence Center") — native vNext port of
 * `pages/explorer/DataExplorerPage.tsx` (Phase 2 old-UI purge).
 *
 * URL state is contract, byte-for-byte with the canonical page:
 *   · `?source=<key>` deep-links to a tab (Dashboard "Needs Attention" →
 *     comment-deadlines). Tab changes write it back with replace (not push) so
 *     the back button leaves the page as a whole, not tab-by-tab.
 *   · `?bill=<congressBillId>` deep-links straight to a Congress bill's detail
 *     drawer (Client Intelligence bill-pipeline cards, `/intelligence/bills/:bill`
 *     alert-email redirects via useBillTarget). It implies the "bills" tab even
 *     when `?source=` is absent or different, and reacts to in-page changes.
 *
 * The 18 source explorers and drill-in detail views live in the sources-* and
 * explorer-drill modules; identical endpoints/query keys/copy throughout.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CapiroTabs } from '../../components/menus/index.js';
import { SOURCES, isSourceKey, type SourceKey } from './explorer-meta.js';
import { ExplorerDrillInDrawer, type DrillIn } from './explorer-drill.js';
import {
  ContractorsExplorer,
  FaraExplorer,
  FecExplorer,
  LdaFilingsExplorer,
  SecExplorer,
} from './sources-filings.js';
import { BillsExplorer, CrsExplorer, GaoExplorer, HearingsExplorer } from './sources-congress.js';
import { CommentDeadlinesExplorer, FedRegExplorer } from './sources-fedreg.js';
import {
  FederalAssistanceAwardsExplorer,
  FederalAwardsExplorer,
  FederalGrantsExplorer,
  SamOppsExplorer,
} from './sources-awards.js';
import { StateBillsExplorer, StateLegislatorsExplorer } from './sources-state.js';
import { ArticlesExplorer } from './sources-news.js';
import './explorer.css';

export function DataExplorerVNext() {
  // ?source=<key> deep-links to a specific tab. Dashboard's "Needs Attention"
  // Comments tile uses this to land users directly on comment-deadlines.
  const [searchParams, setSearchParams] = useSearchParams();
  // ?bill=<congressBillId> deep-links straight to a Congress bill's detail
  // drawer (used by the Client Intelligence bill-pipeline cards). It implies
  // the "bills" tab even when ?source= is absent or different.
  const billParam = searchParams.get('bill');
  const initialSource = (() => {
    const fromUrl = searchParams.get('source');
    if (billParam) return 'bills';
    return isSourceKey(fromUrl) ? fromUrl : 'articles';
  })();
  const [source, setSource] = useState<SourceKey>(initialSource);
  const activeSource = SOURCES.find((s) => s.key === source) ?? SOURCES[0]!;
  const [drillIn, setDrillIn] = useState<DrillIn>(
    billParam ? { source: 'bills', id: billParam, rowSummary: billParam } : null,
  );

  // Keep ?source= in sync if the user changes tab manually. Replace (not push)
  // so the back button still leaves the page as a whole, not tab-by-tab.
  useEffect(() => {
    const current = searchParams.get('source');
    if (current !== source) {
      const next = new URLSearchParams(searchParams);
      next.set('source', source);
      setSearchParams(next, { replace: true });
    }
    // We intentionally do not depend on searchParams here, only react to a
    // user-driven `source` change. Including searchParams loops with itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // React to ?bill= changing while already on the page (e.g. clicking a
  // different bill card from a deep-linked Explorer view): switch to the
  // bills tab and open that bill's detail drawer.
  useEffect(() => {
    if (!billParam) return;
    setSource('bills');
    setDrillIn((prev) =>
      prev && prev.source === 'bills' && prev.id === billParam
        ? prev
        : { source: 'bills', id: billParam, rowSummary: billParam },
    );
  }, [billParam]);

  return (
    <section className="xp-page">
      <header className="xp-page-head">
        <div>
          <h1 className="xp-page-title">Intelligence Center</h1>
          <p className="xp-page-dek">
            Search and filter every federal data source Capiro tracks. Click a row to inspect the full record.
          </p>
        </div>
      </header>

      <div className="xp-source-tabs">
        <CapiroTabs
          label="Data sources"
          items={SOURCES.map((s) => ({ id: s.key, label: s.label }))}
          activeId={source}
          onChange={(id) => setSource(id as SourceKey)}
        />
      </div>

      <p className="xp-source-caption">{activeSource.description}</p>

      <div className="xp-source-body">
        {source === 'lda' ? <LdaFilingsExplorer onRowClick={(id, row) => setDrillIn({ source: 'lda', id, rowSummary: row.clientName })} /> : null}
        {source === 'contractors' ? <ContractorsExplorer onRowClick={(id, row) => setDrillIn({ source: 'contractors', id, rowSummary: row.name })} /> : null}
        {source === 'bills' ? <BillsExplorer onRowClick={(id, row) => setDrillIn({ source: 'bills', id, rowSummary: `${row.billType} ${row.billNumber}` })} /> : null}
        {source === 'fedreg' ? <FedRegExplorer onRowClick={(id, row) => setDrillIn({ source: 'fedreg', id, rowSummary: row.title })} /> : null}
        {source === 'hearings' ? <HearingsExplorer onRowClick={(id, row) => setDrillIn({ source: 'hearings', id, rowSummary: row.title })} /> : null}
        {source === 'gao' ? <GaoExplorer onRowClick={(id, row) => setDrillIn({ source: 'gao', id, rowSummary: row.title })} /> : null}
        {source === 'crs' ? <CrsExplorer onRowClick={(id, row) => setDrillIn({ source: 'crs', id, rowSummary: row.title })} /> : null}
        {source === 'fec' ? <FecExplorer onRowClick={(id, row) => setDrillIn({ source: 'fec', id, rowSummary: row.contributorName ?? row.committeeName ?? '' })} /> : null}
        {source === 'fara' ? <FaraExplorer onRowClick={(id, row) => setDrillIn({ source: 'fara', id, rowSummary: row.registrantName })} /> : null}
        {source === 'sec' ? <SecExplorer onRowClick={(id, row) => setDrillIn({ source: 'sec', id, rowSummary: row.companyName })} /> : null}
        {source === 'sam-opps' ? <SamOppsExplorer /> : null}
        {source === 'federal-awards' ? <FederalAwardsExplorer /> : null}
        {source === 'federal-assistance-awards' ? <FederalAssistanceAwardsExplorer /> : null}
        {source === 'federal-grants' ? <FederalGrantsExplorer /> : null}
        {source === 'state-legislators' ? <StateLegislatorsExplorer /> : null}
        {source === 'articles' ? <ArticlesExplorer onRowClick={(id, row) => setDrillIn({ source: 'articles', id, rowSummary: row.title })} /> : null}
        {source === 'state-bills' ? <StateBillsExplorer onRowClick={(id, row) => setDrillIn({ source: 'state-bills', id, rowSummary: `${row.state} ${row.identifier}` })} /> : null}
        {source === 'comment-deadlines' ? <CommentDeadlinesExplorer onRowClick={(id, row) => setDrillIn({ source: 'comment-deadlines', id, rowSummary: row.title })} /> : null}
      </div>

      <ExplorerDrillInDrawer drillIn={drillIn} onClose={() => setDrillIn(null)} />
    </section>
  );
}
