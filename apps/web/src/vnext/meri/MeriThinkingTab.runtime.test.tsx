import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { meriRuntimeStatus } from '../../components/chat/meri-runtime-status.js';
import { MeriThinkingTab } from './MeriThinkingTab.js';

vi.mock('./MeriAgentSteps.js', () => ({ MeriAgentSteps: () => null }));

describe('turn inspector reasoning labels', () => {
  it('shows the saved Standard selection even when the orchestration tier is deep', () => {
    render(
      <MeriThinkingTab
        plan="Read the client evidence"
        steps={[]}
        intent="general"
        tier="deep"
        runtimeStatus={meriRuntimeStatus({ reasoningMode: 'standard' })}
      />,
    );
    expect(screen.getByText('TURN DETAILS')).toBeInTheDocument();
    expect(screen.getByText('STANDARD SELECTED')).toBeInTheDocument();
    expect(screen.queryByText(/DEEP/)).toBeNull();
  });

  it('does not invent a selected mode from a legacy orchestration tier', () => {
    render(
      <MeriThinkingTab plan="Read the client evidence" steps={[]} intent="general" tier="deep" />,
    );
    expect(screen.getByText('TURN DETAILS')).toBeInTheDocument();
    expect(screen.queryByText('WORKING')).toBeNull();
    expect(screen.queryByText(/DEEP|STANDARD|MAX/)).toBeNull();
  });

  it('distinguishes requested Max from effective high and displays the provider fallback', () => {
    render(
      <MeriThinkingTab
        plan=""
        steps={[]}
        intent="general"
        tier="deep"
        runtimeStatus={meriRuntimeStatus({
          reasoningMode: 'max',
          telemetry: {
            requestedModel: 'requested-model',
            effectiveModel: 'served-model',
            requestedReasoningEffort: 'max',
            effectiveReasoningEffort: 'high',
            reasoningFallbackReasons: ['max_unsupported'],
          },
        })}
      />,
    );
    expect(screen.getByText('TURN DETAILS')).toBeInTheDocument();
    expect(screen.getByText('MAX SELECTED')).toBeInTheDocument();
    expect(screen.getByText('Requested effort').nextElementSibling).toHaveTextContent('max');
    expect(screen.getByText('Final effort').nextElementSibling).toHaveTextContent('high');
    expect(screen.getByText('Effective model').nextElementSibling).toHaveTextContent(
      'served-model',
    );
    expect(screen.getByText('The provider does not support Max effort.')).toBeInTheDocument();
  });

  it('does not claim the requested effort executed after the provider omitted reasoning', () => {
    render(
      <MeriThinkingTab
        plan=""
        steps={[]}
        intent="general"
        tier="deep"
        runtimeStatus={meriRuntimeStatus({
          reasoningMode: 'max',
          telemetry: {
            requestedReasoningEffort: 'max',
            effectiveReasoningEffort: null,
            reasoningFallbackReasons: ['reasoning_parameter_unsupported'],
          },
        })}
      />,
    );
    expect(screen.getByText('Final effort').nextElementSibling).toHaveTextContent('Not confirmed');
    expect(
      screen.getByText('The provider does not accept an explicit reasoning effort.'),
    ).toBeInTheDocument();
  });
});
