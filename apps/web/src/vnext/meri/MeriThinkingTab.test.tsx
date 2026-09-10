import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import type { TrustStep } from '../../components/chat/work-performed-shared.js';
import { MeriThinkingTab } from './MeriThinkingTab.js';

// Fixture data only — this component is verified in isolation with plausible
// props, not real controller/chat-store data (a separate piece of work wires
// trustSteps/planSteps/orchestratorIntent/orchestratorTier through as props).
const STEPS: TrustStep[] = [
  {
    tool: 'search_committee_reports',
    label: 'Searched committee reports',
    status: 'done',
    count: 3,
  },
  {
    tool: 'search_budget_history',
    label: 'Checked prior-cycle appropriations',
    status: 'done',
    count: 2,
  },
  { tool: 'reconcile_figures', label: 'Reconciling figures', status: 'running' },
];

describe('MeriThinkingTab', () => {
  test('renders the plan, recorded intent, derived stat pills, and unfinished evidence without inventing live activity', () => {
    render(
      <MeriThinkingTab
        plan="Test each premise against the record."
        steps={STEPS}
        intent="query_intelligence"
        tier="deep"
      />,
    );

    expect(screen.getByText('Test each premise against the record.')).toBeTruthy();
    expect(screen.getByText('PLAN')).toBeTruthy();
    expect(screen.getByText('Researching government-affairs intelligence')).toBeTruthy();
    expect(screen.getByText('TURN DETAILS')).toBeTruthy();
    expect(screen.getByText('INCOMPLETE')).toBeTruthy();
    expect(screen.queryByText('RUNNING')).toBeNull();
    expect(screen.queryByText(/DEEP/)).toBeNull();
    expect(screen.getByText('3 TOOLS')).toBeTruthy();
    expect(screen.getByText('5 SOURCES')).toBeTruthy();
    expect(screen.getByText('Searched committee reports')).toBeTruthy();
    expect(screen.getByText('Reconciling figures')).toBeTruthy();
  });

  test('keeps legacy turns neutral when no authoritative lifecycle is recorded', () => {
    render(<MeriThinkingTab plan="" steps={[STEPS[0]!]} intent={null} tier="fast" />);
    expect(screen.getByText('TURN DETAILS')).toBeTruthy();
    expect(screen.queryByText('WORKING')).toBeNull();
    expect(screen.queryByText(/DEEP/)).toBeNull();
  });

  test.each(['running', 'completed', 'stopped', 'failed', 'incomplete'] as const)(
    'uses the persisted %s lifecycle even with a saved running tool',
    (lifecycle) => {
      render(
        <MeriThinkingTab
          plan=""
          steps={[STEPS[2]!]}
          intent={null}
          tier="deep"
          runtimeStatus={{
            lifecycle,
            selectedMode: 'standard',
            requestedEffort: null,
            effectiveEffort: null,
            adjusted: false,
            partial: lifecycle === 'incomplete',
            stopped: lifecycle === 'stopped',
          }}
        />,
      );
      expect(
        screen.getAllByText(lifecycle === 'running' ? 'WORKING' : lifecycle.toUpperCase()).length,
      ).toBeGreaterThan(0);
      expect(screen.getByText('STANDARD SELECTED')).toBeTruthy();
      expect(screen.queryByText(/DEEP/)).toBeNull();
      if (lifecycle === 'running') expect(screen.getByText('RUNNING')).toBeTruthy();
      else {
        expect(screen.queryByText('WORKING')).toBeNull();
        expect(screen.queryByText('RUNNING')).toBeNull();
        expect(screen.getAllByText('INCOMPLETE').length).toBeGreaterThan(0);
      }
    },
  );

  test('shows an issue pill only when a step actually errored', () => {
    const withError: TrustStep[] = [
      ...STEPS,
      { tool: 'verify_claim', label: 'Verify a claim', status: 'error' },
    ];
    render(<MeriThinkingTab plan="" steps={withError} intent={null} tier={null} />);
    expect(screen.getByText('1 ISSUE')).toBeTruthy();
  });

  test('renders an empty state when there is no plan and no steps, instead of a blank panel', () => {
    render(<MeriThinkingTab plan="" steps={[]} intent={null} tier={null} />);
    expect(screen.getByText('Meri has not recorded a plan or steps for this turn.')).toBeTruthy();
    expect(screen.queryByText('PLAN')).toBeNull();
  });

  test('never accepts or renders an assumptions prop — dropped entirely per the v6 ruling', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/vnext/meri/MeriThinkingTab.tsx'),
      'utf8',
    );
    // Matches a prop declaration/destructure/access (assumptions:, assumptions?:,
    // { assumptions }, props.assumptions) without tripping on this file's own
    // explanatory prose about *why* the prop was dropped.
    expect(source).not.toMatch(/\bassumptions\s*[?:,}.]/);
  });

  test('carries no raw hex/rgba literals — colour lives in CSS classes, not inline styles', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/vnext/meri/MeriThinkingTab.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(source).not.toMatch(/rgba?\(/i);
    expect(source).not.toMatch(/style=\{/);
  });
});
