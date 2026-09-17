import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FundingOpportunityV2Detail } from './FundingOpportunityV2Detail.js';
import { FundingOpportunityV2QuickPanel } from './FundingOpportunityV2QuickPanel.js';
import {
  buildFundingOpportunityV2DetailModel,
  getFundingOpportunityDeadlinePresentation,
  getFundingOpportunityV2StatusTags,
  normalizeFundingOpportunityV2Detail,
  type FundingOpportunityV2DetailInput,
} from './funding-opportunities-v2-detail-types.js';

function input(
  overrides: Partial<FundingOpportunityV2DetailInput> = {},
): FundingOpportunityV2DetailInput {
  return {
    source: 'sam_gov',
    sourceRecordId: 'notice-1',
    title: 'Autonomous systems sustainment',
    agency: 'Department of the Army',
    sourceUrl: 'https://sam.gov/opp/notice-1',
    type: 'solicitation',
    lifecycle: 'active',
    summary: 'Sustainment and integration work.',
    postedDate: '2026-08-01',
    deadline: '2026-10-01',
    closeOrArchiveDate: '2026-10-01',
    sourceUpdatedAt: '2026-08-12T10:00:00.000Z',
    ingestedAt: '2026-08-12T10:10:00.000Z',
    isPursuable: true,
    eligibility: { state: 'eligible', reason: 'Open competition.' },
    matchedSignals: [{ signal: 'naicsExact', strength: 'strong', weight: 30, matchedOn: '541715' }],
    relevanceScore: 84,
    mode: 'matched',
    clientId: 'client-1',
    naicsCodes: ['541715'],
    pscCodes: ['AD21'],
    setAside: null,
    applicantTypes: [],
    geography: ['Warren, MI'],
    value: { label: 'Estimated value', value: '$48M', sourceBacked: true },
    scope: ['Integrate vehicle kits.', 'Provide sustainment support.'],
    responsePath: {
      label: 'SAM.gov response',
      value: 'Submit through the authoritative notice.',
      detail: 'Submit through the authoritative notice.',
    },
    provenance: [{ label: 'Search source', value: 'SAM.gov' }],
    similar: [],
    ...overrides,
  };
}

describe('Funding Opportunities v2 detail view model', () => {
  test('keeps exact section order and omits empty conditional sections', () => {
    const model = buildFundingOpportunityV2DetailModel(
      input({
        eligibility: null,
        geography: [],
        value: null,
        scope: [],
        classification: [],
        evaluation: null,
        responsePath: null,
        documents: [],
        activity: [],
        changeNotes: [],
      }),
    );
    expect(model.sections.map((section) => section.title)).toEqual([
      'Summary and purpose',
      'Important dates',
      'Classification codes',
      'Client match explanation',
      'Source record and change notes',
    ]);
  });
  test('does not create date or economics sections when no source facts exist', () => {
    const model = buildFundingOpportunityV2DetailModel(
      input({
        deadline: null,
        closeOrArchiveDate: null,
        postedDate: null,
        sourceUpdatedAt: null,
        value: null,
        naicsCodes: [],
        pscCodes: [],
      }),
    );
    expect(model.sections.map((section) => section.id)).not.toContain('dates');
    expect(model.sections.map((section) => section.id)).not.toContain('economics');
  });
  test('suppresses matching explanations in all mode while preserving real actions', () => {
    const model = buildFundingOpportunityV2DetailModel(
      input({ mode: 'all', clientId: 'client-1' }),
    );
    expect(model.match).toBeNull();
    expect(model.sections.some((section) => section.title === 'Client match explanation')).toBe(
      false,
    );
    expect(model.actions.canSave).toBe(true);
    expect(model.actions.canPursue).toBe(true);
  });
  test('makes forecasts, closed, and ineligible records explicitly non-pursuable', () => {
    expect(
      buildFundingOpportunityV2DetailModel(input({ lifecycle: 'forecast', isPursuable: false }))
        .actions.pursueNote,
    ).toContain('forecast');
    expect(
      buildFundingOpportunityV2DetailModel(input({ lifecycle: 'closed', isPursuable: false }))
        .actions.pursueNote,
    ).toContain('closed');
    expect(
      buildFundingOpportunityV2DetailModel(
        input({
          eligibility: { state: 'ineligible', reason: 'Not eligible.' },
          isPursuable: false,
        }),
      ).actions.pursueNote,
    ).toContain('eligible');
  });
  test('retains weak-signal qualification in client explanation', () => {
    const model = buildFundingOpportunityV2DetailModel(
      input({
        matchedSignals: [
          { signal: 'genericTopical', strength: 'weak', weight: 1, matchedOn: 'autonomy' },
        ],
      }),
    );
    expect(model.sections.find((section) => section.id === 'match')?.footnote).toContain(
      'Weak generic signals',
    );
  });
  test('renders source-backed scope and response evidence with review state', () => {
    const model = buildFundingOpportunityV2DetailModel(
      input({
        scope: [],
        scopeContent: [
          {
            label: 'submission',
            kind: 'submission',
            statement: 'Submit the technical volume.',
            sourceExcerpt: 'Submit the technical volume.',
            sourceDocument: 'solicitation.pdf',
            sourcePage: 4,
            reviewStatus: 'pending',
            supersededAt: null,
          },
        ],
        responsePath: {
          label: 'SAM.gov solicitation',
          value: 'Review the authoritative solicitation record for response instructions.',
          detail: 'source_page',
        },
        responseInstructions: ['Submit the technical volume.'],
        responseInstructionDetails: [
          {
            label: 'submission',
            kind: 'submission',
            statement: 'Submit the technical volume.',
            sourceExcerpt: 'Submit the technical volume.',
            sourceDocument: 'solicitation.pdf',
            sourcePage: 4,
            reviewStatus: 'pending',
            supersededAt: null,
          },
        ],
      }),
    );
    expect(model.sections.map((section) => section.id)).toContain('scope');
    expect(model.sections.map((section) => section.id)).toContain('response');
    expect(model.sections.find((section) => section.id === 'scope')?.bullets?.[0]).toMatchObject({
      text: 'Submit the technical volume.',
      badge: 'Pending review',
    });
  });
});

describe('detail provenance and semantic presentation', () => {
  test('does not expose an internal record id as a public source id', () => {
    const model = buildFundingOpportunityV2DetailModel(input({ sourceReference: null }));
    expect(model.provenance.find((fact) => fact.label === 'Source ID')?.value).toBe(
      'Not provided by source',
    );
    expect(model.provenance.find((fact) => fact.label === 'Source ID')?.value).not.toBe('notice-1');
  });
  test('keeps client eligibility context separate from relevance caveat', () => {
    const model = buildFundingOpportunityV2DetailModel(
      input({ eligibilityClientReason: 'Client capability needs review.' }),
    );
    expect(model.sections.find((section) => section.id === 'eligibility')?.footnote).toContain(
      'Client eligibility context',
    );
    expect(model.sections.find((section) => section.id === 'eligibility')?.footnote).toContain(
      'Eligibility and relevance answer different questions',
    );
    expect(model.sections.find((section) => section.id === 'eligibility')?.footnote).not.toContain(
      'Client relevance is assessed',
    );
  });
  test('does not infer freshness from source update time and handles post-award state', () => {
    const model = buildFundingOpportunityV2DetailModel(
      input({ lifecycle: 'post_award', sourceFreshnessState: null }),
    );
    expect(model.provenance.find((fact) => fact.label === 'Freshness')?.value).toContain(
      'Unavailable',
    );
    expect(model.provenance.find((fact) => fact.label === 'Catalog state')?.value).toContain(
      'Post-award',
    );
    expect(model.tags.some((tag) => tag.label === 'Post-award')).toBe(true);
    expect(model.tags.some((tag) => tag.label === 'Open')).toBe(false);
  });
  test('normalizer accepts canonical source health separately from source facts', () => {
    const normalized = normalizeFundingOpportunityV2Detail(input() as never, {
      sourceFreshnessState: 'stale',
    });
    expect(normalized.sourceFreshnessState).toBe('stale');
  });
});

describe('detail status tags', () => {
  test('maps canonical match and workflow state without inventing recommendation facts', () => {
    expect(
      getFundingOpportunityV2StatusTags({
        mode: 'matched',
        lifecycle: 'active',
        matchBand: 'strong',
        eligibilityState: 'eligible',
      }),
    ).toContainEqual({ label: 'Recommended', tone: 'brand' });
    expect(
      getFundingOpportunityV2StatusTags({
        mode: 'all',
        lifecycle: 'active',
        matchBand: 'strong',
        eligibilityState: 'eligible',
      }),
    ).toEqual([]);
    expect(
      getFundingOpportunityV2StatusTags({
        mode: 'matched',
        lifecycle: 'post_award',
        matchBand: 'strong',
        eligibilityState: 'eligible',
      }),
    ).toEqual([]);
    expect(
      getFundingOpportunityV2StatusTags({
        mode: 'matched',
        lifecycle: 'active',
        matchBand: 'strong',
        eligibilityState: 'eligible',
        workflowStatus: 'pursuing',
      }),
    ).toContainEqual({ label: 'Pursued', tone: 'brand' });
  });
});

describe('rendered deadline presentation', () => {
  test('renders source-calendar date and cutoff metadata in the actual detail rail', () => {
    const model = buildFundingOpportunityV2DetailModel(
      input({
        deadline: '2026-09-25T01:00:00.000Z',
        dateFacts: {
          posted: {
            value: '2026-07-22',
            precision: 'date',
            timezone: 'EDT',
            sourceRaw: 'Jul 22, 2026',
            unavailableReason: null,
          },
          responseDeadline: {
            value: '2026-09-25T01:00:00.000Z',
            precision: 'timestamp',
            timezone: 'EDT',
            sourceRaw: 'Sep 24, 2026 21:00 EDT',
            unavailableReason: null,
          },
          closeOrArchive: {
            value: null,
            precision: null,
            timezone: null,
            sourceRaw: null,
            unavailableReason: null,
          },
          forecast: {
            anticipatedAwardDate: {
              value: null,
              precision: null,
              timezone: null,
              sourceRaw: null,
              unavailableReason: null,
            },
            estimatedPeriod: null,
            unavailableReason: null,
          },
        },
      }),
    );
    render(<FundingOpportunityV2Detail model={model} {...detailCallbacks()} />);
    const rail = document.querySelector('.fo-v2-detail-deadline');
    expect(rail).toHaveTextContent('Sep 24');
    expect(rail).toHaveTextContent('21:00 EDT');
    expect(rail).not.toHaveTextContent('Sep 25');
  });

  test('renders a source date-only cutoff with its calendar year once and no fabricated time', () => {
    const model = buildFundingOpportunityV2DetailModel(
      input({
        deadline: '2026-09-24',
        dateFacts: {
          posted: {
            value: null,
            precision: null,
            timezone: null,
            sourceRaw: null,
            unavailableReason: null,
          },
          responseDeadline: {
            value: '2026-09-24',
            precision: 'date',
            timezone: null,
            sourceRaw: '2026-09-24',
            unavailableReason: null,
          },
          closeOrArchive: {
            value: null,
            precision: null,
            timezone: null,
            sourceRaw: null,
            unavailableReason: null,
          },
          forecast: {
            anticipatedAwardDate: {
              value: null,
              precision: null,
              timezone: null,
              sourceRaw: null,
              unavailableReason: null,
            },
            estimatedPeriod: null,
            unavailableReason: null,
          },
        },
      }),
    );
    render(<FundingOpportunityV2Detail model={model} {...detailCallbacks()} />);
    const rail = document.querySelector('.fo-v2-detail-deadline');
    expect(rail).toHaveTextContent('Sep 24');
    expect(rail).toHaveTextContent('2026');
    expect(rail).not.toHaveTextContent('2026-09-24');
    expect(rail).not.toHaveTextContent('00:00');
  });

  test('renders numeric source offsets without dropping the cutoff', () => {
    const model = buildFundingOpportunityV2DetailModel(
      input({
        deadline: '2026-09-24T21:00:00.000Z',
        dateFacts: {
          posted: {
            value: null,
            precision: null,
            timezone: null,
            sourceRaw: null,
            unavailableReason: null,
          },
          responseDeadline: {
            value: '2026-09-24T21:00:00.000Z',
            precision: 'timestamp',
            timezone: '-04:00',
            sourceRaw: '2026-09-24T17:00:00-04:00',
            unavailableReason: null,
          },
          closeOrArchive: {
            value: null,
            precision: null,
            timezone: null,
            sourceRaw: null,
            unavailableReason: null,
          },
          forecast: {
            anticipatedAwardDate: {
              value: null,
              precision: null,
              timezone: null,
              sourceRaw: null,
              unavailableReason: null,
            },
            estimatedPeriod: null,
            unavailableReason: null,
          },
        },
      }),
    );
    render(<FundingOpportunityV2Detail model={model} {...detailCallbacks()} />);
    expect(document.querySelector('.fo-v2-detail-deadline')).toHaveTextContent('17:00:00');
    expect(document.querySelector('.fo-v2-detail-deadline')).toHaveTextContent('-04:00');
  });
});

describe('source presentation and forecast date semantics', () => {
  test('uses the canonical source presentation identities and palette tones', () => {
    expect(
      buildFundingOpportunityV2DetailModel(input({ source: 'grants_gov' })).tags[0],
    ).toMatchObject({
      label: 'Grants.gov',
      tone: 'plain',
    });
    expect(buildFundingOpportunityV2DetailModel(input({ source: 'dibbs' })).tags[0]).toMatchObject({
      label: 'DLA bid board',
      tone: 'plain',
    });
  });

  test('renders forecast timing as anticipated award without a response countdown', () => {
    const model = buildFundingOpportunityV2DetailModel(
      input({
        source: 'agency_forecast',
        lifecycle: 'forecast',
        deadline: null,
        forecastDate: 'Q2 FY27',
        dateFacts: null,
      }),
    );
    expect(model.deadline).toMatchObject({
      label: 'AWARD EXPECTED',
      value: 'Q2 FY27',
      daysRemaining: null,
    });
    expect(model.deadline?.note).toContain('no response deadline exists');
    expect(model.tags.filter((tag) => tag.label === 'Forecast · early signal')).toHaveLength(1);
  });

  test('does not describe a known forecast date as absent', () => {
    const model = buildFundingOpportunityV2DetailModel(
      input({
        source: 'agency_forecast',
        lifecycle: 'forecast',
        deadline: null,
        forecastDate: '2027-04-01',
        dateFacts: null,
      }),
    );
    expect(model.deadline?.note).toContain('anticipated award estimate');
    expect(model.deadline?.note).not.toContain('did not state');
    expect(model.tags.filter((tag) => tag.label === 'Forecast · early signal')).toHaveLength(1);
  });
});

describe('shared deadline presentation', () => {
  test('uses warning within thirty days, error for closed or lost, success for won, and plain otherwise', () => {
    const now = new Date('2026-09-01T12:00:00.000Z');
    expect(
      getFundingOpportunityDeadlinePresentation({
        deadline: '2026-09-20',
        lifecycle: 'active',
        now,
      }).tone,
    ).toBe('warning');
    expect(
      getFundingOpportunityDeadlinePresentation({
        deadline: '2026-09-20',
        lifecycle: 'closed',
        now,
      }).tone,
    ).toBe('error');
    expect(
      getFundingOpportunityDeadlinePresentation({
        deadline: '2026-09-20',
        lifecycle: 'active',
        workflowStatus: 'lost',
        now,
      }).tone,
    ).toBe('error');
    expect(
      getFundingOpportunityDeadlinePresentation({
        deadline: '2026-09-20',
        lifecycle: 'active',
        workflowStatus: 'won',
        now,
      }).tone,
    ).toBe('success');
    expect(
      getFundingOpportunityDeadlinePresentation({
        deadline: '2027-02-20',
        lifecycle: 'active',
        now,
      }).tone,
    ).toBe('plain');
  });
});

afterEach(cleanup);

function detailCallbacks() {
  return {
    onBack: vi.fn(),
    onAction: vi.fn(),
    onExternalAudit: vi.fn(),
    onOpenSimilar: vi.fn(),
    onOpenQuick: vi.fn(),
  };
}
function quickCallbacks() {
  return { ...detailCallbacks(), onClose: vi.fn(), onOpenFullDetail: vi.fn() };
}

describe('Funding Opportunities v2 detail interactions', () => {
  test('source audit reserves one isolated popup, blocks Escape while pending, and navigates only to the audited URL', async () => {
    const callbacks = detailCallbacks();
    let resolveAudit!: (value: { authoritativeUrl: string }) => void;
    callbacks.onExternalAudit.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAudit = resolve;
        }),
    );
    const popupDocument = document.implementation.createHTMLDocument('Reserved source');
    const popup = { opener: window, closed: false, document: popupDocument, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const navigation = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      render(<FundingOpportunityV2Detail input={input()} {...callbacks} />);
      const trigger = screen.getByRole('button', { name: 'View solicitation on SAM.gov' });
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      const dialog = screen.getByRole('dialog', { name: 'You are leaving Capiro' });
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(dialog).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Recording…' })).toBeDisabled();
      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith('', '_blank');
      expect(popup.opener).toBeNull();
      expect(callbacks.onExternalAudit).toHaveBeenCalledTimes(1);
      expect(callbacks.onExternalAudit).toHaveBeenCalledWith({
        source: 'sam_gov',
        sourceRecordId: 'notice-1',
        clientId: 'client-1',
        destinationKind: 'source_page',
      });
      await act(async () =>
        resolveAudit({ authoritativeUrl: 'https://sam.gov/opp/authoritative-new-url' }),
      );
      await waitFor(() => expect(dialog).not.toBeInTheDocument());
      const link = popupDocument.querySelector('a')!;
      expect(link.href).toBe('https://sam.gov/opp/authoritative-new-url');
      expect(link.rel).toBe('noreferrer');
      expect(link.target).toBe('_self');
      expect(navigation).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(trigger);
    } finally {
      open.mockRestore();
      navigation.mockRestore();
    }
  });

  test('failed source audit closes its reserved window and keeps the confirmation available for retry', async () => {
    const callbacks = detailCallbacks();
    callbacks.onExternalAudit.mockRejectedValue(new Error('Audit unavailable'));
    const popup = { opener: window, closed: false, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    try {
      render(<FundingOpportunityV2Detail input={input()} {...callbacks} />);
      fireEvent.click(screen.getByRole('button', { name: 'View solicitation on SAM.gov' }));
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The source click could not be recorded.',
      );
      expect(popup.close).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('dialog', { name: 'You are leaving Capiro' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    } finally {
      open.mockRestore();
    }
  });

  test('dispatches Not a fit with the clicked source record and client', () => {
    const callbacks = detailCallbacks();
    render(<FundingOpportunityV2Detail input={input()} {...callbacks} />);
    fireEvent.click(screen.getByRole('button', { name: 'Not a fit' }));
    expect(callbacks.onAction).toHaveBeenCalledWith({
      action: 'not_fit',
      source: 'sam_gov',
      sourceRecordId: 'notice-1',
      clientId: 'client-1',
    });
  });
  test('focuses the external dialog and restores the source trigger on Escape', () => {
    const callbacks = detailCallbacks();
    render(<FundingOpportunityV2Detail input={input()} {...callbacks} />);
    const sourceButton = screen.getByRole('button', { name: 'View solicitation on SAM.gov' });
    fireEvent.click(sourceButton);
    const dialog = screen.getByRole('dialog', { name: 'You are leaving Capiro' });
    expect(dialog).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(
      screen.queryByRole('dialog', { name: 'You are leaving Capiro' }),
    ).not.toBeInTheDocument();
    expect(document.activeElement).toBe(sourceButton);
  });
  test('Quick keeps the backdrop dismissal surface and omits the Full-only Not a fit action', () => {
    const callbacks = quickCallbacks();
    render(
      <FundingOpportunityV2QuickPanel
        model={buildFundingOpportunityV2DetailModel(input())}
        {...callbacks}
      />,
    );
    expect(screen.getAllByRole('button', { name: 'Close quick details' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Not a fit' })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close quick details' })[0]!);
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
  });
  test('Escape closes nested source confirmation without closing the quick panel', () => {
    const callbacks = quickCallbacks();
    render(
      <FundingOpportunityV2QuickPanel
        model={buildFundingOpportunityV2DetailModel(input())}
        {...callbacks}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open source' }));
    const modal = screen.getByRole('dialog', { name: 'You are leaving Capiro' });
    fireEvent.keyDown(modal, { key: 'Escape' });
    expect(
      screen.queryByRole('dialog', { name: 'You are leaving Capiro' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('dialog', { name: 'Autonomous systems sustainment' }),
    ).toBeInTheDocument();
    expect(callbacks.onClose).not.toHaveBeenCalled();
  });
});
