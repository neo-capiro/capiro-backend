import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFloridaCitation } from '@capiro/shared';
import {
  parseFlFarNoticeDetail,
  parseFlRuleHistory,
  toStateRuleInput,
  parseMdyDate,
  classifyFlNotice,
} from './fl-far.client.js';
import { parseFloridaStatutes } from './fl-statutes.client.js';
import { parseFloridaConstitution } from './fl-constitution.client.js';
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'phase7', name), 'utf8');
describe('Phase 7 actual publisher samples', () => {
  test('constitution is an observed publisher snapshot, not the bill session edition', () => {
    const result = parseFloridaConstitution(fixture('constitution.html'), 'I');
    expect(result.reference).toMatchObject({ code: 'constitution', kind: 'article', chapter: 'I' });
    expect(result.edition).toBeNull();
    expect(result.sections[0]!.locator).toBe('article:I:section:1');
    expect(result.sections[0]!.text).toContain('All political power is inherent in the people');
  });
  test('proposal 30565687 retains seven independent rule links and explicit comment dates', () => {
    const notice = parseFlFarNoticeDetail(fixture('notice-30565687.html'), '30565687');
    expect(notice.rules.map((r) => r.number)).toEqual([
      '1-1.008',
      '1-1.009',
      '1-1.010',
      '1-1.011',
      '1-1.012',
      '1-1.013',
      '1-1.014',
    ]);
    expect(notice.commentStartDate).toBe('2026-03-12');
    expect(notice.commentEndDate).toBe('2026-04-02');
    expect(toStateRuleInput(notice)?.linkedRuleNumbers).toHaveLength(7);
    expect(notice.effectiveDate).toBeNull();
  });
  test('adopted record without publication date retains filing/effective dates', () => {
    const notice = parseFlFarNoticeDetail(fixture('notice-31220534.html'), '31220534'),
      input = toStateRuleInput(notice);
    expect(input).not.toBeNull();
    expect(input).toMatchObject({
      id: 'FL-31220534',
      publicationDate: null,
      filingDate: '2026-08-04',
      effectiveDate: '2026-08-24',
      ruleType: 'final',
    });
  });
  test('history follows actual publisher document link', () => {
    const history = parseFlRuleHistory(fixture('rule-1-1.008.html'), '1-1.008');
    expect(
      history.attachments.some((a) =>
        a.url.includes('readFile.asp?sid=0&tid=31220534&type=1&file=1-1.008.doc'),
      ),
    ).toBe(true);
    expect(history.notices.rows.some((r) => r.noticeId === '30565687')).toBe(true);
  });
  test('unknown type stays unknown and impossible dates reject', () => {
    expect(classifyFlNotice('Notice of Something New')).toBe('unknown');
    expect(classifyFlNotice('Notice of Withdrawal')).toBe('withdrawal');
    expect(parseMdyDate('2/30/2026')).toBeNull();
    expect(parseMdyDate('2/29/2024')).toBe('2024-02-29');
  });
  test('official section keeps exact edition, history and paragraph locators', () => {
    const result = parseFloridaStatutes(
      fixture('statute-2026-395.003.html'),
      'https://www.flsenate.gov/Laws/Statutes/2026/395.003',
      '2026',
      parseFloridaCitation('395.003')!,
    );
    expect(result.revisions).toHaveLength(1);
    expect(result.revisions[0]!.sections.length).toBeGreaterThan(2);
    expect(result.revisions[0]!.historyText).toContain('82-182');
  });
  test('redirected section is unavailable, not an empty successful statute', () => {
    expect(() =>
      parseFloridaStatutes(
        '<html>index</html>',
        'https://www.flsenate.gov/Laws/Statutes/2026',
        '2026',
        parseFloridaCitation('409.9112')!,
      ),
    ).toThrow('IDENTITY_MISMATCH');
  });
});
