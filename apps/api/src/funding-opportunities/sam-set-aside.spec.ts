import { samSetAsideDescription, samSetAsideRestrictsToSmallBusiness } from './sam-set-aside.js';

describe('SAM.gov set-aside codes', () => {
  test('decodes a total small business set-aside, case-insensitively', () => {
    expect(samSetAsideDescription('SBA')).toBe('Total Small Business Set-Aside (FAR 19.5)');
    expect(samSetAsideDescription(' sba ')).toBe('Total Small Business Set-Aside (FAR 19.5)');
    expect(samSetAsideRestrictsToSmallBusiness('SBA')).toBe(true);
  });

  test('unknown or missing codes are not guessed', () => {
    expect(samSetAsideDescription('NONE')).toBeNull();
    expect(samSetAsideDescription(null)).toBeNull();
    expect(samSetAsideRestrictsToSmallBusiness('NONE')).toBe(false);
  });

  test('a local area set-aside is not a small-business restriction', () => {
    expect(samSetAsideDescription('LAS')).toBe('Local Area Set-Aside (FAR 26.2)');
    expect(samSetAsideRestrictsToSmallBusiness('LAS')).toBe(false);
  });
});
