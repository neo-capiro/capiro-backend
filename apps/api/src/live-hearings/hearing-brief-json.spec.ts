import { parseHearingBriefJson } from './hearing-brief-json.js';

describe('hearing brief JSON prose encoding', () => {
  it('preserves literal Markdown line breaks and tabs without changing the content', () => {
    const content = 'A supported statement [0:10].\n\n- First point\r\n\tSecond point';
    const raw = '{"sections":[{"content":"' + content + '"}]}';
    expect(parseHearingBriefJson(raw)).toEqual({ sections: [{ content }] });
  });

  it('preserves valid escaped quotes, backslashes, Unicode and fenced JSON', () => {
    const value = { title: '“Golden Dome”', content: 'He said "yes".\nC:\\evidence\\note' };
    expect(parseHearingBriefJson('```json\n' + JSON.stringify(value) + '\n```')).toEqual(value);
  });

  it.each([
    '{"content":"unfinished',
    '{"content":"a" "missing separator"}',
    '{"content":"unescaped "quote""}',
    '{"content":"invalid\\q"}',
    '{"content":"invalid\\\ncontinuation"}',
    '{\u0001"content":"outside string"}',
    'No usable object',
  ])('rejects structurally invalid or incomplete output: %s', text => {
    expect(() => parseHearingBriefJson(text)).toThrow();
  });
});
