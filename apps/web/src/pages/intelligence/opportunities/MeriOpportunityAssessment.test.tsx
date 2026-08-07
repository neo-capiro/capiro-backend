import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MeriOpportunityAssessment } from './MeriOpportunityAssessment.js';
import {
  ASSESSMENT_SECTIONS,
  type AssessmentResultView,
  type MeriAssessmentView,
} from './funding-opportunities-api.js';

/**
 * The Meri assessment panel (P38).
 *
 * Five rules carry it:
 *   1. Generating costs a model call, so it happens on a click — never on mount.
 *   2. The recommendation is Capiro's, and a model disagreement renders as
 *      analysis with no control that could apply it.
 *   3. A held statement is visible, with its reason.
 *   4. Incomplete is the headline, not a footnote.
 *   5. A proposed draft has no button. Nothing here writes.
 */

const { apiGetMock, apiPostMock, flags } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  flags: { funding_opportunities_meri_v2: true } as Record<string, boolean>,
}));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: apiPostMock, patch: vi.fn() }),
}));
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: (feature: string) => ({ enabled: flags[feature] === true, ready: true }),
  useIntelFeatureEnabled: (feature: string) => flags[feature] === true,
}));

const SAM_ID = '11111111-1111-1111-1111-111111111111';
const CLIENT = '22222222-2222-2222-2222-222222222222';
const CONVERSATION = '33333333-3333-3333-3333-333333333333';

function assessment(over: Partial<MeriAssessmentView> = {}): MeriAssessmentView {
  return {
    clientId: CLIENT,
    source: 'sam_gov',
    sourceRecordId: SAM_ID,
    recommendation: 'needs_review',
    modelState: 'applied',
    modelStateExplanation: 'Narrative sections are model analysis over the packet below.',
    sections: {
      recommendationRestatement: ['Capiro’s deterministic recommendation is needs_review.'],
      fit: ['Strong capability overlap.'],
      eligibility: ['Certifications are not recorded.'],
      acquisitionPosition: [],
      governmentContext: [],
      risksAndUnknowns: [],
      nextThreeActions: [],
      evidenceMap: [],
    },
    claims: [
      {
        section: 'fit',
        text: 'The client has a reviewed Program Element link.',
        verdict: 'supported',
        refs: ['sam_opportunity_match:m1'],
        unresolvedRefs: [],
        holdReason: null,
      },
    ],
    nextThreeActions: ['Confirm certifications.'],
    disagreement: null,
    proposedDrafts: [],
    incomplete: false,
    incompleteReasons: [],
    fingerprint: 'abcdef0123456789',
    ...over,
  };
}

function payload(over: Partial<MeriAssessmentView> = {}): AssessmentResultView {
  return {
    state: 'available',
    assessment: assessment(over),
    provenance: {
      promptVersion: 'fo-assessment-2026-09-01',
      policyVersion: 'fo-assessment-policy-1',
      compilerVersion: 'v2',
      contextPacketId: 'packet-1',
      model: 'claude-test',
      artifactVersion: 2,
      assessedAt: '2026-09-01T12:00:00.000Z',
    },
  };
}

function setupBrowserMocks() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(window, 'getComputedStyle', {
    writable: true,
    value: () => ({ getPropertyValue: () => '' }),
  });
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AntApp>{node}</AntApp>
    </QueryClientProvider>,
  );
}

function panel(over: Record<string, unknown> = {}) {
  return (
    <MeriOpportunityAssessment
      clientId={CLIENT}
      conversationId={CONVERSATION}
      source="sam_gov"
      sourceRecordId={SAM_ID}
      {...over}
    />
  );
}

async function generate() {
  fireEvent.click(screen.getByTestId('assessment-run'));
  await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
}

beforeEach(() => {
  setupBrowserMocks();
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  flags.funding_opportunities_meri_v2 = true;
});

describe('THE RULE: generating costs a model call, so nothing runs on mount', () => {
  test('mounting issues no request at all', () => {
    wrap(panel());
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(apiGetMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('assessment-run')).toBeTruthy();
  });

  test('the flag off renders nothing — not an empty card', () => {
    flags.funding_opportunities_meri_v2 = false;
    const { container } = wrap(panel());
    expect(container.querySelector('[data-testid="fo-detail-meri-assessment"]')).toBeNull();
  });

  test('no client means no assessment, and the copy says why', () => {
    wrap(panel({ clientId: null }));
    expect(screen.queryByTestId('assessment-run')).toBeNull();
    expect(screen.getByText(/client-opportunity\s+pair/)).toBeTruthy();
  });

  test('no conversation means no assessment, and the copy says where version history lives', () => {
    wrap(panel({ conversationId: null }));
    expect(screen.queryByTestId('assessment-run')).toBeNull();
    expect(screen.getByText(/version history are kept with that conversation/)).toBeTruthy();
  });

  test('the POST carries the client and conversation the panel was given', async () => {
    apiPostMock.mockResolvedValue({ data: payload() });
    wrap(panel());
    await generate();
    expect(apiPostMock).toHaveBeenCalledWith(
      `/api/intelligence/opportunities/sam_gov/${SAM_ID}/assessment`,
      { clientId: CLIENT, conversationId: CONVERSATION },
    );
  });
});

describe('THE RULE: the recommendation is Capiro’s', () => {
  test('the restatement section renders the deterministic decision', async () => {
    apiPostMock.mockResolvedValue({ data: payload() });
    wrap(panel());
    await generate();
    const section = await screen.findByTestId('assessment-section-recommendationRestatement');
    expect(section.textContent).toContain('needs_review');
  });

  test('a disagreement renders as ANALYSIS, states the recommendation is unchanged, and offers no control', async () => {
    apiPostMock.mockResolvedValue({
      data: payload({
        disagreement: { proposed: 'pursue', rationale: 'The fit looks strong to me.' },
      }),
    });
    wrap(panel());
    await generate();

    const block = await screen.findByTestId('assessment-disagreement');
    expect(block.textContent).toContain('held for review');
    expect(block.textContent).toContain('unchanged');
    expect(block.textContent).toContain('needs_review');
    // No control anywhere in the block that could apply the model's view.
    expect(block.querySelectorAll('button')).toHaveLength(0);
    expect(block.querySelectorAll('input')).toHaveLength(0);
  });

  test('no disagreement renders no disagreement block', async () => {
    apiPostMock.mockResolvedValue({ data: payload() });
    wrap(panel());
    await generate();
    await screen.findByTestId('assessment-section-fit');
    expect(screen.queryByTestId('assessment-disagreement')).toBeNull();
  });
});

describe('THE RULE: a held statement is visible, with its reason', () => {
  test('held and supported claims are visually distinct and both render', async () => {
    apiPostMock.mockResolvedValue({
      data: payload({
        claims: [
          {
            section: 'fit',
            text: 'Supported by the PE link.',
            verdict: 'supported',
            refs: ['sam_opportunity_match:m1'],
            unresolvedRefs: [],
            holdReason: null,
          },
          {
            section: 'fit',
            text: 'They will probably win this.',
            verdict: 'held',
            refs: [],
            unresolvedRefs: [],
            holdReason: 'The assessment stated this without citing any evidence in the packet.',
          },
        ],
      }),
    });
    wrap(panel());
    await generate();

    expect(await screen.findByText('Supported by the PE link.')).toBeTruthy();
    expect(screen.getByText('They will probably win this.')).toBeTruthy();
    expect(screen.getByText(/without citing any evidence/)).toBeTruthy();
    expect(screen.getAllByTestId('assessment-claim-supported')).toHaveLength(1);
    expect(screen.getAllByTestId('assessment-claim-held')).toHaveLength(1);
  });

  test('a cited-but-unresolvable ref is shown rather than swallowed', async () => {
    apiPostMock.mockResolvedValue({
      data: payload({
        claims: [
          {
            section: 'fit',
            text: 'Partly grounded.',
            verdict: 'supported',
            refs: ['sam_opportunity_match:m1'],
            unresolvedRefs: ['federal_award:invented'],
            holdReason: null,
          },
        ],
      }),
    });
    wrap(panel());
    await generate();
    const note = await screen.findByTestId('assessment-unresolved-refs');
    expect(note.textContent).toContain('federal_award:invented');
  });
});

describe('THE RULE: incomplete is the headline', () => {
  test('an incomplete assessment leads with the reasons', async () => {
    apiPostMock.mockResolvedValue({
      data: payload({
        incomplete: true,
        incompleteReasons: [
          'The packet carries no citable evidence.',
          'Client profile gaps limit what can be assessed: Certifications.',
        ],
      }),
    });
    wrap(panel());
    await generate();
    const alert = await screen.findByTestId('assessment-incomplete');
    expect(alert.textContent).toContain('no citable evidence');
    expect(alert.textContent).toContain('Certifications');
  });

  test('a model that did not contribute is stated, and the deterministic half still renders', async () => {
    apiPostMock.mockResolvedValue({
      data: payload({
        modelState: 'unavailable',
        modelStateExplanation: 'The model was unreachable, so only the deterministic assessment is shown.',
        claims: [],
        incomplete: true,
        incompleteReasons: ['Only the deterministic assessment is present.'],
      }),
    });
    wrap(panel());
    await generate();
    expect((await screen.findByTestId('assessment-model-state')).textContent).toContain(
      'unreachable',
    );
    // The recommendation survives a model failure — the phase's own acceptance line.
    expect(
      screen.getByTestId('assessment-section-recommendationRestatement').textContent,
    ).toContain('needs_review');
  });

  test('a server refusal renders the server’s own sentence, not a reworded one', async () => {
    apiPostMock.mockResolvedValue({
      data: { state: 'denied', explanation: 'Not available for this client.' },
    });
    wrap(panel());
    await generate();
    expect((await screen.findByTestId('assessment-refused')).textContent).toContain(
      'Not available for this client.',
    );
  });

  test('a transport failure is an error state, never an empty assessment', async () => {
    apiPostMock.mockRejectedValue({ response: { data: { message: 'Upstream timed out' } } });
    wrap(panel());
    await generate();
    expect((await screen.findByTestId('assessment-error')).textContent).toContain(
      'Upstream timed out',
    );
    expect(screen.queryByTestId('assessment-section-fit')).toBeNull();
  });
});

describe('THE RULE: nothing here writes', () => {
  test('a proposed draft is listed with no button to produce it', async () => {
    apiPostMock.mockResolvedValue({
      data: payload({
        proposedDrafts: [
          { kind: 'briefing', title: 'Capture briefing', rationale: 'For the client call.' },
        ],
      }),
    });
    wrap(panel());
    await generate();

    const drafts = await screen.findByTestId('assessment-drafts');
    expect(drafts.textContent).toContain('Capture briefing');
    expect(drafts.textContent).toContain('Nothing has been drafted, sent, or saved.');
    expect(drafts.querySelectorAll('button')).toHaveLength(0);
  });

  test('the only POST the panel can make is the assessment itself', async () => {
    apiPostMock.mockResolvedValue({
      data: payload({
        proposedDrafts: [{ kind: 'outreach', title: 'Intro email', rationale: 'Reach out.' }],
      }),
    });
    wrap(panel());
    await generate();
    await screen.findByTestId('assessment-drafts');
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock.mock.calls[0]?.[0]).toContain('/assessment');
  });
});

describe('Provenance and section rendering', () => {
  test('provenance names the version, the prompt and the fingerprint', async () => {
    apiPostMock.mockResolvedValue({ data: payload() });
    wrap(panel());
    await generate();
    const line = await screen.findByTestId('assessment-provenance');
    expect(line.textContent).toContain('Version 2');
    expect(line.textContent).toContain('fo-assessment-2026-09-01');
    expect(line.textContent).toContain('abcdef012345');
  });

  test('an empty section renders nothing rather than an empty heading', async () => {
    apiPostMock.mockResolvedValue({ data: payload() });
    wrap(panel());
    await generate();
    await screen.findByTestId('assessment-section-fit');
    // Five of the eight sections are empty in the fixture, and none of them
    // renders a bare heading — an empty "Risks and unknowns" reads as "there
    // are none", which is a claim.
    for (const key of ['acquisitionPosition', 'governmentContext', 'risksAndUnknowns', 'evidenceMap']) {
      expect(screen.queryByTestId(`assessment-section-${key}`)).toBeNull();
    }
  });

  test('the section vocabulary matches the API’s, in order', () => {
    expect([...ASSESSMENT_SECTIONS]).toEqual([
      'recommendationRestatement',
      'fit',
      'eligibility',
      'acquisitionPosition',
      'governmentContext',
      'risksAndUnknowns',
      'nextThreeActions',
      'evidenceMap',
    ]);
  });
});
