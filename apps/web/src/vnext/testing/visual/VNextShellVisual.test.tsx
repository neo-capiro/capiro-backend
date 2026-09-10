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
});
