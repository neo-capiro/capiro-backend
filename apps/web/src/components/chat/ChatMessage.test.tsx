import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ChatMessage } from './ChatMessage.js';
import type { GroundingCaveat, MeriCitation, MeriVerification } from './chat-store.js';

const citations: MeriCitation[] = [
  {
    n: 1,
    type: 'bill',
    id: 'hr1',
    title: 'Defense Authorization Act',
    url: null,
    snippet: null,
    tool: 'search_congress_bills',
  },
  {
    n: 2,
    type: 'lda_filing',
    id: 'x',
    title: 'Budget Resolution',
    url: 'https://congress.gov/budget',
    snippet: 'A budget resolution summary.',
    tool: 'search_lda_filings',
  },
];

describe('ChatMessage citations', () => {
  test('renders matched [N] markers as clickable chips and leaves unmatched markers as text', () => {
    render(
      <ChatMessage
        role="assistant"
        content="The Defense Act [1] advanced; see the budget [2]. Unknown [3]."
        citations={citations}
      />,
    );
    expect(screen.getByRole('button', { name: '[1]' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '[2]' })).toBeTruthy();
    // [3] has no matching citation, so it must NOT become a button.
    expect(screen.queryByRole('button', { name: '[3]' })).toBeNull();
  });

  test('clicking a citation chip opens a drawer with the matched source', () => {
    render(<ChatMessage role="assistant" content="See the budget [2]." citations={citations} />);
    // Drawer content is not present until the chip is clicked.
    expect(screen.queryByText('Budget Resolution')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '[2]' }));
    expect(screen.getByText('Budget Resolution')).toBeTruthy();
    expect(screen.getByText('A budget resolution summary.')).toBeTruthy();
    const link = screen.getByRole('link', { name: /Open source/i });
    expect(link.getAttribute('href')).toBe('https://congress.gov/budget');
  });

  test('user messages render as plain text without citation chips', () => {
    render(<ChatMessage role="user" content="What about bill [1]?" citations={citations} />);
    expect(screen.queryByRole('button', { name: '[1]' })).toBeNull();
    expect(screen.getByText('What about bill [1]?')).toBeTruthy();
  });
});

describe('ChatMessage markdown tables (GFM)', () => {
  test('renders a pipe table as a real <table>, not raw pipes', () => {
    const md = ['| Program | FY2027 |', '| --- | ---: |', '| Aircraft | 291.4 |'].join('\n');
    const { container } = render(<ChatMessage role="assistant" content={md} />);
    const table = container.querySelector('table.chat-md-table');
    expect(table).toBeTruthy();
    expect(screen.getByText('Program')).toBeTruthy();
    expect(screen.getByText('Aircraft')).toBeTruthy();
    expect(screen.getByText('291.4')).toBeTruthy();
    // raw markdown pipe row must not survive as literal text
    expect(container.textContent).not.toContain('| Aircraft |');
  });

  test('renders citation chips inside table cells', () => {
    const md = ['| Item | Source |', '| --- | --- |', '| Defense Act | see [1] |'].join('\n');
    render(<ChatMessage role="assistant" content={md} citations={citations} />);
    expect(screen.getByRole('button', { name: '[1]' })).toBeTruthy();
  });

  test('sanitizes injected html in markdown (no script execution)', () => {
    const { container } = render(
      <ChatMessage role="assistant" content={'Hello <script>alert(1)</script> world'} />,
    );
    expect(container.querySelector('script')).toBeNull();
  });
});

const lowConfidenceVerification: MeriVerification = {
  claims: [
    { claim: 'HR1 cleared committee', supported: true, sourceIds: [1] },
    { claim: 'HR1 will pass the floor next week', supported: false, sourceIds: [] },
    { claim: 'The sponsor is retiring', supported: false, sourceIds: [] },
  ],
  totalCount: 3,
  unsupportedCount: 2,
  unsupportedRatio: 2 / 3,
  lowConfidence: true,
};

describe('ChatMessage grounding caveat (chat enforce-gate)', () => {
  const caveat: GroundingCaveat = {
    topSeverity: 'high',
    findings: [
      {
        check: 'D7',
        severity: 'high',
        detail: 'Code 0219AD0500 is a procurement line item, not a PE.',
      },
    ],
  };

  test('renders a visible caveat banner with the humanized finding for an assistant reply', () => {
    render(
      <ChatMessage
        role="assistant"
        content="The C-sUAS program (PE 0219AD0500)…"
        groundingCaveat={caveat}
      />,
    );
    expect(screen.getByText(/Meri flagged a possible grounding issue/i)).toBeTruthy();
    expect(screen.getByText(/procurement line labeled a program element/i)).toBeTruthy();
  });

  test('does not render for a user message or when there are no findings', () => {
    const { rerender, container } = render(
      <ChatMessage role="user" content="hi" groundingCaveat={caveat} />,
    );
    expect(screen.queryByText(/Meri flagged/i)).toBeNull();
    rerender(
      <ChatMessage
        role="assistant"
        content="ok"
        groundingCaveat={{ topSeverity: null, findings: [] }}
      />,
    );
    expect(container.querySelector('.chat-msg-grounding-caveat')).toBeNull();
  });
});

describe('ChatMessage verification gate', () => {
  test('shows a low-confidence banner and lists the unsupported claims', () => {
    render(
      <ChatMessage
        role="assistant"
        content="Here is the briefing."
        verification={lowConfidenceVerification}
      />,
    );
    expect(screen.getByText(/Low confidence/i)).toBeTruthy();
    expect(screen.getByText('HR1 will pass the floor next week')).toBeTruthy();
    expect(screen.getByText('The sponsor is retiring')).toBeTruthy();
    // supported claims are not listed as flagged
    expect(screen.queryByText('HR1 cleared committee')).toBeNull();
  });

  test('shows a grounded confirmation when all claims are supported', () => {
    const allSupported: MeriVerification = {
      claims: [{ claim: 'x', supported: true, sourceIds: [1] }],
      totalCount: 1,
      unsupportedCount: 0,
      unsupportedRatio: 0,
      lowConfidence: false,
    };
    render(<ChatMessage role="assistant" content="ok" verification={allSupported} />);
    expect(screen.getByText(/checked against sources/i)).toBeTruthy();
    expect(screen.queryByText(/Low confidence/i)).toBeNull();
  });

  test('renders nothing extra when there is no verification', () => {
    render(<ChatMessage role="assistant" content="plain answer" />);
    expect(screen.queryByText(/Low confidence/i)).toBeNull();
    expect(screen.queryByText(/checked against sources/i)).toBeNull();
  });
});

describe('ChatMessage copy action (P2-11)', () => {
  test('copies the message text to the clipboard on assistant messages', () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ChatMessage role="assistant" content="Copy me please" />);
    fireEvent.click(screen.getByRole('button', { name: /copy message/i }));
    expect(writeText).toHaveBeenCalledWith('Copy me please');
  });

  test('no copy button on user messages', () => {
    render(<ChatMessage role="user" content="hi there" />);
    expect(screen.queryByRole('button', { name: /copy message/i })).toBeNull();
  });
});
