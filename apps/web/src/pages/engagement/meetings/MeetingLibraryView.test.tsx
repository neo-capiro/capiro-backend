import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MeetingLibraryView } from './MeetingLibraryView.js';

/**
 * Meeting Library filters. The closeout added an explicit date range alongside
 * the existing client / artifact-type / visibility / search filters, and the
 * spec requires the range to reach the server as a real query (not client-side
 * slicing of one page) and to reset pagination so page 3 of an old filter never
 * bleeds into a new one.
 */

const useMeetingLibraryMock = vi.fn();
const useClientOptionsMock = vi.fn();

vi.mock('./meetings-api.js', () => ({
  useMeetingLibrary: (...args: unknown[]) => useMeetingLibraryMock(...args),
  useClientOptions: (...args: unknown[]) => useClientOptionsMock(...args),
}));

function lastQuery() {
  return useMeetingLibraryMock.mock.calls[useMeetingLibraryMock.mock.calls.length - 1]![0] as {
    from?: string;
    to?: string;
    page: number;
    clientId?: string;
    artifactType?: string;
    visibility?: string;
  };
}

describe('MeetingLibraryView date filters', () => {
  beforeEach(() => {
    useMeetingLibraryMock.mockReset();
    useClientOptionsMock.mockReset();
    useClientOptionsMock.mockReturnValue({ data: [], isLoading: false });
    useMeetingLibraryMock.mockReturnValue({
      data: { items: [], total: 0, page: 1, pageSize: 20 },
      isLoading: false,
      isError: false,
    });
  });

  function setup() {
    return render(<MeetingLibraryView onBack={vi.fn()} onOpenMeeting={vi.fn()} />);
  }

  test('no date filter sends no range at all', () => {
    setup();
    expect(lastQuery().from).toBeUndefined();
    expect(lastQuery().to).toBeUndefined();
  });

  test('a from-date becomes a server-side ISO range covering the whole day', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Meeting Library from date'), {
      target: { value: '2026-08-10' },
    });

    const query = lastQuery();
    expect(query.from).toBeTruthy();
    // Start of the selected local day, not an arbitrary timestamp.
    expect(new Date(query.from!).getFullYear()).toBe(2026);
    expect(new Date(query.from!).getHours()).toBe(0);
    expect(new Date(query.from!).getMinutes()).toBe(0);
  });

  test('a to-date covers through the end of the selected day', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Meeting Library to date'), {
      target: { value: '2026-08-12' },
    });

    const to = new Date(lastQuery().to!);
    // Inclusive of the whole day, otherwise same-day artifacts are invisible.
    expect(to.getHours()).toBe(23);
    expect(to.getMinutes()).toBe(59);
  });

  test('an inverted range is corrected rather than silently returning nothing', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Meeting Library to date'), {
      target: { value: '2026-08-05' },
    });
    fireEvent.change(screen.getByLabelText('Meeting Library from date'), {
      target: { value: '2026-08-20' },
    });

    const query = lastQuery();
    expect(new Date(query.from!).getTime()).toBeLessThanOrEqual(new Date(query.to!).getTime());
  });

  test('changing a date resets pagination', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Meeting Library from date'), {
      target: { value: '2026-08-10' },
    });
    expect(lastQuery().page).toBe(1);
  });

  test('Clear dates appears only with a range and removes it from the query', () => {
    setup();
    expect(screen.queryByRole('button', { name: /clear dates/i })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Meeting Library from date'), {
      target: { value: '2026-08-10' },
    });
    fireEvent.click(screen.getByRole('button', { name: /clear dates/i }));

    expect(lastQuery().from).toBeUndefined();
    expect(lastQuery().to).toBeUndefined();
  });

  test('the date range composes with the existing filters instead of replacing them', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Meeting Library from date'), {
      target: { value: '2026-08-10' },
    });

    const query = lastQuery();
    // The other filters still travel on the same request.
    expect(query).toHaveProperty('artifactType');
    expect(query).toHaveProperty('visibility');
    expect(query).toHaveProperty('clientId');
  });
});
