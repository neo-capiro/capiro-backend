import { normalizeBillStage } from './bill-stage.js';

describe('normalizeBillStage — real Congress.gov action texts', () => {
  test('lifecycle ladder classifies each real action text', () => {
    const cases: Array<[string, string]> = [
      ['Introduced in House', 'introduced'],
      ['Referred to the Committee on Armed Services.', 'referred'],
      ['Committee on Armed Services. Ordered to be Reported (Amended) by the Yeas and Nays: 57 - 1.', 'markup'],
      ['Subcommittee Hearings and Markup Held', 'markup'],
      ['Reported (Amended) by the Committee on Armed Services. H. Rept. 118-125.', 'reported'],
      ['Passed/agreed to in House: On passage Passed by recorded vote: 217 - 199.', 'passed_house'],
      ['Passed Senate with an amendment by Yea-Nay Vote. 86 - 11.', 'passed_senate'],
      ['Conference report H. Rept. 118-301 filed.', 'conference'],
      ['Presented to President.', 'to_president'],
      ['Became Public Law No: 118-31.', 'enacted'],
    ];
    for (const [text, want] of cases) {
      expect(normalizeBillStage(text).stage).toBe(want);
    }
  });

  test('later-stage wording wins over earlier mentions in the same text', () => {
    // "conference report ... agreed to" is conference-stage, not floor passage.
    expect(normalizeBillStage('Conference report agreed to in House.').stage).toBe('conference');
    // "Became law" beats the "passed" it also contains.
    expect(
      normalizeBillStage('Passed both chambers and became public law.').stage,
    ).toBe('enacted');
  });

  test('chamber parameter disambiguates bare passage text', () => {
    expect(normalizeBillStage('Passed/agreed to.', 'Floor', 'Senate').stage).toBe('passed_senate');
    expect(normalizeBillStage('Agreed to by voice vote.', 'Floor', 'House').stage).toBe('passed_house');
  });

  test('action type is a fallback when text is uninformative', () => {
    expect(normalizeBillStage('Some procedural note.', 'IntroReferral').stage).toBe('referred');
    expect(normalizeBillStage('', 'BecameLaw').stage).toBe('enacted');
  });

  test('unrecognized actions land on other — never guessed into a stage', () => {
    const r = normalizeBillStage('Motion to reconsider laid on the table.');
    expect(r.stage).toBe('other');
    expect(r.rank).toBe(-1);
  });

  test('every result carries a render-safe label and rank', () => {
    const r = normalizeBillStage('Became Public Law No: 119-99.');
    expect(r.label).toBe('Became law');
    expect(r.rank).toBe(8);
  });
});
