import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { RadarPage } from './RadarPage.js';

vi.mock('./LegacyRadarPage.js', () => ({
  default: () => <div data-testid="legacy-radar">Legacy LegiWatch surface</div>,
  tenantBoardCardMatchesFilter: vi.fn(),
  tenantBoardChangeTone: vi.fn(),
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderPage(entry = '/legiwatch') {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <RadarPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('LegiWatch Phase 1 shell', () => {
  test('presents exactly the three product sections', () => {
    renderPage();

    expect(screen.getByRole('button', { name: /Bill Tracker/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('button', { name: /Live Hearings/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Settings/i })).toBeInTheDocument();
    expect(screen.getByTestId('legacy-radar')).toBeInTheDocument();
  });

  test('maps Live Hearings and Settings onto the compatible legacy URLs', () => {
    renderPage('/legiwatch?client=c1');

    fireEvent.click(screen.getByRole('button', { name: /Live Hearings/i }));
    expect(screen.getByTestId('location')).toHaveTextContent('/legiwatch?client=c1&tab=hearings');

    fireEvent.click(screen.getByRole('button', { name: /Settings/i }));
    expect(screen.getByTestId('location')).toHaveTextContent('/legiwatch?client=c1&tab=watchlist');
  });

  test('keeps Feed and Bills as internal Bill Tracker views', () => {
    renderPage('/legiwatch?tab=bills');

    expect(screen.getByRole('button', { name: /Bill Tracker/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('button', { name: 'Tracked Bills' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Activity Feed' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/legiwatch?tab=feed');
  });

  test('canonicalizes pre-LegiWatch view links without dropping context', async () => {
    renderPage('/legiwatch?view=hearings&client=c1&alert=a1');

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/legiwatch?client=c1&alert=a1&tab=hearings',
      ),
    );
    expect(screen.getByRole('button', { name: /Live Hearings/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
