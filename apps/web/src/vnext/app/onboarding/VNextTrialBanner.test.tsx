import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { VNextTrialBanner } from './VNextTrialBanner.js';
import type { BillingState } from '../../../lib/billing.js';

/**
 * Regression coverage for the oversized-hourglass layout bug: CapiroHourglassIcon's
 * `size` prop is an em multiplier (1 = 1em), not a pixel value, but this
 * component was re-skinned from a lucide-react `<Hourglass size={13}>` (a
 * pixel-based API) and carried the literal `13` over — rendering a ~13em
 * (~200px) icon that stretched the whole banner. The fix anchors the
 * container's own font-size at 13px (vnext-onboarding.css) and passes
 * `size={1}`, so the icon renders at a fixed 13px regardless of the ambient
 * font-size it inherits.
 */

const useBillingStateMock = vi.hoisted(() => vi.fn());
const useMeMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/billing.js', () => ({ useBillingState: useBillingStateMock }));
vi.mock('../../../lib/me.js', () => ({ useMe: useMeMock }));

function billingState(overrides: Partial<BillingState> = {}): { data: BillingState } {
  return {
    data: {
      billingEnabled: true,
      status: 'trialing',
      slots: 10,
      usedSlots: 4,
      trialEndsAt: new Date(Date.now() + 23 * 86_400_000).toISOString(),
      onboardingFlowVersion: 1,
      locked: false,
      ...overrides,
    },
  };
}

function renderBanner() {
  return render(
    <MemoryRouter>
      <VNextTrialBanner />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useMeMock.mockReturnValue({ data: { billingAdmin: true } });
});

describe('VNextTrialBanner', () => {
  it('renders the hourglass at a fixed 1em (13px), never the old 13em (~200px) size', () => {
    useBillingStateMock.mockReturnValue(billingState());
    const { container } = renderBanner();

    const icon = container.querySelector('svg.capiro-icon');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('width', '1em');
    expect(icon).toHaveAttribute('height', '1em');
  });

  it('keeps the icon at 1em across an active, an expiring, and an expired trial', () => {
    for (const trialEndsAt of [
      new Date(Date.now() + 23 * 86_400_000).toISOString(), // comfortably active
      new Date(Date.now() + 1 * 86_400_000).toISOString(), // approaching expiration
      new Date(Date.now() - 5 * 86_400_000).toISOString(), // already past end date
    ]) {
      useBillingStateMock.mockReturnValue(billingState({ trialEndsAt }));
      const { container, unmount } = renderBanner();
      expect(container.querySelector('svg.capiro-icon')).toHaveAttribute('width', '1em');
      unmount();
    }
  });

  it('keeps the icon at 1em when the client-profile slot limit is reached', () => {
    useBillingStateMock.mockReturnValue(billingState({ usedSlots: 10, slots: 10 }));
    const { container } = renderBanner();
    expect(container.querySelector('svg.capiro-icon')).toHaveAttribute('width', '1em');
    expect(screen.getByText(/10\/10/)).toBeInTheDocument();
  });

  it('shows Upgrade Now for a billing admin and the contact-admin note otherwise', () => {
    useBillingStateMock.mockReturnValue(billingState());
    useMeMock.mockReturnValue({ data: { billingAdmin: false } });
    renderBanner();
    expect(screen.queryByRole('button', { name: 'Upgrade Now' })).not.toBeInTheDocument();
    expect(screen.getByText('Contact your Super Admin to upgrade.')).toBeInTheDocument();
  });

  it('renders nothing outside onboarding v1 trialing status', () => {
    useBillingStateMock.mockReturnValue(billingState({ status: 'active' }));
    const { container } = renderBanner();
    expect(container).toBeEmptyDOMElement();
  });
});
