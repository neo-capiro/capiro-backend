import { classifyApiToolReadOutcome } from '@capiro/shared/meri-read-outcome';
import {
  currentOwnerResultAuthorizesReplay,
  supportsDurableOwnerReauthorization,
} from './meri-research-replay-authorization';
import { publicResearchSourceTool } from './meri-report-provenance';
import { researchProducerInputCoverableTool } from './meri-research-producer-inputs';

const TOOLS = ['get_program_element', 'get_pe_budget_timeline', 'get_pe_report_language'] as const;

function programElement(fy27 = 288.3, watching = false) {
  return {
    tool: 'get_program_element',
    generatedAt: new Date().toISOString(),
    peCode: '0605231A',
    currentCycleFy: 2027,
    programElement: {
      peCode: '0605231A',
      title: 'Precision Strike Missile',
      currentUserIsWatching: watching,
      years: [{ fy: 2027, request: fy27 }],
    },
  };
}

function timeline(years: unknown[] = [{ fy: 2027, request: 288.3 }]) {
  return { tool: 'get_pe_budget_timeline', generatedAt: new Date().toISOString(), peCode: '0605231A', years };
}

function reportLanguage(provisions: unknown[] = [{ id: 'p1', text: 'HAC-D notes' }]) {
  return {
    tool: 'get_pe_report_language',
    generatedAt: new Date().toISOString(),
    peCode: '0605231A',
    provisions,
    note: 'coverage note',
  };
}

describe('program-element reads as durable research sources', () => {
  it('are receipted, replayable public research sources that research may admit', () => {
    for (const tool of TOOLS) {
      expect(publicResearchSourceTool(tool)).toBe(tool);
      expect(supportsDurableOwnerReauthorization(tool)).toBe(true);
      expect(researchProducerInputCoverableTool(tool)).toBe(true);
    }
  });

  it('classifies complete, empty, owner-error and malformed reads', () => {
    expect(classifyApiToolReadOutcome('get_program_element', programElement())).toEqual({ kind: 'complete' });
    expect(classifyApiToolReadOutcome('get_pe_budget_timeline', timeline())).toEqual({ kind: 'complete' });
    expect(classifyApiToolReadOutcome('get_pe_budget_timeline', timeline([]))).toEqual({ kind: 'empty' });
    expect(classifyApiToolReadOutcome('get_pe_report_language', reportLanguage())).toEqual({ kind: 'complete' });
    expect(classifyApiToolReadOutcome('get_pe_report_language', reportLanguage([]))).toEqual({ kind: 'empty' });
    for (const tool of TOOLS) {
      expect(classifyApiToolReadOutcome(tool, { error: 'Program element not found' })?.kind).toBe('failed');
      expect(classifyApiToolReadOutcome(tool, { tool })?.kind).toBe('failed');
    }
    expect(
      classifyApiToolReadOutcome('get_program_element', { ...programElement(), tool: 'get_pe_bills' })?.kind,
    ).toBe('failed');
  });

  it('replays only while the budget evidence is unchanged, ignoring the reader watch flag', () => {
    expect(
      currentOwnerResultAuthorizesReplay('get_program_element', programElement(), programElement(288.3, true)),
    ).toBe(true);
    expect(
      currentOwnerResultAuthorizesReplay('get_program_element', programElement(), programElement(300)),
    ).toBe(false);
    expect(currentOwnerResultAuthorizesReplay('get_pe_budget_timeline', timeline(), timeline())).toBe(true);
    expect(
      currentOwnerResultAuthorizesReplay('get_pe_budget_timeline', timeline(), timeline([{ fy: 2027, request: 1 }])),
    ).toBe(false);
    expect(currentOwnerResultAuthorizesReplay('get_pe_report_language', reportLanguage(), reportLanguage())).toBe(true);
    expect(
      currentOwnerResultAuthorizesReplay('get_pe_report_language', reportLanguage(), reportLanguage([])),
    ).toBe(false);
  });
});
