import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ResearchClarifyForm } from './ResearchClarifyForm.js';

describe('ResearchClarifyForm — free-text questions (Deep Research, unchanged shape)', () => {
  it('submits free-text answers keyed by question index, and shows Skip by default', () => {
    const onSubmit = vi.fn();
    render(<ResearchClarifyForm questions={['What is the deadline?']} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText('What is the deadline?'), { target: { value: 'Friday' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run deep research' }));
    expect(onSubmit).toHaveBeenCalledWith({ '0': 'Friday' }, false);
    expect(screen.getByRole('button', { name: /Skip/ })).toBeInTheDocument();
  });

  it('Skip submits with skipped=true and no answers', () => {
    const onSubmit = vi.fn();
    render(<ResearchClarifyForm questions={['What is the deadline?']} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /Skip/ }));
    expect(onSubmit).toHaveBeenCalledWith({}, true);
  });
});

describe('ResearchClarifyForm — choice-bearing question', () => {
  it('renders radio choices for a single-select question and submits the chosen value', () => {
    const onSubmit = vi.fn();
    render(
      <ResearchClarifyForm
        questions={[{ question: 'Which client?', choices: ['Acme', 'Globex'], multiSelect: false }]}
        allowSkip={false}
        submitLabel="Send answer"
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByText('Which client?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Acme' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(onSubmit).toHaveBeenCalledWith({ '0': 'Acme' }, false);
    // A durable clarification has no "proceed without answering" fallback.
    expect(screen.queryByRole('button', { name: /Skip/ })).not.toBeInTheDocument();
  });

  it('renders checkboxes for a multiSelect question and joins the chosen values', () => {
    const onSubmit = vi.fn();
    render(
      <ResearchClarifyForm
        questions={[{ question: 'Which programs?', choices: ['A', 'B', 'C'], multiSelect: true }]}
        allowSkip={false}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'A' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'C' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run deep research' }));
    expect(onSubmit).toHaveBeenCalledWith({ '0': 'A, C' }, false);
  });

  it('toggling a checkbox off removes it from the submitted selection', () => {
    const onSubmit = vi.fn();
    render(
      <ResearchClarifyForm
        questions={[{ question: 'Which programs?', choices: ['A', 'B'], multiSelect: true }]}
        allowSkip={false}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'A' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'B' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'A' })); // toggle off
    fireEvent.click(screen.getByRole('button', { name: 'Run deep research' }));
    expect(onSubmit).toHaveBeenCalledWith({ '0': 'B' }, false);
  });

  it('respects a custom headline', () => {
    render(
      <ResearchClarifyForm
        questions={[{ question: 'Which client?', choices: ['Acme'] }]}
        headline="Meri is waiting for your answer"
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText('Meri is waiting for your answer')).toBeInTheDocument();
  });
});
