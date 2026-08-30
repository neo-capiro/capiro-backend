import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RecordDrawer } from './RecordDrawer.js';

describe('prototype client-record drawer shell', () => {
  it('uses the wide prototype geometry and compact edge-to-edge chrome', () => {
    render(
      <RecordDrawer
        eyebrow="Overland AI"
        title="Relationships"
        sub="Current targets and client people."
        onClose={() => undefined}
      >
        <div data-testid="drawer-content">content</div>
      </RecordDrawer>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Relationships' });
    const panel = dialog.querySelector('aside');
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute('data-drawer-variant', 'record');
    expect(panel).toHaveStyle({ maxWidth: 'none' });
    expect(screen.getByText('Overland AI')).toBeInTheDocument();

    const content = screen.getByTestId('drawer-content');
    expect(content.parentElement).toHaveStyle({ padding: '0' });
  });
});
