import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VNextOutreachPhase1Workspace } from './VNextOutreachPhase1Workspace.js';
import type { EngagementOutreachStep } from './VNextOutreachWorkspace.js';

/**
 * This is the seam that hands a campaign off from the template-first guided
 * setup (workflow, name, sponsor, targets, context, review packet) to the
 * governed draft/test/send spine. It must never mount both at once, and it
 * must route every setup step — not just 'goal' — to the guided workspace so
 * an in-progress campaign resuming mid-setup does not fall through to Send.
 */

const guidedMock = vi.fn();
const approveSendMock = vi.fn();

vi.mock('./VNextOutreachGuidedWorkspace.js', () => ({
  VNextOutreachGuidedWorkspace: (props: Record<string, unknown>) => {
    guidedMock(props);
    return <div data-testid="guided-workspace" />;
  },
}));

vi.mock('./VNextOutreachApproveSendWorkspace.js', () => ({
  VNextOutreachApproveSendWorkspace: (props: Record<string, unknown>) => {
    approveSendMock(props);
    return <div data-testid="approve-send-workspace" />;
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
  it.each<EngagementOutreachStep>(['goal', 'targets', 'context'])(
    'routes step "%s" to the guided setup workspace, never the send workspace',
    (step) => {
      renderAt(step);
      expect(screen.getByTestId('guided-workspace')).toBeInTheDocument();
      expect(screen.queryByTestId('approve-send-workspace')).not.toBeInTheDocument();
      expect(guidedMock).toHaveBeenCalledTimes(1);
      expect(approveSendMock).not.toHaveBeenCalled();
    },
  );

  it.each<EngagementOutreachStep>(['drafts', 'send'])(
    'routes step "%s" to the governed approve/send workspace, never the setup workspace',
    (step) => {
      renderAt(step);
      expect(screen.getByTestId('approve-send-workspace')).toBeInTheDocument();
      expect(screen.queryByTestId('guided-workspace')).not.toBeInTheDocument();
      expect(approveSendMock).toHaveBeenCalledTimes(1);
      expect(guidedMock).not.toHaveBeenCalled();
    },
  );
});
