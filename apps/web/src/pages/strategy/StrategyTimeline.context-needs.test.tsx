/*
 * Phase 5 §6 — the inline `needs context` step marker: a small, calm marker
 * (never a full card) on exactly the steps a context gap currently affects,
 * with a plain-language accessible label, that disappears the moment the
 * server-side gap resolves (re-grounded, not a local dismiss).
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { StrategyTimeline } from './StrategyTimeline.js';
import { buildCalendar } from './fiscal.js';
import type { StrategyNode } from './types.js';

const calendar = buildCalendar(new Date('2026-07-27T12:00:00Z'));

function node(over: Partial<StrategyNode> & { id: string; title: string }): StrategyNode {
  return {
    kind: 'action',
    subject: 'deliverable',
    status: 'draft',
    startsOn: '2026-11-01',
    endsOn: null,
    provenance: null,
    ...over,
  } as unknown as StrategyNode;
}

function renderTimeline(nodes: StrategyNode[]) {
  return render(
    <StrategyTimeline
      strategyId="strat-1"
      calendar={calendar}
      nodes={nodes}
      congress={[]}
      ppbeLanes={[]}
      ppbeCurrentPhases={[]}
      firmPhases={[]}
      layers={{ ppbe: true, congress: true }}
      selectedId={null}
      onSelectNode={() => {}}
    />,
  );
}

/** The node card is the nearest ancestor that also renders the node's own title text. */
function cardFor(title: string): HTMLElement {
  return screen.getByText(title).closest('div')!.parentElement as HTMLElement;
}

describe('StrategyTimeline — needs-context marker (Phase 5 §6)', () => {
  test('an affected step shows the marker (§9.5)', () => {
    renderTimeline([
      node({
        id: 'n1',
        title: 'File the funding request memo',
        provenance: { contextNeeds: [{ code: 'strategy_brief', label: 'the strategy brief' }] } as never,
      }),
    ]);
    expect(within(cardFor('File the funding request memo')).getByText('needs context')).toBeTruthy();
  });

  test('an unaffected step does not show the marker (§9.6)', () => {
    renderTimeline([node({ id: 'n1', title: 'Host the strategy kickoff', provenance: null })]);
    expect(screen.queryByText('needs context')).toBeNull();
  });

  test('only the affected step shows the marker when steps are mixed (§9.5/§9.6)', () => {
    renderTimeline([
      node({
        id: 'n1',
        title: 'File the funding request memo',
        provenance: { contextNeeds: [{ code: 'strategy_brief', label: 'the strategy brief' }] } as never,
      }),
      node({ id: 'n2', title: 'Host the strategy kickoff', provenance: null }),
    ]);
    expect(within(cardFor('File the funding request memo')).queryByText('needs context')).toBeTruthy();
    expect(within(cardFor('Host the strategy kickoff')).queryByText('needs context')).toBeNull();
  });

  test('the marker is an accessible status with a plain-language label — never a raw code (§9.7)', () => {
    renderTimeline([
      node({
        id: 'n1',
        title: 'File the funding request memo',
        provenance: {
          contextNeeds: [
            { code: 'strategy_brief', label: 'the strategy brief' },
            { code: 'client_constraints', label: "this client's constraints" },
          ],
        } as never,
      }),
    ]);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-label')).toBe(
      "Needs context: the strategy brief, this client's constraints",
    );
    expect(status.getAttribute('title')).toBe(status.getAttribute('aria-label'));
    expect(status.getAttribute('aria-label')).not.toMatch(/strategy_brief|client_constraints/);
  });

  test('the marker disappears once the server-side gap resolves (re-render with contextNeeds cleared) (§9.8)', () => {
    const { rerender } = renderTimeline([
      node({
        id: 'n1',
        title: 'File the funding request memo',
        provenance: { contextNeeds: [{ code: 'strategy_brief', label: 'the strategy brief' }] } as never,
      }),
    ]);
    expect(screen.getByText('needs context')).toBeTruthy();

    rerender(
      <StrategyTimeline
        strategyId="strat-1"
        calendar={calendar}
        nodes={[node({ id: 'n1', title: 'File the funding request memo', provenance: null })]}
        congress={[]}
        ppbeLanes={[]}
        ppbeCurrentPhases={[]}
        firmPhases={[]}
        layers={{ ppbe: true, congress: true }}
        selectedId={null}
        onSelectNode={() => {}}
      />,
    );
    expect(screen.queryByText('needs context')).toBeNull();
  });
});
