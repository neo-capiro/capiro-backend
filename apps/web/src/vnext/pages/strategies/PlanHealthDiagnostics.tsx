/*
 * F07 (2026-09-10 remediation plan §5) — strategy-local health diagnostics.
 *
 * ONE inline expandable panel opened by BOTH health controls (chip + bottom
 * card). Groups derive from the EXACT predicates feeding the shared score
 * (computeStrategyHealth): steps without an owner, gates without linked
 * source references, and overdue unfinished dated commitments (shared UTC
 * rule). Never navigates away — the user stays in the strategy editor.
 *
 * Honesty rules (plan §5):
 *  - the score is labeled N/100 (a score, not an issue count); 'No steps' for
 *    an empty plan;
 *  - a step can appear in multiple groups — unique affected-step totals are
 *    displayed separately from issue totals;
 *  - source coverage never claims the underlying source is verified;
 *  - an empty Watch queue never hides these findings — Watch proposals stay a
 *    separately named, separately scoped action;
 *  - no second score formula; this reads the same computePlanHealth output.
 */
import { useMemo } from 'react';
import { CapiroButton } from '../../components/actions/index.js';
import { memberName, type TenantMember } from './strategies-api.js';
import { hasLinkedStrategyEvidence, isStrategyStepOverdue } from '@capiro/strategy-verifier';
import type { StrategyDetail, StrategyNode } from '../../../pages/strategy/types.js';
import type { PlanHealth } from './lib/plan-health.js';

interface DiagnosticRow {
  node: StrategyNode;
}

export function PlanHealthDiagnostics({
  detail,
  health,
  open,
  onClose,
  onOpenStep,
  onWatchProposals,
  members,
}: {
  detail: StrategyDetail;
  health: PlanHealth;
  open: boolean;
  onClose: () => void;
  onOpenStep: (stepId: string) => void;
  onWatchProposals: () => void;
  members: { data?: TenantMember[] | undefined };
}) {
  const groups = useMemo(() => {
    const asOf = new Date();
    const unowned: DiagnosticRow[] = [];
    const ungroundedGates: DiagnosticRow[] = [];
    const overdue: DiagnosticRow[] = [];
    for (const node of detail.nodes) {
      if (!node.ownerUserId) unowned.push({ node });
      if (node.kind === 'gate' && !hasLinkedStrategyEvidence(node.provenance?.sources)) {
        ungroundedGates.push({ node });
      }
      if (isStrategyStepOverdue(node, asOf)) overdue.push({ node });
    }
    return { unowned, ungroundedGates, overdue };
  }, [detail.nodes]);

  const findings = groups.unowned.length + groups.ungroundedGates.length + groups.overdue.length;
  const uniqueSteps = new Set<string>();
  for (const row of [...groups.unowned, ...groups.ungroundedGates, ...groups.overdue]) {
    uniqueSteps.add(row.node.id);
  }

  if (!open) return null;
  return (
    <section className="st-card st-health-panel" role="region" aria-label="Plan health diagnostics">
      <div className="st-card__header">
        <p className="st-section-label">Plan health diagnostics</p>
        <CapiroButton size="compact" variant="quiet" onClick={onClose}>
          Close
        </CapiroButton>
      </div>
      <div className="st-card__body">
        <p className="st-health-panel__score">
          {health.totalSteps ? `Plan health · ${health.score}/100` : 'No steps'}
        </p>
        <p className="st-health-panel__facts">
          {findings > 0
            ? `${findings} findings across ${uniqueSteps.size} ${
                uniqueSteps.size === 1 ? 'step' : 'steps'
              } affected. One step can appear in more than one group.`
            : 'No findings — ownership, gate source references and dated commitments all pass.'}
        </p>

        <Group
          title="Steps without an owner"
          rows={groups.unowned}
          members={members}
          onOpenStep={onOpenStep}
          emptyCopy="Every step has an owner."
        />
        <Group
          title="Gates without linked source references"
          rows={groups.ungroundedGates}
          members={members}
          onOpenStep={onOpenStep}
          emptyCopy="Every gate has at least one linked source reference. A reference is coverage — it does not verify the source's contents."
        />
        <Group
          title="Overdue unfinished dated commitments"
          rows={groups.overdue}
          members={members}
          onOpenStep={onOpenStep}
          emptyCopy="No unfinished dated commitment is past its date (UTC)."
        />

        <div className="st-health-panel__watch">
          <p className="st-health-panel__watch-copy">
            Watch proposals are a separate review queue for suggested changes from monitoring — they
            are not plan-health findings.
          </p>
          <CapiroButton size="compact" variant="secondary" onClick={onWatchProposals}>
            Watch proposals
          </CapiroButton>
        </div>
      </div>
    </section>
  );
}

function Group({
  title,
  rows,
  members,
  onOpenStep,
  emptyCopy,
}: {
  title: string;
  rows: DiagnosticRow[];
  members: { data?: TenantMember[] | undefined };
  onOpenStep: (stepId: string) => void;
  emptyCopy: string;
}) {
  return (
    <div className="st-health-panel__group">
      <p className="st-section-label">
        {title} · {rows.length}
      </p>
      {rows.length === 0 ? (
        <p className="st-health-panel__empty">{emptyCopy}</p>
      ) : (
        <ul>
          {rows.map(({ node }) => (
            <li key={`${title}-${node.id}`} className="st-health-panel__row">
              <span>{node.title}</span>
              {node.ownerUserId ? (
                <small>{memberName(members.data, node.ownerUserId)}</small>
              ) : null}
              <CapiroButton size="compact" onClick={() => onOpenStep(node.id)}>
                Open step
              </CapiroButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
