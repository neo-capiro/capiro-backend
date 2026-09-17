import {
  AMENDMENT_REPORT_CONVENTIONS,
  composeReportNarrativePrompt,
  isAmendmentStrategyType,
  PROPOSE_REPORT_NARRATIVE_TOOL,
  REPORT_NARRATIVE_SYSTEM_BASE,
  type ReportNarrativeInput,
} from './strategy-report-narrative.prompt.js';

/*
 * Amendment-type strategies get a "# Amendment strategy conventions" block in
 * the user message (exhibit citation, vendor-neutral ask, five-stage status
 * ladder, unscheduled floor windows, backstop). Every other type's prompt is
 * byte-identical to the pre-amendment composition, locked below by building
 * the expected string by hand.
 */

function input(type: string, overrides: Partial<ReportNarrativeInput> = {}): ReportNarrativeInput {
  return {
    audience: 'client',
    strategy: {
      title: 'Program Acceleration Ask',
      type,
      clientName: 'Northstar Systems',
      asOf: 'Aug 30, 2026',
    },
    sections: ['executive_summary', 'objectives_and_ask'],
    maxParagraphsPerSection: 3,
    evidence: [
      { id: 'plan:strategy', text: 'Strategy title: Program Acceleration Ask.' },
      { id: 'ctx:target:1', text: 'FY2027 request for the line is $184.2M (Exhibit P-1).' },
    ],
    ...overrides,
  };
}

describe('composeReportNarrativePrompt — amendment conventions', () => {
  it('appends the conventions block after the audience note for type=amendment', () => {
    const { system, user } = composeReportNarrativePrompt(input('amendment'));
    expect(system).toBe(REPORT_NARRATIVE_SYSTEM_BASE);
    expect(user).toContain('# Amendment strategy conventions');
    expect(user).toContain('filed, made in order, adopted, conferenced, enacted');
    expect(user).toContain('never advance a stage the evidence does not show');
    expect(user).toContain('not yet scheduled');
    expect(user).toContain('backstop');
    expect(user).toContain('vendor-neutral');
    expect(user).toContain('exhibit type');

    const audienceIndex = user.indexOf('Audience: the CLIENT');
    const conventionsIndex = user.indexOf('# Amendment strategy conventions');
    const sectionsIndex = user.indexOf('Requested sections');
    expect(audienceIndex).toBeGreaterThanOrEqual(0);
    expect(conventionsIndex).toBeGreaterThan(audienceIndex);
    expect(sectionsIndex).toBeGreaterThan(conventionsIndex);
  });

  it('also triggers on the display label api-strategy sends ("Amendment ask")', () => {
    const { user } = composeReportNarrativePrompt(input('Amendment ask'));
    expect(user).toContain('# Amendment strategy conventions');
    expect(user).toContain('Report: Program Acceleration Ask (Amendment ask) for Northstar Systems');
  });

  it('keeps every other type byte-identical to the pre-amendment composition', () => {
    for (const type of ['Appropriations', 'Authorization', 'Regulatory / policy', 'Coalition / positioning', 'Contract / procurement', 'Grant / earmark', 'appropriations', 'Strategy']) {
      const request = input(type);
      const { system, user } = composeReportNarrativePrompt(request);
      expect(system).toBe(REPORT_NARRATIVE_SYSTEM_BASE);
      expect(user).not.toContain('Amendment strategy conventions');
      expect(user).toBe(
        [
          `Report: Program Acceleration Ask (${type}) for Northstar Systems, plan as of Aug 30, 2026.`,
          'Audience: the CLIENT’s leadership. The packet has already been filtered to client-safe material; write as a polished client deliverable.',
          '',
          'Requested sections (at most 3 paragraphs each; omit a section the evidence cannot support):',
          '- executive_summary: The opening brief a senior executive reads first: what the strategy is for, where it stands today (readiness, timing), and what leadership is being asked to do. Two or three paragraphs.',
          '- objectives_and_ask: The objective, what success looks like, and the primary ask or options on the table. One or two paragraphs.',
          '',
          '# Evidence packet',
          '[plan:strategy] Strategy title: Program Acceleration Ask.',
          '[ctx:target:1] FY2027 request for the line is $184.2M (Exhibit P-1).',
          '',
          `Call the ${PROPOSE_REPORT_NARRATIVE_TOOL.name} tool with the narrative.`,
        ].join('\n'),
      );
    }
  });

  it('the amendment prompt is the non-amendment prompt plus the conventions block only', () => {
    const plain = composeReportNarrativePrompt(input('Appropriations')).user.replace(
      '(Appropriations)',
      '(amendment)',
    );
    const amendment = composeReportNarrativePrompt(input('amendment')).user;
    expect(amendment).toBe(
      plain.replace(
        'write as a polished client deliverable.\n',
        `write as a polished client deliverable.\n\n${AMENDMENT_REPORT_CONVENTIONS}\n`,
      ),
    );
  });

  it('works for the internal audience too', () => {
    const { user } = composeReportNarrativePrompt(input('amendment', { audience: 'internal' }));
    expect(user).toContain('Audience: Capiro’s INTERNAL team.');
    expect(user).toContain('# Amendment strategy conventions');
  });
});

describe('isAmendmentStrategyType', () => {
  it('matches the raw enum value and the display label, case-insensitively', () => {
    expect(isAmendmentStrategyType('amendment')).toBe(true);
    expect(isAmendmentStrategyType('Amendment ask')).toBe(true);
    expect(isAmendmentStrategyType('  AMENDMENT  ')).toBe(true);
  });

  it('does not match other types, prefixes of other words, or missing values', () => {
    for (const type of ['appropriations', 'Authorization', 'amendments-adjacent', 'Amendmentx', 'Strategy', '', null, undefined]) {
      expect(isAmendmentStrategyType(type)).toBe(false);
    }
  });
});
