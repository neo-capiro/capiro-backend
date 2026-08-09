import { Button } from 'antd';
import type { ActionCardDto } from '../actions/types.js';
import { IntelligenceTab } from './IntelligenceTab.js';
import { TrackerTab } from './tracker/TrackerTab.js';
import type { TrackerSummary } from './tracker/tracker-api.js';
import type { Client } from './clientTypes.js';
import type { IntelligenceView } from './client-profile-crm-model.js';

export function Intelligence({
  client,
  view,
  setView,
  trackerSummary,
  peCount,
  topAction,
}: {
  client: Client;
  view: IntelligenceView;
  setView: (view: IntelligenceView) => void;
  trackerSummary?: TrackerSummary;
  peCount: number;
  topAction?: ActionCardDto;
}) {
  return (
    <section className="crm-section-shell">
      <div className="crm-section-head">
        <div><h2>Intelligence</h2><p>A client-level digest first; specialist workspaces stay one click away.</p></div>
        {view !== 'summary' ? <Button onClick={() => setView('summary')}>← Back to summary</Button> : null}
      </div>
      {view === 'summary' ? (
        <div className="crm-intel-summary">
          <button type="button" className="crm-intel-summary-row" onClick={() => setView('legiwatch')}>
            <span><b>Policy & legislation</b><small>{trackerSummary?.boardCount ?? 0} tracked bills · {trackerSummary?.unread ?? 0} unread updates</small></span>
            <span>Open LegiWatch →</span>
          </button>
          <button type="button" className="crm-intel-summary-row" onClick={() => setView('client')}>
            <span><b>Funding, budget & client intelligence</b><small>{peCount} relevant Program Elements{topAction ? ` · Priority: ${topAction.issueTitle}` : ''}</small></span>
            <span>Open client intelligence →</span>
          </button>
        </div>
      ) : view === 'client' ? (
        <IntelligenceTab clientId={client.id} clientName={client.name} />
      ) : (
        <div className="lw-root redesign"><TrackerTab clientId={client.id} clientName={client.name} /></div>
      )}
    </section>
  );
}
