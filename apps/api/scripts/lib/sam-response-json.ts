/** Retain numeric action-obligation tokens before IEEE-754 parsing can erase source cents.
 * The tag distinguishes a wire JSON number from a wire string in stored payload/hash evidence.
 * No provider object is allowed to impersonate this adapter-owned representation.
 */
export function assertLosslessSamJsonSupport(): void {
  let lexeme: unknown;
  JSON.parse('0', (_key: string, value: unknown, context?: { source?: string }) => {
    lexeme = context?.source; return value;
  });
  if (lexeme !== '0') throw new Error('lossless JSON numeric source support required');
}

export function parseSamResponseJson(text: string): unknown {
  assertLosslessSamJsonSupport();
  return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (key === '$samDecimalLexeme') throw new Error('reserved adapter decimal tag in provider JSON');
    if (key !== 'actionObligation') return value;
    if (typeof value === 'number') {
      if (typeof context?.source !== 'string') throw new Error('lossless JSON numeric source support required');
      return { $samDecimalLexeme: context.source };
    }
    if (value !== null && typeof value === 'object') throw new Error('unsupported source obligation representation');
    return value;
  });
}
