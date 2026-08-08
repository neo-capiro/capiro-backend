import { classifyMeriV3VisualIntent, meriV3VisualIntentPrompt } from './meriv3-visual-intent.js';

describe('MeriV3 visual-intent steering', () => {
  test.each([
    'Chart FY24 through FY27 funding for this Program Element.',
    'Build a waterfall from request to HASC, SASC, HAC-D and enacted.',
    'Visualize our client exposure as a heatmap.',
    'Plot award size against PE growth.',
  ])('treats an explicit visual request as explicit: %s', (request) => {
    expect(classifyMeriV3VisualIntent(request).level).toBe('explicit');
  });

  test.each([
    'Compare House and Senate marks across the client portfolio.',
    'Which Program Elements had the largest year-over-year cuts?',
    'Show the funding trajectory across fiscal years.',
    'Identify outliers in lobbying spending by issue.',
    'What is the correlation between awards and budget growth?',
  ])('recommends analysis for a multi-row quantitative pattern: %s', (request) => {
    expect(classifyMeriV3VisualIntent(request).level).toBe('recommended');
  });

  test.each([
    'What is the current status of H.R. 1234?',
    'Rewrite this sentence more professionally.',
    'Draft an email thanking the client.',
    'What is two plus two?',
    'Summarize the hearing testimony.',
  ])('does not encourage a decorative chart: %s', (request) => {
    expect(classifyMeriV3VisualIntent(request).level).toBe('not_needed');
  });

  test('explicit intent wins over writing language when the user actually asks for a graph', () => {
    expect(
      classifyMeriV3VisualIntent(
        'Draft a short client note and include a chart of funding over time',
      ).level,
    ).toBe('explicit');
  });

  test('prompts preserve evidence discipline at every level', () => {
    const explicit = meriV3VisualIntentPrompt({ level: 'explicit', reason: 'requested' });
    const recommended = meriV3VisualIntentPrompt({ level: 'recommended', reason: 'comparison' });
    const none = meriV3VisualIntentPrompt({ level: 'not_needed', reason: 'single fact' });
    expect(explicit).toContain('source-backed numeric rows');
    expect(explicit).toContain('do not fabricate');
    expect(recommended).toContain('do not create decorative charts');
    expect(none).toContain('Do not call run_analysis merely to decorate');
  });
});
