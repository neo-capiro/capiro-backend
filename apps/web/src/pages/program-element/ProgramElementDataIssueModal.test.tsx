import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { ProgramElementDataIssueModal } from './ProgramElementDataIssueModal.js';

vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({}),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    ...actual,
    useMutation: () => ({ mutate: vi.fn(), isPending: false }),
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

function setupBrowserMocks() {
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

describe('ProgramElementDataIssueModal', () => {
  beforeEach(() => {
    setupBrowserMocks();
  });

  test('renders report form with PE code and non-mutation disclaimer', () => {
    render(
      <ProgramElementDataIssueModal open peCode="0603270A" onClose={() => undefined} />,
    );
    expect(screen.getByTestId('pe-data-issue-modal')).toBeInTheDocument();
    expect(screen.getByText(/Report data issue — 0603270A/i)).toBeInTheDocument();
    expect(screen.getByText(/does not change canonical Program Element/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Description/i)).toBeInTheDocument();
  });
});
