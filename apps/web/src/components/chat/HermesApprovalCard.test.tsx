import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HermesApprovalCard } from './HermesApprovalCard.js';
import type { MeriHermesApprovalCard } from './meri-hermes-interactions.js';

const card = (over: Partial<MeriHermesApprovalCard> = {}): MeriHermesApprovalCard => ({
  kind: 'approval',
  runId: 'run-1',
  requestId: 'req-1',
  proposalId: 'hermes:run-1:req-1',
  label: 'Run: rm -rf build/',
  command: 'rm -rf build/',
  choices: ['once', 'deny'],
  createdAt: '2026-09-19T00:00:00.000Z',
  expiresAt: '2026-09-19T00:05:00.000Z',
  resolution: null,
  ...over,
});

const nowAt = (iso: string) => () => Date.parse(iso);

describe('HermesApprovalCard', () => {
  it('shows the redacted command and exactly two decisions — Run once / Deny', () => {
    render(<HermesApprovalCard card={card()} onDecide={vi.fn()} now={nowAt('2026-09-19T00:01:00.000Z')} />);
    expect(screen.getByText('rm -rf build/')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run once' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
    // Never offers "always"/"session" — Meri deliberately does not expose those (contracts.md §3).
    expect(screen.queryByText(/always/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/session/i)).not.toBeInTheDocument();
  });

  it('calls onDecide with approve_once when Run once is clicked', () => {
    const onDecide = vi.fn();
    render(<HermesApprovalCard card={card()} onDecide={onDecide} now={nowAt('2026-09-19T00:01:00.000Z')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run once' }));
    expect(onDecide).toHaveBeenCalledWith('approve_once');
  });

  it('calls onDecide with deny when Deny is clicked', () => {
    const onDecide = vi.fn();
    render(<HermesApprovalCard card={card()} onDecide={onDecide} now={nowAt('2026-09-19T00:01:00.000Z')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onDecide).toHaveBeenCalledWith('deny');
  });

  it('shows an expired state instead of decision buttons once expiresAt has passed', () => {
    render(<HermesApprovalCard card={card()} onDecide={vi.fn()} now={nowAt('2026-09-19T00:06:00.000Z')} />);
    expect(screen.getByText(/expired/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run once' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument();
  });

  it('shows a no-longer-actionable state instead of buttons when the run that asked has ended', () => {
    // A native approval is a live_process continuation: the worker blocked on
    // it is gone, so the backend refuses the decision. Leaving Run once/Deny
    // on screen would be a button that silently fails.
    render(
      <HermesApprovalCard
        card={card({ runTerminal: true, expiresAt: null })}
        onDecide={vi.fn()}
        now={nowAt('2026-09-19T00:01:00.000Z')}
      />,
    );
    expect(screen.getByText(/run has ended/i)).toBeInTheDocument();
    expect(screen.getByText(/never run/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run once' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument();
  });

  it('still shows a real decision the user made, even after the run ended', () => {
    render(
      <HermesApprovalCard
        card={card({ runTerminal: true, resolution: { decision: 'approve_once', at: '2026-09-19T00:02:00.000Z' } })}
        onDecide={vi.fn()}
        now={nowAt('2026-09-19T00:03:00.000Z')}
      />,
    );
    expect(screen.getByText(/run this once/i)).toBeInTheDocument();
    expect(screen.queryByText(/run has ended/i)).not.toBeInTheDocument();
  });

  it('shows the resolved outcome instead of decision buttons once a decision was made', () => {
    render(
      <HermesApprovalCard
        card={card({ resolution: { decision: 'deny', at: '2026-09-19T00:02:00.000Z' } })}
        onDecide={vi.fn()}
        now={nowAt('2026-09-19T00:03:00.000Z')}
      />,
    );
    expect(screen.getByText(/denied/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument();
  });

  it('shows an approved-once outcome distinctly from denied', () => {
    render(
      <HermesApprovalCard
        card={card({ resolution: { decision: 'approve_once', at: '2026-09-19T00:02:00.000Z' } })}
        onDecide={vi.fn()}
        now={nowAt('2026-09-19T00:03:00.000Z')}
      />,
    );
    expect(screen.getByText(/run this once/i)).toBeInTheDocument();
  });

  it('surfaces a transient error if the decision fails, without crashing', async () => {
    const onDecide = vi.fn().mockRejectedValue(new Error('network down'));
    render(<HermesApprovalCard card={card()} onDecide={onDecide} now={nowAt('2026-09-19T00:01:00.000Z')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run once' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
  });

  it('disables both actions while busy', () => {
    render(<HermesApprovalCard card={card()} onDecide={vi.fn()} busy now={nowAt('2026-09-19T00:01:00.000Z')} />);
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
  });
});
