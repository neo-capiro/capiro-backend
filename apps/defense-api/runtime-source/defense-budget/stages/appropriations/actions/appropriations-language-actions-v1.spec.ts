import { verifyAppropriationsActionsV1 } from './appropriations-action-verifier-v1.js';
import {
  classifyAppropriationsLanguageActionTypesV1,
  composeAppropriationsLanguageActionsV1,
} from './appropriations-language-actions-v1.js';

const SHA = 'a'.repeat(64);
function compose(text: string) {
  return composeAppropriationsLanguageActionsV1({
    stage: 'hac_d',
    sourceDocumentId: 'hacd-doc',
    sourceSha256: SHA,
    fiscalYear: 2027,
    text,
    evidenceIds: ['e1'],
    packageScope: 'TITLE II',
  });
}

describe('Phase 6 Workstream J appropriations language actions', () => {
  it('classifies restrictions', () => {
    expect(classifyAppropriationsLanguageActionTypesV1('None of the funds may be obligated for X.')).toContain('restriction');
  });

  it('classifies directives', () => {
    expect(classifyAppropriationsLanguageActionTypesV1('The Committee directs the Secretary to provide a briefing.')).toContain('directive');
  });

  it('classifies reporting requirements', () => {
    expect(classifyAppropriationsLanguageActionTypesV1('The Secretary shall submit a report to Congress.')).toContain('reporting_requirement');
  });

  it('classifies general provisions', () => {
    expect(classifyAppropriationsLanguageActionTypesV1('General provision regarding transfer authority.')).toContain('general_provision');
  });

  it('preserves uncategorized narrative as other rather than dropping it', () => {
    expect(classifyAppropriationsLanguageActionTypesV1('The Committee notes the importance of testing.')).toEqual(['other']);
  });

  it('creates one citable action per explicit language type with shared evidence', () => {
    const result = compose('The Committee directs the Secretary to submit a report to Congress.');
    expect(result.actions.map((action) => action.actionType).sort()).toEqual(['directive', 'reporting_requirement']);
    expect(
      verifyAppropriationsActionsV1({ actions: result.actions, languageFacts: [result.languageFact] }).status,
    ).toBe('PASS');
    expect(result.actions.every((action) => action.evidenceIds.includes('e1'))).toBe(true);
  });

  it('rejects language without an explicit source scope', () => {
    expect(() =>
      composeAppropriationsLanguageActionsV1({
        stage: 'sac_d',
        sourceDocumentId: 'doc',
        sourceSha256: SHA,
        fiscalYear: 2027,
        text: 'The Committee directs the Secretary to provide a briefing.',
        evidenceIds: ['e1'],
      }),
    ).toThrow(/exactly one source scope/);
  });
});
