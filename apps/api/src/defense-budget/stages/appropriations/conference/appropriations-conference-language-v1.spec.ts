import { composeAppropriationsLanguageActionsV1 } from '../actions/appropriations-language-actions-v1.js';
import { verifyAppropriationsActionsV1 } from '../actions/appropriations-action-verifier-v1.js';

const SHA = 'a'.repeat(64);

describe('Phase 6 Workstream K conference language through Workstream J', () => {
  it('uses the shared J action contract for conference directives without creating a funding position', () => {
    const result = composeAppropriationsLanguageActionsV1({
      stage: 'appropriations_conference',
      sourceDocumentId: 'conference-jes',
      sourceSha256: SHA,
      fiscalYear: 2027,
      text: 'The conferees direct the Secretary to submit a report to Congress.',
      evidenceIds: ['e1'],
      packageScope: 'DIVISION A — TITLE IV',
    });
    expect(result.actions.map((action) => action.actionType)).toContain('reporting_requirement');
    expect(result.actions.every((action) => action.stage === 'appropriations_conference')).toBe(true);
    expect(result.actions.every((action) => action.vehicleClass === 'conference_report')).toBe(true);
    expect(
      verifyAppropriationsActionsV1({ actions: result.actions, languageFacts: [result.languageFact] }).status,
    ).toBe('PASS');
    expect(JSON.stringify(result)).not.toMatch(/"field":"conference"/);
  });
});
