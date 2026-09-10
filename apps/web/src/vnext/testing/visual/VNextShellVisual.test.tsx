import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Match the dedicated visual server's module aliases while exercising the real
// shell, Quick Note, notification bell, and fixture page components.
vi.mock('@clerk/clerk-react', () => import('./auth-fixture.js'));
vi.mock('../../../lib/use-api.js', () => import('./api-fixture.js'));

import { VNextShellVisual } from './VNextShellVisual.js';

afterEach(cleanup);

describe('offline visual shell providers', () => {
  it.each(['empty', 'client-crm', 'hillday-wizard'] as const)(
    'renders the %s fixture with the live shell controls',
    (fixture) => {
      const { container } = render(<VNextShellVisual screen={fixture} collapsed={false} />);
      expect(container.querySelector('.capiro-vnext-uui')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Quick Note' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Notifications/ })).toBeInTheDocument();
    },
  );
  it.each(['advocacy', 'facilities'] as const)('renders the %s QA overlay with its real components', (crmOverlay) => {
    render(<VNextShellVisual screen="client-crm" crmOverlay={crmOverlay} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    if (crmOverlay === 'advocacy') {
      expect(screen.getByText('Attribution needs review')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Merge another matter into this one' })).toBeInTheDocument();
    } else {
      expect(screen.getByText('U.S. House source: Manual')).toBeInTheDocument();
      expect(screen.getByText('Geocoder: Review required')).toBeInTheDocument();
    }
  });

});
