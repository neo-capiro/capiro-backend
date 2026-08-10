import {
  Check,
  FileClock,
  LockKeyhole,
  Send,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type { OutreachV3DecisionSurfaceProps } from './decision-surface-contract.js';

export type ReadyForGenerationSurfaceProps = Pick<
  OutreachV3DecisionSurfaceProps,
  'session' | 'onFinish'
>;

function acceptedContextCount(props: ReadyForGenerationSurfaceProps): number {
  const context = props.session.spec.context;
  return (
    context.requiredPolicyRefs.length +
    context.writingGuidanceRefs.length +
    context.campaignFactRefs.length +
    context.targetSpecificRefs.length +
    context.groupSafeRefs.length
  );
}

export function ReadyForGenerationSurface(props: ReadyForGenerationSurfaceProps) {
  const { session, onFinish } = props;
  const contextCount = acceptedContextCount(props);
  return (
    <section className="ov3-decision-panel ov3-ready-boundary">
      <header className="ov3-panel-header">
        <div>
          <span className="ov3-eyebrow">Planning complete · Phase 6 boundary</span>
          <h2>The campaign plan is ready for governed generation</h2>
          <p>
            Goal, sponsor, targets, delivery, context, and strategy are stored as immutable,
            versioned Campaign Spec state.
          </p>
        </div>
        <span className="ov3-badge is-success"><Check size={13} /> Planning complete</span>
      </header>

      <div className="ov3-ready-grid">
        <article>
          <Sparkles size={20} aria-hidden="true" />
          <strong>Canonical plan</strong>
          <p>State V{session.currentStateVersion} · {session.specHash.slice(0, 10)}…</p>
        </article>
        <article>
          <ShieldCheck size={20} aria-hidden="true" />
          <strong>Authorized audience</strong>
          <p>{session.spec.targeting.selectedTargetRefs.length} selected target{session.spec.targeting.selectedTargetRefs.length === 1 ? '' : 's'}</p>
        </article>
        <article>
          <LockKeyhole size={20} aria-hidden="true" />
          <strong>Governed context</strong>
          <p>{contextCount} accepted source{contextCount === 1 ? '' : 's'} with explicit scope</p>
        </article>
      </div>

      <div className="ov3-future-stage-grid">
        <article>
          <FileClock size={19} aria-hidden="true" />
          <div>
            <span className="ov3-eyebrow">Next phase</span>
            <h3>Representative samples and immutable draft versions</h3>
            <p>
              Generation will use the governed Evidence Packet and Message Plan—not unrestricted
              chat prose.
            </p>
          </div>
        </article>
        <article>
          <Send size={19} aria-hidden="true" />
          <div>
            <span className="ov3-eyebrow">Later authority</span>
            <h3>Approval, deterministic preflight, and durable send intent</h3>
            <p>
              No sender, test send, final send, provider call, or delivery retry is available in
              this Phase 6 UI.
            </p>
          </div>
        </article>
      </div>

      <div className="ov3-recovery is-info">
        <ShieldCheck size={18} aria-hidden="true" />
        <div>
          <strong>The product stops safely here</strong>
          <p>
            Typing “send it” cannot create a draft or send intent. Classic Outreach remains
            available until later phases are accepted and enabled.
          </p>
        </div>
      </div>

      <footer className="ov3-panel-footer">
        <span>Finish later keeps the canonical V{session.currentStateVersion} session available.</span>
        <div className="ov3-panel-footer__actions">
          <button type="button" className="ov3-button is-primary" onClick={onFinish}>
            Finish later
          </button>
        </div>
      </footer>
    </section>
  );
}
