import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import {
  DefenseBudgetContextBar,
  DefenseBudgetContextProvider,
  familyById,
  serviceToApiParam,
  useDefenseBudgetContext,
} from './defense-budget-context.js';

function Harness() {
  return (
    <DefenseBudgetContextProvider>
      <DefenseBudgetContextBar />
      <ScopeReadout />
    </DefenseBudgetContextProvider>
  );
}

function ScopeReadout() {
  const ctx = useDefenseBudgetContext();
  return (
    <div data-testid="scope">
      {ctx.fy}|{ctx.family}|{ctx.service}|{ctx.q}|{String(ctx.watchedOnly)}
    </div>
  );
}

function renderAt(path = '/program-elements') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Harness />
    </MemoryRouter>,
  );
}

describe('familyById / serviceToApiParam', () => {
  it('has honest sparse coverage: RDT&E/Procurement/O&M/MILCON map to real line types, MILPERS/WCF/Health do not', () => {
    expect(familyById('RDT&E').lineType).toBe('RDTE_PE');
    expect(familyById('Procurement').lineType).toBe('PROCUREMENT_BLIN');
    expect(familyById('O&M').lineType).toBe('OM_BLI');
    expect(familyById('MILCON').lineType).toBe('MILCON_PROJECT');
    expect(familyById('MILPERS').lineType).toBeUndefined();
    expect(familyById('WCF').lineType).toBeUndefined();
    expect(familyById('Health').lineType).toBeUndefined();
  });

  it('MILCON has lifecycle source-family coverage even without a guaranteed line-level row (task §9 example)', () => {
    expect(familyById('MILCON').sourceFamilies).toEqual(
      expect.arrayContaining(['pb_milcon_c1', 'pb_dd1391']),
    );
    expect(familyById('MILPERS').sourceFamilies).toBeUndefined();
  });

  it('maps a service label to the real API code, and "All" to undefined', () => {
    expect(serviceToApiParam('Army')).toBe('ARMY');
    expect(serviceToApiParam('Marine Corps')).toBe('USMC');
    expect(serviceToApiParam('All')).toBeUndefined();
  });
});

describe('DefenseBudgetContextProvider — URL state', () => {
  it('defaults to FY27, all families, all services, no search, not watched-only', () => {
    renderAt();
    expect(screen.getByTestId('scope')).toHaveTextContent('FY27|All|All||false');
  });

  it('reads an explicit ?fy= from the URL', () => {
    renderAt('/program-elements?fy=FY24');
    expect(screen.getByTestId('scope').textContent).toMatch(/^FY24\|/);
  });

  it('falls back to the default FY for an unknown ?fy= value rather than crashing', () => {
    renderAt('/program-elements?fy=FY99');
    expect(screen.getByTestId('scope').textContent).toMatch(/^FY27\|/);
  });

  it('clicking a fiscal year chip updates the shared scope', () => {
    renderAt();
    fireEvent.click(screen.getByRole('button', { name: 'FY24' }));
    expect(screen.getByTestId('scope').textContent).toMatch(/^FY24\|/);
  });

  it('toggling watched-only flows through to every consumer', () => {
    renderAt();
    fireEvent.click(screen.getByRole('checkbox', { name: /watched only/i }));
    expect(screen.getByTestId('scope')).toHaveTextContent('|true');
  });

  it('Reset clears family/service/search/watched but leaves FY untouched', () => {
    renderAt('/program-elements?fy=FY26&family=MILCON&svc=Army&q=radar&watched=1');
    expect(screen.getByTestId('scope')).toHaveTextContent('FY26|MILCON|Army|radar|true');
    fireEvent.click(screen.getByRole('button', { name: /Reset/ }));
    expect(screen.getByTestId('scope')).toHaveTextContent('FY26|All|All||false');
  });

  it('throws a clear error when the hook is used outside the provider', () => {
    function Bare() {
      useDefenseBudgetContext();
      return null;
    }
    // Swallow the expected React error-boundary console noise for this one assertion.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Bare />)).toThrow('useDefenseBudgetContext must be used within DefenseBudgetContextProvider');
    spy.mockRestore();
  });
});
