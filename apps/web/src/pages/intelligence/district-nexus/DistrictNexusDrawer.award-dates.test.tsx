import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AwardsSection } from './DistrictNexusDrawer.js';
import type { TopAward } from './district-nexus-api.js';

const legacy: TopAward = {
  id: '1',
  label: 'Award',
  counterparty: 'Acme',
  amount: 100,
  awardedAt: '2026-03-01T00:00:00.000Z',
  externalUrl: null,
};

describe('DistrictNexusDrawer award dates', () => {
  it('renders the legacy payload exactly under the Awarded header', () => {
    render(<AwardsSection awards={[legacy]} emptyText="none" />);
    expect(screen.getByText('Awarded')).toBeInTheDocument();
    expect(screen.getByText(new Date(legacy.awardedAt!).toLocaleDateString('en-US'))).toBeInTheDocument();
  });

  it('renders base-signed semantics and date', () => {
    render(
      <AwardsSection
        awards={[{ ...legacy, awardedAtSemantics: 'base_award_signed', baseAwardSignedDate: '2026-02-15T00:00:00.000Z' }]}
        emptyText="none"
      />,
    );
    expect(screen.getByText('Awarded (base signed)')).toBeInTheDocument();
    expect(screen.getByText(new Date('2026-02-15T00:00:00.000Z').toLocaleDateString('en-US'))).toBeInTheDocument();
  });
});
