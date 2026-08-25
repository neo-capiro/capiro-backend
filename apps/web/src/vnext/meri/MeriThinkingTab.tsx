import type { TrustStep } from '../../components/chat/work-performed-shared.js';
import { INTENT_LABELS } from '../../components/chat/work-performed-shared.js';
import { MeriAgentSteps } from './MeriAgentSteps.js';
import { MeriPanelState } from './MeriPanelState.js';

/**
 * MeriThinkingTab — v6 turn inspector, Thinking tab. The closest existing
 * analog is MeriEvidenceTray's WORK PERFORMED tab (PLAN block, work-stat
 * pills, a list of steps with status pills); this is a new, turn-scoped
 * component rather than a reskin of that tab, because the prop shape is
 * different on purpose:
 *
 *  - `steps` is TrustStep[] (work-performed-shared.ts), the real shape
 *    useMeriChatController accumulates from the SSE tool_call/trace stream —
 *    not MeriWorkStep[], the tray's own richer (fixture-only) shape.
 *  - `assumptions` is dropped entirely: it is always hardcoded `[]` at
 *    MeriEvidenceTray's one real call site (VNextMeriMessage.tsx), so it
 *    was never real product content.
 *
 * The step list itself reuses MeriAgentSteps — already the shared,
 * class-based TrustStep renderer behind MeriWorkPerformed and
 * MeriResearchProgress — rather than a third copy of the same status-pill
 * styling.
 *
 * Fixture-fed only: this component takes plan/steps/intent/tier as plain
 * props and never reaches into chat-store.ts or useMeriChatController.ts.
 * Wiring real per-message trustSteps/planSteps/orchestratorIntent/
 * orchestratorTier is a separate, parallel piece of work.
 */

export interface MeriThinkingTabProps {
  plan: string;
  steps: TrustStep[];
  intent: string | null;
  tier: 'fast' | 'deep' | null;
}

export function MeriThinkingTab({ plan, steps, intent, tier }: MeriThinkingTabProps) {
  const trimmedPlan = plan.trim();
  const hasContent = trimmedPlan.length > 0 || steps.length > 0;

  if (!hasContent) {
    return (
      <div className="vnext-meri__evidence-tab-body">
        <MeriPanelState tone="empty">Meri has not recorded a plan or steps for this turn.</MeriPanelState>
      </div>
    );
  }

  const toolCount = steps.length;
  const sourceCount = steps.reduce((sum, step) => sum + (typeof step.count === 'number' ? step.count : 0), 0);
  const errorCount = steps.filter((step) => step.status === 'error').length;
  const planLabel = (intent && INTENT_LABELS[intent]) || 'Working';

  return (
    <div className="vnext-meri__evidence-tab-body">
      <div className="vnext-meri__evidence-section-label">
        {planLabel.toUpperCase()}
        {tier === 'deep' ? ' · DEEP' : ''}
      </div>

      {trimmedPlan ? (
        <div className="vnext-meri__evidence-plan">
          <div className="vnext-meri__evidence-plan-label">PLAN</div>
          <div className="vnext-meri__evidence-plan-text">{plan}</div>
        </div>
      ) : null}

      {toolCount > 0 ? (
        <div className="vnext-meri__evidence-stat-row">
          <span className="vnext-meri__evidence-stat-pill" data-tone="n">
            {toolCount} TOOL{toolCount === 1 ? '' : 'S'}
          </span>
          {sourceCount > 0 ? (
            <span className="vnext-meri__evidence-stat-pill" data-tone="n">
              {sourceCount} SOURCE{sourceCount === 1 ? '' : 'S'}
            </span>
          ) : null}
          {errorCount > 0 ? (
            <span className="vnext-meri__evidence-stat-pill" data-tone="b">
              {errorCount} ISSUE{errorCount === 1 ? '' : 'S'}
            </span>
          ) : null}
        </div>
      ) : null}

      {steps.length > 0 ? (
        <div className="vnext-meri__evidence-steps">
          <MeriAgentSteps steps={steps} />
        </div>
      ) : null}

      <div className="vnext-meri__evidence-disclaimer">
        THIS IS EXECUTION EVIDENCE — PLANS, TOOLS AND STEPS. IT IS NOT MODEL REASONING.
      </div>
    </div>
  );
}
