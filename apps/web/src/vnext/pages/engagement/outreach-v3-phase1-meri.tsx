import {
  AlertTriangle,
  Check,
  ChevronRight,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { OutreachConversation } from '../../../pages/engagement/outreach/v3/OutreachConversation.js';
import type { OutreachV3Proposal } from '../../../pages/engagement/outreach/v3/contracts.js';
import { useOutreachV3Session } from '../../../pages/engagement/outreach/v3/useOutreachV3Session.js';
import { describeOutreachProposal } from './VNextOutreachOperatorWorkspace.js';
import type { MeriReceipt } from './outreach-v3-phase1-shared.js';

export function MeriRail({
  controller,
  campaignName,
  collapsed,
  receipts,
  busyProposalId,
  proposalError,
  onToggle,
  onApply,
  onDiscard,
  onPrepareReversal,
}: {
  controller: ReturnType<typeof useOutreachV3Session>;
  campaignName: string;
  collapsed: boolean;
  receipts: MeriReceipt[];
  busyProposalId: string | null;
  proposalError: string | null;
  onToggle: () => void;
  onApply: (proposal: OutreachV3Proposal) => void;
  onDiscard: (proposal: OutreachV3Proposal) => void;
  onPrepareReversal: (receipt: MeriReceipt) => void;
}) {
  if (collapsed) {
    return <button type="button" className="ov3p1-meri-restore" onClick={onToggle}><Sparkles size={16} /> Meri</button>;
  }

  return (
    <aside className="ov3p1-meri-rail" aria-label="Meri campaign operator">
      <header>
        <div><span><Sparkles size={16} /></span><strong>Meri</strong><small>Campaign operator</small></div>
        <button type="button" className="ov3p1-icon-button" onClick={onToggle} aria-label="Collapse Meri"><ChevronRight size={17} /></button>
      </header>

      {controller.reasoningUnavailable ? (
        <div className="ov3p1-meri-outage"><AlertTriangle size={17} /><span><strong>Meri is unavailable</strong><small>{controller.reasoningErrorMessage || 'The deterministic campaign controls remain usable.'}</small></span><button type="button" onClick={() => void controller.retryReasoning()}>Retry</button></div>
      ) : null}

      {controller.pendingProposals.map((proposal) => {
        const session = controller.session;
        if (!session) return null;
        const preview = describeOutreachProposal(proposal, session.spec, session.currentStateVersion);
        const stale = proposal.expectedStateVersion !== session.currentStateVersion;
        return (
          <article className="ov3p1-meri-proposal" key={proposal.id} data-stale={stale || undefined}>
            <span>Proposed change</span>
            <h3>{preview.title}</h3>
            <dl>
              <div><dt>You asked</dt><dd>{preview.title}</dd></div>
              <div><dt>Now</dt><dd>{preview.before.join(' · ')}</dd></div>
              <div><dt>Proposed</dt><dd>{preview.after.join(' · ')}</dd></div>
              <div><dt>Effect</dt><dd>{preview.commandCount} governed command{preview.commandCount === 1 ? '' : 's'}; no approval or send authority.</dd></div>
            </dl>
            {stale ? <p>This was prepared for V{proposal.expectedStateVersion}; the campaign is now V{session.currentStateVersion}.</p> : null}
            {proposalError ? <p className="ov3p1-error">{proposalError}</p> : null}
            <div>
              <button type="button" className="ov3p1-button is-primary" disabled={stale || busyProposalId === proposal.id || controller.proposalBusy} onClick={() => onApply(proposal)}><Check size={14} /> Apply this change</button>
              <button type="button" className="ov3p1-button is-secondary" onClick={() => void controller.sendTurn(`Adjust this proposal: ${preview.title}`)}>Adjust</button>
              <button type="button" className="ov3p1-button is-quiet" onClick={() => onDiscard(proposal)}>Discard</button>
            </div>
            <footer><button type="button" onClick={() => void controller.sendTurn(`Why do you recommend: ${preview.title}?`)}>Why?</button><button type="button" onClick={() => void controller.sendTurn(`Show the source for: ${preview.title}`)}>Show source</button></footer>
          </article>
        );
      })}

      {receipts.length ? (
        <section className="ov3p1-meri-receipts">
          <span>Change history</span>
          {receipts.map((receipt) => (
            <article key={receipt.id}>
              <Check size={14} />
              <div><strong>{receipt.title}</strong><p>{receipt.body}</p><small>{receipt.version}</small></div>
              <button type="button" onClick={() => onPrepareReversal(receipt)}>{receipt.safeToReverse ? 'Put it back' : 'Prepare a reversal'}</button>
            </article>
          ))}
        </section>
      ) : null}

      <div className="ov3p1-meri-conversation">
        <OutreachConversation
          title={campaignName}
          stage={controller.stage}
          turns={controller.turns}
          unavailable={controller.reasoningUnavailable}
          unavailableMessage={controller.reasoningErrorMessage}
          sending={controller.sendingTurn}
          onSend={controller.sendTurn}
          onRetry={() => controller.retryReasoning()}
        />
      </div>
      <p className="ov3p1-meri-guardrail"><ShieldCheck size={13} /> Meri never approves, sends, or writes active memory on her own.</p>
    </aside>
  );
}
