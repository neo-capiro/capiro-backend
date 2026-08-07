import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test } from 'vitest';
import { activateEngagementPreview } from '../../lib/engagement-api-preview.js';
import {
  ENGAGEMENT_PREVIEW_INDICATOR_LABEL,
  EngagementApiPreviewIndicator,
  previewTurnOffSearch,
} from './EngagementApiPreviewIndicator.js';

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="location">{`${location.pathname}${location.search}${location.hash}`}</output>;
}

function renderIndicator() {
  return render(
    <MemoryRouter initialEntries={['/settings/integrations?clientId=keep-me#account']}>
      <EngagementApiPreviewIndicator />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('EngagementApiPreviewIndicator', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  test('is absent in normal mode', () => {
    renderIndicator();
    expect(screen.queryByLabelText('Engagement API preview status')).toBeNull();
  });

  test('shows only fixed preview copy and an accessible turn-off control', () => {
    activateEngagementPreview();
    renderIndicator();

    expect(screen.getByRole('status')).toHaveTextContent(ENGAGEMENT_PREVIEW_INDICATOR_LABEL);
    const button = screen.getByRole('button', { name: 'Turn off preview' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).not.toHaveAttribute('disabled');
    button.focus();
    expect(document.activeElement).toBe(button);

    const visible = screen.getByLabelText('Engagement API preview status').textContent ?? '';
    for (const forbidden of ['Bearer ', 'tenantId', 'clientId', 'targetId', 'DATABASE_URL', 'arn:aws']) {
      expect(visible).not.toContain(forbidden);
    }
  });

  test('turn-off preserves pathname, hash, and unrelated query state', async () => {
    activateEngagementPreview();
    renderIndicator();

    fireEvent.click(screen.getByRole('button', { name: 'Turn off preview' }));

    await waitFor(() =>
      expect(screen.getByLabelText('location')).toHaveTextContent(
        '/settings/integrations?clientId=keep-me&engagement-api-preview=off#account',
      ),
    );
  });

  test('pure search helper replaces an existing control value without dropping state', () => {
    expect(previewTurnOffSearch('?meetingId=m1&engagement-api-preview=v3&detail=notes')).toBe(
      '?meetingId=m1&engagement-api-preview=off&detail=notes',
    );
  });
});
