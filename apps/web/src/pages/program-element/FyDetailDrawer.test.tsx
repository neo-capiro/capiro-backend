import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { FyDetailDrawer, sanitizeSourceUrl } from './FyDetailDrawer.js';

describe('FyDetailDrawer', () => {
  test('setup browser mocks', () => {
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
    expect(true).toBe(true);
  });

  test('opens with mock data, renders all sections, and close works', () => {
    const onClose = vi.fn();

    render(
      <FyDetailDrawer
        open
        onClose={onClose}
        peCode="0603270A"
        selectedFy={2026}
        timeline={[
          {
            id: 'y2026',
            fy: 2026,
            request: '266.00',
            hascMark: '269.00',
            sascMark: '268.00',
            hacDMark: '267.00',
            sacDMark: '266.00',
            // Appropriations conference is the reserved (unpopulated) rung; the NDAA
            // authorization conference carries the value post-split.
            conference: null,
            ndaaConference: '270.50',
            enacted: null,
            raw: {
              sourceAttribution: {
                request: 'President Budget',
                ndaaConference: 'NDAA Conference Report',
              },
              sourceLinks: {
                request: 'https://example.gov/request',
                ndaaConference: 'javascript:alert(1)',
              },
              datesAdded: {
                request: '2026-02-01',
                ndaaConference: '2026-09-20',
              },
              notes: 'Conference managers noted electronics sourcing constraints.',
              linkedBills: [{ id: 'HR-123', title: 'FY26 Defense Approps Act' }],
              linkedRules: [
                { id: 'FR-88-1023', title: 'Procurement Notice', topic: 'electronics' },
              ],
            },
          },
        ]}
      />,
    );

    expect(screen.getByText(/FY26 · PE 0603270A/i)).toBeInTheDocument();
    expect(screen.getByText(/1\. Marks/i)).toBeInTheDocument();
    expect(screen.getByText(/2\. Conference report excerpt/i)).toBeInTheDocument();
    expect(screen.getByText(/3\. Linked bills during cycle/i)).toBeInTheDocument();
    expect(screen.getByText(/4\. Linked rules/i)).toBeInTheDocument();

    expect(screen.getByText(/President's Request/i)).toBeInTheDocument();
    expect(screen.getAllByText(/\$266\.00m/i).length).toBeGreaterThan(0);

    // The NDAA/appropriations conference split is reflected as two distinct labeled
    // mark rows: the NDAA authorization conference carries the value ($270.50m); the
    // appropriations conference rung is the reserved (blank) row.
    expect(screen.getByText(/NDAA Conference \(auth\.\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Conference \(approps\.\)/i)).toBeInTheDocument();
    expect(screen.getByText(/\$270\.50m/i)).toBeInTheDocument();

    const safeLink = screen.getByRole('link', { name: /President Budget/i });
    expect(safeLink).toHaveAttribute('href', 'https://example.gov/request');
    expect(safeLink).toHaveAttribute('target', '_blank');

    // unsafe javascript URL should be sanitized away (no clickable NDAA conference source)
    expect(screen.queryByRole('link', { name: /NDAA Conference Report/i })).toBeNull();

    expect(
      screen.getByText(/Conference managers noted electronics sourcing constraints\./i),
    ).toBeInTheDocument();
    expect(screen.getByText(/HR-123/i)).toBeInTheDocument();
    expect(screen.getByText(/FR-88-1023/i)).toBeInTheDocument();

    const closeButtons = screen.getAllByLabelText(/Close/i);
    expect(closeButtons.length).toBeGreaterThan(0);
    fireEvent.click(closeButtons[0]!);
    expect(onClose).toHaveBeenCalled();
  });

  test('empty sections render gracefully', () => {
    render(
      <FyDetailDrawer
        open
        onClose={() => {}}
        peCode="0603270A"
        selectedFy={2025}
        timeline={[
          {
            id: 'y2025',
            fy: 2025,
            request: null,
            hascMark: null,
            sascMark: null,
            hacDMark: null,
            sacDMark: null,
            conference: null,
            enacted: null,
            raw: {},
          },
        ]}
      />,
    );

    expect(screen.getByText(/No conference notes for this FY/i)).toBeInTheDocument();
    expect(screen.getByText(/No linked bills for this FY cycle/i)).toBeInTheDocument();
    expect(screen.getByText(/No linked Federal Register rules for this FY/i)).toBeInTheDocument();
  });

  test('sanitize source links helper', () => {
    expect(sanitizeSourceUrl('https://example.com')).toBe('https://example.com/');
    expect(sanitizeSourceUrl('http://example.com/a')).toBe('http://example.com/a');
    expect(sanitizeSourceUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeSourceUrl('ftp://example.com')).toBeNull();
    expect(sanitizeSourceUrl('')).toBeNull();
  });
});
