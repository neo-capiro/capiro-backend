import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  activateEngagementPreview,
  ENGAGEMENT_PREVIEW_STORAGE_KEY,
} from '../../lib/engagement-api-preview.js';
import {
  ENGAGEMENT_PREVIEW_INDICATOR_LABEL,
  EngagementApiPreviewIndicator,
  turnOffEngagementPreview,
} from './EngagementApiPreviewIndicator.js';

function renderIndicator() {
  return render(
    <MemoryRouter initialEntries={['/settings/integrations?clientId=keep-me']}>
      <EngagementApiPreviewIndicator />
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

  test('turn-off clears only preview mode and preserves the current URL', () => {
    activateEngagementPreview();
    const before = window.location.href;
    const reload = vi.fn();

    turnOffEngagementPreview(reload);

    expect(window.sessionStorage.getItem(ENGAGEMENT_PREVIEW_STORAGE_KEY)).toBeNull();
    expect(window.location.href).toBe(before);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
