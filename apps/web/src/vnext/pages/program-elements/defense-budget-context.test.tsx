import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { ProgramElementSummary } from '../../../pages/program-element/types.js';
import {
  buildDefenseBudgetFyOptions,
  DefenseBudgetContextProvider,
  resolveDefaultDefenseBudgetFy,
  useDefenseBudgetContext,
} from './defense-budget-context.js';

const SUMMARY = {
  latestRequestFy: 2030,
  trend: [
    { fy: 2028, total: 1 },
    { fy: 2029, total: 2 },
  ],
} as ProgramElementSummary;

function Probe() {
  const context = useDefenseBudgetContext();
  const location = useLocation();
  return (
    <>
      <output data-testid="fy">{context.fy}</output>
      <output data-testid="options">{context.fyOptions.join(',')}</output>
      <output data-testid="location">{location.search}</output>
      <button type="button" onClick={() => context.setFy('FY32')}>
        Set FY32
      </button>
      <button type="button" onClick={context.reset}>
        Reset filters
      </button>
    </>
  );
}

function renderProbe(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <DefenseBudgetContextProvider summary={SUMMARY}>
        <Probe />
      </DefenseBudgetContextProvider>
    </MemoryRouter>,
  );
}

describe('DefenseBudgetContextProvider fiscal-year and URL contract', () => {
  it('uses current summary metadata instead of a hard-coded default', () => {
    expect(resolveDefaultDefenseBudgetFy(SUMMARY)).toBe('FY30');
    expect(buildDefenseBudgetFyOptions(SUMMARY)).toEqual([
      'FY27',
      'FY28',
      'FY29',
      'FY30',
      'FY31',
    ]);

    renderProbe('/program-elements?dest=movement');
    expect(screen.getByTestId('fy')).toHaveTextContent('FY30');
  });

  it('retains a valid explicit FY outside the metadata window', () => {
    renderProbe('/program-elements?fy=FY35&dest=movement');
    expect(screen.getByTestId('fy')).toHaveTextContent('FY35');
    expect(screen.getByTestId('options')).toHaveTextContent('FY35');
  });

  it('preserves unrelated query state while changing and resetting owned filters', () => {
    renderProbe(
      '/program-elements?fy=FY35&dest=movement&client=client-1&family=RDT%26E&svc=Army&q=radar&watched=1',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Set FY32' }));
    let search = screen.getByTestId('location').textContent ?? '';
    expect(search).toContain('fy=FY32');
    expect(search).toContain('dest=movement');
    expect(search).toContain('client=client-1');

    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    search = screen.getByTestId('location').textContent ?? '';
    expect(search).toContain('fy=FY32');
    expect(search).toContain('dest=movement');
    expect(search).toContain('client=client-1');
    expect(search).not.toContain('family=');
    expect(search).not.toContain('svc=');
    expect(search).not.toContain('q=');
    expect(search).not.toContain('watched=');
  });
});
