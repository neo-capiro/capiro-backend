import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { App as AntApp } from 'antd';
import {
  DibbsAwardIntelligenceRow,
  DibbsOpportunityCard,
  formatDibbsPartIdentity,
  formatDibbsQuantity,
  type DibbsAwardContext,
  type DibbsSolicitationFacts,
} from './DibbsOpportunityCard.js';

/**
 * P41 — the DIBBS card's acceptance, asserted against RENDERED TEXT.
 *
 * The two rules worth testing this way rather than by review:
 *   - awards never offer Pursue;
 *   - unknown quantity/value remains unknown — never 0, never $0.
 *
 * The zero assertions are deliberately written against the rendered output
 * rather than the props, because the failure mode being guarded is a formatter
 * turning a null into a falsy-coalesced `0` on the way to the screen.
 */

function rfq(over: Partial<DibbsSolicitationFacts> = {}): DibbsSolicitationFacts {
  return {
    documentType: 'rfq',
    solicitation: 'SPE4A625T1234',
    solicitationFormatted: null,
    nsn: '5340-01-234-5678',
    partNumber: 'MS21042L4',
    nomenclature: 'BRACKET, ANGLE',
    quantity: '500',
    unitOfIssue: 'EA',
    setAside: null,
    buyerCode: null,
    closesDate: '2026-09-01T00:00:00.000Z',
    isOpen: true,
    documentUrl: 'https://example.invalid/doc.pdf',
    techDocsUrl: null,
    ...over,
  };
}

function rfp(over: Partial<DibbsSolicitationFacts> = {}): DibbsSolicitationFacts {
  return {
    ...rfq(),
    documentType: 'rfp',
    quantity: null,
    unitOfIssue: null,
    setAside: null,
    buyerCode: 'PZ12',
    techDocsUrl: 'https://example.invalid/tech.pdf',
    ...over,
  };
}

function award(over: Partial<DibbsAwardContext> = {}): DibbsAwardContext {
  return {
    awardNumber: 'SPE4A624P0001',
    awardeeLegalBusinessName: 'Some Other Machining Co',
    isOwnAward: false,
    priceIsUnknown: false,
    totalContractPriceText: '$12,500.00',
    awardDate: '2026-02-01T00:00:00.000Z',
    ...over,
  };
}

function renderCard(props: Partial<Parameters<typeof DibbsOpportunityCard>[0]> = {}) {
  return render(
    <AntApp>
      <DibbsOpportunityCard
        facts={rfq()}
        clientName="Example Precision LLC"
        relevanceScore={72}
        partProfileGap={null}
        onSelectClient={vi.fn()}
        onOpenDetail={vi.fn()}
        {...props}
      />
    </AntApp>,
  );
}

describe('P41 unknown stays unknown', () => {
  test('an RFQ with no quantity says the source did not state it, and never renders 0', () => {
    renderCard({ facts: rfq({ quantity: null, unitOfIssue: null }) });

    const quantity = screen.getByTestId('fo-dibbs-quantity');
    expect(quantity).toHaveTextContent('Not stated by the source');
    expect(quantity.textContent).not.toMatch(/\b0\b/);
  });

  test('an RFP names the document type rather than reporting a source gap', () => {
    renderCard({ facts: rfp() });

    expect(screen.getByTestId('fo-dibbs-quantity')).toHaveTextContent('Not stated on a request for proposal');
  });

  test('a quantity arriving without its unit is treated as unstated, never rendered bare', () => {
    renderCard({ facts: rfq({ quantity: '500', unitOfIssue: null }) });

    const quantity = screen.getByTestId('fo-dibbs-quantity');
    expect(quantity).toHaveTextContent('Not stated by the source');
    expect(quantity.textContent).not.toMatch(/500/);
  });

  test('a quantity with its unit renders both', () => {
    renderCard();

    expect(screen.getByTestId('fo-dibbs-quantity')).toHaveTextContent('500 EA');
  });

  test('no closing date says so rather than rendering an empty slot', () => {
    renderCard({ facts: rfq({ closesDate: null }) });

    expect(screen.getByTestId('fo-dibbs-closes')).toHaveTextContent('Not stated by the source');
  });

  test('an unscored item says "Not scored yet", never 0', () => {
    renderCard({ relevanceScore: null });

    const relevance = screen.getByTestId('fo-dibbs-relevance');
    expect(relevance).toHaveTextContent('Not scored yet');
    expect(relevance.textContent).not.toMatch(/\b0\b/);
  });

  test('a genuine score of 0 renders as 0 — the null case must not swallow a real zero', () => {
    renderCard({ relevanceScore: 0 });

    expect(screen.getByTestId('fo-dibbs-relevance')).toHaveTextContent('0');
  });

  test('no NSN and no part number is stated explicitly', () => {
    renderCard({ facts: rfq({ nsn: null, partNumber: null }) });

    expect(screen.getByTestId('fo-dibbs-part')).toHaveTextContent('No NSN or part number stated');
  });
});

describe('P41 awards never offer Pursue', () => {
  test('the award row renders no button at all', () => {
    const { container } = render(
      <AntApp>
        <DibbsAwardIntelligenceRow award={award()} />
      </AntApp>,
    );

    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  test('a null award price never renders as $0', () => {
    render(
      <AntApp>
        <DibbsAwardIntelligenceRow
          award={award({ priceIsUnknown: true, totalContractPriceText: null })}
        />
      </AntApp>,
    );

    const row = screen.getByTestId('fo-dibbs-award-SPE4A624P0001');
    expect(row).toHaveTextContent('No award price stated');
    expect(row.textContent).not.toMatch(/\$\s?0/);
  });

  test("the provider's own display text is kept when the numeric price is absent", () => {
    render(
      <AntApp>
        <DibbsAwardIntelligenceRow
          award={award({ priceIsUnknown: true, totalContractPriceText: 'See award document' })}
        />
      </AntApp>,
    );

    expect(screen.getByTestId('fo-dibbs-award-SPE4A624P0001')).toHaveTextContent('See award document');
  });

  test("another supplier's award is never labelled as the client's", () => {
    render(
      <AntApp>
        <DibbsAwardIntelligenceRow award={award({ isOwnAward: false })} />
      </AntApp>,
    );

    const row = screen.getByTestId('fo-dibbs-award-SPE4A624P0001');
    expect(row).toHaveTextContent('Some Other Machining Co');
    expect(row).not.toHaveTextContent('This client');
  });

  test('an unnamed other supplier does not become the client', () => {
    render(
      <AntApp>
        <DibbsAwardIntelligenceRow award={award({ isOwnAward: false, awardeeLegalBusinessName: null })} />
      </AntApp>,
    );

    expect(screen.getByTestId('fo-dibbs-award-SPE4A624P0001')).toHaveTextContent('Another supplier');
  });

  test('award context on the card is separated from the pursuit controls', () => {
    renderCard({ awards: [award()], onPursue: vi.fn() });

    const intel = screen.getByTestId('fo-dibbs-award-intel');
    const actions = screen.getByTestId('fo-dibbs-actions');

    expect(intel).toBeInTheDocument();
    expect(actions).toBeInTheDocument();
    // The award block contains no action control of its own.
    expect(intel.querySelectorAll('button')).toHaveLength(0);
    expect(actions.contains(intel)).toBe(false);
  });

  test('no pursuit control is rendered at all when the caller supplies no handler', () => {
    renderCard({ awards: [award()] });

    expect(screen.queryByTestId('fo-dibbs-actions')).not.toBeInTheDocument();
  });
});

describe('P41 the part/NSN profile gap is a review route, not a weak score', () => {
  test('the gap explains that no comparison happened, not that it failed', () => {
    renderCard({ partProfileGap: 'no_client_parts_recorded' });

    const gap = screen.getByTestId('fo-dibbs-part-gap');
    expect(gap).toHaveTextContent('no part-level match was attempted');
    expect(gap.textContent).not.toMatch(/did not match|no match found|weak/i);
  });

  test('the review control appears only when a handler is supplied', () => {
    renderCard({ partProfileGap: 'no_client_parts_recorded' });
    expect(screen.queryByTestId('fo-dibbs-review-parts')).not.toBeInTheDocument();

    cleanup();

    renderCard({ partProfileGap: 'no_client_parts_recorded', onReviewClientParts: vi.fn() });
    expect(screen.getByTestId('fo-dibbs-review-parts')).toBeInTheDocument();
  });

  test('no gap block renders when the client has recorded parts', () => {
    renderCard({ partProfileGap: null });

    expect(screen.queryByTestId('fo-dibbs-part-gap')).not.toBeInTheDocument();
  });
});

describe('P41 document-type honesty', () => {
  test('a closed item is tagged closed and its pursuit control is disabled', () => {
    renderCard({ facts: rfq({ isOpen: false }), onPursue: vi.fn() });

    expect(screen.getByTestId('fo-dibbs-closed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Quote this item/i })).toBeDisabled();
  });

  test('a null isOpen is rendered as nothing — never as "open"', () => {
    const { container } = renderCard({ facts: rfq({ isOpen: null }) });

    expect(screen.queryByTestId('fo-dibbs-closed')).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\bopen\b/i);
  });

  test('the buyer row exists only for an RFP, which is the only type that carries one', () => {
    renderCard({ facts: rfp() });
    expect(screen.getByTestId('fo-dibbs-buyer')).toHaveTextContent('PZ12');

    // Unmount first: testing-library cleans up between tests, not within one,
    // so without this the RFP's row is still mounted and the absence assertion
    // below would be checking the wrong render.
    cleanup();

    renderCard({ facts: rfq() });
    expect(screen.queryByTestId('fo-dibbs-buyer')).not.toBeInTheDocument();
  });

  test('an RFP with no buyer states the gap rather than omitting the row', () => {
    renderCard({ facts: rfp({ buyerCode: null }) });

    expect(screen.getByTestId('fo-dibbs-buyer')).toHaveTextContent('Not stated by the source');
  });

  test('the action wording differs by document type', () => {
    renderCard({ facts: rfq(), onPursue: vi.fn() });
    expect(screen.getByRole('button', { name: /Quote this item/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Consider a proposal/i })).not.toBeInTheDocument();

    cleanup();

    renderCard({ facts: rfp(), onPursue: vi.fn() });
    expect(screen.getByRole('button', { name: /Consider a proposal/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Quote this item/i })).not.toBeInTheDocument();
  });

  test("the provider's display spelling is preferred, and never parsed", () => {
    renderCard({ facts: rfq({ solicitationFormatted: 'SPE4A6-25-T-1234' }) });

    expect(screen.getByRole('button', { name: /Open bid-board detail/i })).toHaveTextContent('SPE4A6-25-T-1234');
  });
});

describe('P41 formatters', () => {
  test('formatDibbsQuantity is the same rule the card renders', () => {
    expect(formatDibbsQuantity(rfq())).toBe('500 EA');
    expect(formatDibbsQuantity(rfq({ quantity: null }))).toBe('Not stated by the source');
    expect(formatDibbsQuantity(rfq({ quantity: '' }))).toBe('Not stated by the source');
    expect(formatDibbsQuantity(rfq({ unitOfIssue: '' }))).toBe('Not stated by the source');
    expect(formatDibbsQuantity(rfp())).toBe('Not stated on a request for proposal');
  });

  test('formatDibbsPartIdentity states each identifier it has, and says so when it has none', () => {
    expect(formatDibbsPartIdentity(rfq())).toBe('NSN 5340-01-234-5678 · Part MS21042L4');
    expect(formatDibbsPartIdentity(rfq({ partNumber: null }))).toBe('NSN 5340-01-234-5678');
    expect(formatDibbsPartIdentity(rfq({ nsn: null }))).toBe('Part MS21042L4');
    expect(formatDibbsPartIdentity(rfq({ nsn: null, partNumber: null }))).toBe('No NSN or part number stated');
  });
});
