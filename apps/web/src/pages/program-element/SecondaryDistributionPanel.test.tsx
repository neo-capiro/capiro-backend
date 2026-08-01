import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { SecondaryDistributionPanel, fmtDollars, fmtQty } from './SecondaryDistributionPanel.js';
import type { ProcurementLinesResponse } from './types.js';

function setupAntdBrowserMocks() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
}

function data(): ProcurementLinesResponse {
  return {
    peCode: '8205G14510',
    years: [2026, 2027],
    recipients: [
      {
        recipient: 'Army',
        fyRows: [
          { fy: 2026, quantity: 26203, dollars: 258495000, unitCost: null },
          { fy: 2027, quantity: 16132, dollars: 159166000, unitCost: null },
        ],
      },
      {
        recipient: 'ANG',
        fyRows: [{ fy: 2027, quantity: 22009, dollars: 213475000, unitCost: null }],
      },
    ],
    sourceUrl: 'https://example.gov/wtcv.pdf',
    totalRows: 3,
  };
}

describe('SecondaryDistributionPanel', () => {
  beforeAll(() => setupAntdBrowserMocks());

  test('renders recipients and the source link', () => {
    render(<SecondaryDistributionPanel data={data()} />);
    expect(screen.getByText('Army')).toBeInTheDocument();
    expect(screen.getByText('ANG')).toBeInTheDocument();
    expect(screen.getByText(/2 recipients/)).toBeInTheDocument();
    expect(screen.getByText('Source (P-40)')).toHaveAttribute('href', 'https://example.gov/wtcv.pdf');
  });

  test('honest empty state when no recipients', () => {
    render(
      <SecondaryDistributionPanel
        data={{ peCode: 'X', years: [], recipients: [], sourceUrl: null, totalRows: 0 }}
      />,
    );
    expect(screen.getByText(/No per-recipient procurement breakdown/)).toBeInTheDocument();
  });

  test('errored request shows failed UI, not honesty Empty (B11)', () => {
    render(
      <SecondaryDistributionPanel
        data={undefined}
        loading={false}
        errored
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByTestId('pe-secondary-failed-procurement-lines')).toBeInTheDocument();
    expect(screen.queryByText(/No per-recipient procurement breakdown/)).not.toBeInTheDocument();
    expect(screen.getByTestId('pe-secondary-retry')).toBeInTheDocument();
  });

  test('formatters', () => {
    expect(fmtDollars(159166000)).toBe('$159.17M');
    expect(fmtDollars(2036358000)).toBe('$2.04B');
    expect(fmtDollars(null)).toBe('—');
    expect(fmtQty(16132)).toBe('16,132');
    expect(fmtQty(null)).toBe('—');
  });
});
