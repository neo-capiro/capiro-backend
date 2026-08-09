import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const preview = vi.hoisted(() => ({ engagement: false }));

vi.mock('../../../../lib/engagement-api-preview.js', () => ({
  isEngagementPreviewActive: () => preview.engagement,
}));

vi.mock('../v2/NewOutreachWizard.js', () => ({
  NewOutreachWizard: () => <div>Classic Outreach test surface</div>,
}));

vi.mock('./OutreachV3Route.js', () => ({
  OutreachV3Route: () => <div>Outreach V3 test surface</div>,
}));

import { OutreachWizardRouter } from './OutreachWizardRouter.js';

const props = {
  clients: [],
  selectedClientId: null,
  aiConfigured: true,
  emailConnected: true,
  sendFrom: 'neo@example.test',
  sendableInboxes: [],
  onCancel: vi.fn(),
  onComplete: vi.fn(),
};

function renderRouter(entry: string, overrides: Record<string, unknown> = {}) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <OutreachWizardRouter {...props} {...overrides} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  preview.engagement = false;
  window.sessionStorage.clear();
});

describe('OutreachWizardRouter', () => {
  it('renders Classic Outreach by default', () => {
    renderRouter('/engagement?tab=outreach');
    expect(screen.getByText('Classic Outreach test surface')).toBeInTheDocument();
  });

  it('fails closed when only the V3 UI preview is requested', async () => {
    renderRouter('/engagement?outreach-v3-preview=v3');
    expect(await screen.findByText('Classic Outreach test surface')).toBeInTheDocument();
  });

  it('renders V3 only when both preview modes are active', async () => {
    preview.engagement = true;
    renderRouter('/engagement?outreach-v3-preview=v3');
    expect(await screen.findByText('Outreach V3 test surface')).toBeInTheDocument();
  });

  it('always sends existing v2 records and drafts to Classic Outreach', async () => {
    preview.engagement = true;
    window.sessionStorage.setItem('capiro.outreach-v3-preview', 'v3');
    renderRouter('/engagement', { initialDraftId: 'draft-1' });
    expect(await screen.findByText('Classic Outreach test surface')).toBeInTheDocument();
  });

  it('returns to Classic when off is consumed', async () => {
    preview.engagement = true;
    window.sessionStorage.setItem('capiro.outreach-v3-preview', 'v3');
    renderRouter('/engagement?outreach-v3-preview=off');
    expect(await screen.findByText('Classic Outreach test surface')).toBeInTheDocument();
  });
});
