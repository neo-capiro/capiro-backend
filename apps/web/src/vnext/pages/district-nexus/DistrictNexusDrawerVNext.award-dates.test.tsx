import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AwardsSection } from './DistrictNexusDrawerVNext.js';
import type { TopAward } from '../../../pages/intelligence/district-nexus/district-nexus-api.js';

const legacy: TopAward = {
  id: '1',
  label: 'Award',
  counterparty: 'Acme',
  amount: 100,
  awardedAt: '2026-03-01T00:00:00.000Z',
  externalUrl: null,
};

describe('DistrictNexusDrawerVNext award dates', () => {
  it('renders the legacy payload under the Awarded header', () => {
    render(<AwardsSection awards={[legacy]} emptyText="none" />);
    expect(screen.getByText('Awarded')).toBeInTheDocument();
    expect(screen.getByText(new Date(legacy.awardedAt!).toLocaleDateString('en-US'))).toBeInTheDocument();
  });

  it('labels corrected fallback values as latest action', () => {
    render(
      <AwardsSection
        awards={[{ ...legacy, awardedAtSemantics: 'latest_action' }]}
        emptyText="none"
      />,
    );
    expect(screen.getByText('Latest action')).toBeInTheDocument();
    expect(screen.getByText(new Date(legacy.awardedAt!).toLocaleDateString('en-US'))).toBeInTheDocument();
  });
});
