import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VNextOutreachPhase1Workspace } from './VNextOutreachPhase1Workspace.js';
import type { EngagementOutreachStep } from './VNextOutreachWorkspace.js';

/**
 * This is the seam that hands a campaign off from the canonical planning steps
 * (goal, targets, delivery, context, Examples) to the governed
 * draft/test/send spine. It must never mount both at once, and it must route
 * every planning step — not just 'goal' — to the planning workspace so an
 * in-progress campaign resuming mid-setup does not fall through to Send.
 *
 * `delivery` and `samples` are covered explicitly below because they are the
 * two steps the superseded template-first flow had no case for. A regression
 * that dropped either from the rail would previously have routed it to Send.
 */

const planningMock = vi.fn();
const approveSendMock = vi.fn();
const guidedMock = vi.fn();

vi.mock('./VNextOutreachWorkspace.js', () => ({
  VNextOutreachWorkspace: (props: Record<string, unknown>) => {
    planningMock(props);
    return <div data-testid="planning-workspace" />;
  },
}));

vi.mock('./VNextOutreachApproveSendWorkspace.js', () => ({
  VNextOutreachApproveSendWorkspace: (props: Record<string, unknown>) => {
    approveSendMock(props);
    return <div data-testid="approve-send-workspace" />;
  },
}));

/**
 * Mocked so that a re-introduced import of the superseded template-first flow
 * would show up as a mounted node here rather than passing silently.
 */
vi.mock('./VNextOutreachGuidedWorkspace.js', () => ({
  VNextOutreachGuidedWorkspace: (props: Record<string, unknown>) => {
    guidedMock(props);
    return <div data-testid="guided-workspace" />;
  },
}));

function renderAt(step: EngagementOutreachStep) {
  vi.clearAllMocks();
  render(
    <VNextOutreachPhase1Workspace
      sessionId="session-1"
      clients={[]}
      selectedClientId={null}
      integrations={[]}
      step={step}
      onStepChange={vi.fn()}
      onExit={vi.fn()}
    />,
  );
}

describe('VNextOutreachPhase1Workspace', () => {
  it.each<EngagementOutreachStep>(['goal', 'targets', 'delivery', 'context', 'samples'])(
    'routes step "%s" to the canonical planning workspace, never the send workspace',
    (step) => {
      renderAt(step);
      expect(screen.getByTestId('planning-workspace')).toBeInTheDocument();
      expect(screen.queryByTestId('approve-send-workspace')).not.toBeInTheDocument();
      expect(planningMock).toHaveBeenCalledTimes(1);
      expect(approveSendMock).not.toHaveBeenCalled();
    },
  );

  it.each<EngagementOutreachStep>(['drafts', 'send'])(
    'routes step "%s" to the governed approve/send workspace, never the planning workspace',
    (step) => {
      renderAt(step);
      expect(screen.getByTestId('approve-send-workspace')).toBeInTheDocument();
      expect(screen.queryByTestId('planning-workspace')).not.toBeInTheDocument();
      expect(approveSendMock).toHaveBeenCalledTimes(1);
      expect(planningMock).not.toHaveBeenCalled();
    },
  );

  it('never mounts the superseded template-first guided flow at any step', () => {
    for (const step of [
      'goal',
      'targets',
      'delivery',
      'context',
      'samples',
      'drafts',
      'send',
    ] as EngagementOutreachStep[]) {
      renderAt(step);
      expect(screen.queryByTestId('guided-workspace')).not.toBeInTheDocument();
      expect(guidedMock).not.toHaveBeenCalled();
    }
  });
});
