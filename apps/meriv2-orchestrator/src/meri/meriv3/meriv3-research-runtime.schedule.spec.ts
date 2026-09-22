import { MeriV3ResearchRuntimeStore } from './meriv3-research-runtime.store.js';

const AS_OF = '2026-09-10T12:00:00.000Z';
const result = {
  data: [{
    title: 'DIU',
    deadline: { at: '2026-11-15T04:59:59.999Z', dateOnly: '2026-11-14', timeZone: 'America/New_York', daysRemaining: 65, status: 'open' },
  }],
};
const config = (scheduleMode: 'off' | 'shadow' | 'enforce') => ({
  forcedFirstTool: 'research_federal_market_strategy', criticInstructions: 'critic',
  synthesisInstructions: 'legacy synthesis', scheduleMode, asOf: AS_OF,
});
const block = 'Schedule constraints (computed): today=2026-09-10 UTC; DIU: deadline 2026-11-15T04:59:59.999Z America/New_York, 65 days remaining, status open; suggested dates: Capture plan complete 2026-10-25, Compliance review 2026-11-01, Draft complete 2026-11-05, Final review 2026-11-10; every proposed milestone must fall on or before its deadline; deadlines already passed cannot be planned against — say so and propose the next actionable step.';

describe('research runtime schedule wiring', () => {
  afterEach(() => jest.restoreAllMocks());

  test('off keeps the legacy prompt byte-identical, ignores tool deadlines, and logs nothing', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    MeriV3ResearchRuntimeStore.run(config('off'), () => {
      MeriV3ResearchRuntimeStore.observeToolResult(result);
      expect(MeriV3ResearchRuntimeStore.beginFinalization()?.synthesisInstructions).toBe('legacy synthesis');
      expect(MeriV3ResearchRuntimeStore.validateDraft('# Timeline\n- Submit — Nov 20, 2026')).toEqual({
        text: '# Timeline\n- Submit — Nov 20, 2026', issueCount: 0,
      });
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test('shadow keeps the prompt identical and logs one stable event', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    MeriV3ResearchRuntimeStore.run(config('shadow'), () => {
      MeriV3ResearchRuntimeStore.observeToolResult(result);
      expect(MeriV3ResearchRuntimeStore.beginFinalization()?.synthesisInstructions).toBe('legacy synthesis');
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ event: 'meri.evidence_accuracy.shadow', scheduleConstraints: block });
  });

  test('enforce injects exact constraints and appends a deterministic correction', () => {
    MeriV3ResearchRuntimeStore.run(config('enforce'), () => {
      MeriV3ResearchRuntimeStore.observeToolResult(result);
      expect(MeriV3ResearchRuntimeStore.beginFinalization()?.synthesisInstructions).toBe(`legacy synthesis\n\n${block}`);
      expect(MeriV3ResearchRuntimeStore.validateDraft('# Timeline\n- Submit — Nov 20, 2026')).toEqual({
        text: "# Timeline\n- Submit — Nov 20, 2026\n\nCorrection: 'Submit — Nov 20, 2026' falls after the DIU deadline of 2026-11-14 (America/New_York); the feasible submission date is on or before 2026-11-14.",
        issueCount: 1,
      });
    });
  });
});