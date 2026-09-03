import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const preview = vi.hoisted(() => ({ engagement: false, vnext: false }));

vi.mock('../../../../env.js', () => ({
  get isVNextSurface() {
    return preview.vnext;
  },
}));

vi.mock('../../../../lib/engagement-api-preview.js', () => ({
  isEngagementPreviewActive: () => preview.engagement,
  activateEngagementPreview: () => { preview.engagement = true; },
  clearEngagementPreview: () => { preview.engagement = false; },
}));

vi.mock('../v2/NewOutreachWizard.js', () => ({
  NewOutreachWizard: () => <div>Classic Outreach test surface</div>,
}));

vi.mock('./OutreachV3CompleteRoute.js', () => ({
  OutreachV3CompleteRoute: ({ onOpenClassic }: { onOpenClassic: () => void }) => (
    <div>
      Outreach V3 test surface
      <button type="button" onClick={onOpenClassic}>
        open-classic
      </button>
    </div>
  ),
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
  preview.vnext = false;
  window.sessionStorage.clear();
});

describe('OutreachWizardRouter', () => {
  it('renders Classic Outreach by default on the canonical app surface', () => {
    renderRouter('/engagement?tab=outreach');
    expect(screen.getByText('Classic Outreach test surface')).toBeInTheDocument();
  });

  it('renders Classic Outreach for a new campaign on vNext too (owner decision 2026-09-03)', () => {
    // `isVNextSurface` used to auto-select V3 here. It is no longer a trigger:
    // os.capiro.ai and app.capiro.ai route identically, Classic by default.
    preview.vnext = true;
    renderRouter('/engagement/outreach');
    expect(screen.getByText('Classic Outreach test surface')).toBeInTheDocument();
    expect(screen.queryByText('Outreach V3 test surface')).not.toBeInTheDocument();
  });

  it('still renders V3 on vNext when BOTH explicit preview switches are active', async () => {
    preview.vnext = true;
    preview.engagement = true;
    window.sessionStorage.setItem('capiro.outreach-v3-preview', 'v3');
    renderRouter('/engagement/outreach');
    expect(await screen.findByText('Outreach V3 test surface')).toBeInTheDocument();
  });

  it('lets a V3 preview user deliberately fall back to Classic', async () => {
    preview.vnext = true;
    preview.engagement = true;
    window.sessionStorage.setItem('capiro.outreach-v3-preview', 'v3');
    renderRouter('/engagement/outreach');
    fireEvent.click(await screen.findByRole('button', { name: 'open-classic' }));
    expect(await screen.findByText('Classic Outreach test surface')).toBeInTheDocument();
  });

  it('couples V3 UI preview with engagement-api preview, rendering V3 when either is activated', async () => {
    // With the coupling fix, activating outreach-v3-preview also activates
    // engagement-api-preview, so V3 renders even when the user only sets
    // one of the two switches.
    renderRouter('/engagement?outreach-v3-preview=v3');
    expect(await screen.findByText('Outreach V3 test surface')).toBeInTheDocument();
  });

  it('renders V3 only when both preview modes are active on the canonical app', async () => {
    preview.engagement = true;
    renderRouter('/engagement?outreach-v3-preview=v3');
    expect(await screen.findByText('Outreach V3 test surface')).toBeInTheDocument();
  });

  it('always sends existing v2 records and drafts to Classic Outreach', async () => {
    preview.engagement = true;
    preview.vnext = true;
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
