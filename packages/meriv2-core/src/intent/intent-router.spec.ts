import { KeywordIntentRouter } from './intent-router';

describe('KeywordIntentRouter', () => {
  const r = new KeywordIntentRouter();

  it('routes writing intents', () => {
    expect(r.classify('Draft a memo on the NDAA').mode).toBe('writing');
  });

  it('routes monitoring intents', () => {
    expect(r.classify('Alert me when the bill text changes').mode).toBe('monitoring');
  });

  it('routes analytics intents', () => {
    expect(r.classify('Forecast the budget line and rank options').mode).toBe('analytics');
  });

  it('routes compliance intents', () => {
    expect(r.classify('Run an LDA compliance precheck').mode).toBe('compliance');
  });

  it('defaults to research with zero confidence when nothing matches', () => {
    const out = r.classify('zzzqqq');
    expect(out.mode).toBe('research');
    expect(out.confidence).toBe(0);
    expect(out.signals).toEqual([]);
  });

  it('is deterministic', () => {
    expect(r.classify('search for hearings')).toEqual(r.classify('search for hearings'));
  });

  it('returns matched signals and scales confidence', () => {
    const out = r.classify('draft and edit the memo');
    expect(out.signals).toEqual(expect.arrayContaining(['draft', 'edit', 'memo']));
    expect(out.confidence).toBeGreaterThan(0.5);
  });
});
